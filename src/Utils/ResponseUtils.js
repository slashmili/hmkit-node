/*
 *  The MIT License
 * 
 *  Copyright (c) 2014- High-Mobility GmbH (https://high-mobility.com)
 * 
 *  Permission is hereby granted, free of charge, to any person obtaining a copy
 *  of this software and associated documentation files (the "Software"), to deal
 *  in the Software without restriction, including without limitation the rights
 *  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *  copies of the Software, and to permit persons to whom the Software is
 *  furnished to do so, subject to the following conditions:
 * 
 *  The above copyright notice and this permission notice shall be included in
 *  all copies or substantial portions of the Software.
 * 
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 *  THE SOFTWARE.
 * 
 *  ResponseUtils.js
 * 
 *  Created by Mikk Õun on 16/01/2020.
 */

import capabilitiesConfiguration from '../Configuration/capabilities.json';
import PropertyType from '../Configuration/PropertyType';
import { capitalize } from './Helpers';
import ResponseClass from '../Configuration/ResponseClass';
import mergeWith from 'lodash/mergeWith';

import {
  PROPERTY_DATA_ID,
  PROPERTY_TIMESTAMP_ID,
  PROPERTY_FAILURE_ID,
  bytesSum,
  bytesToString,
  ieee754DoubleToBase10,
  ieee754ToBase10,
  bytesToTimestamp,
} from './EncodingUtils';

export function parseData(data: Array<Number>) {
  const [
    autoApiLevel,
    capabilityMsb,
    capabilityLsb,
    messageType,
    ...propertiesData
  ] = data;

  const capabilityConf = Object.values(capabilitiesConfiguration).find(
    ({ identifier: { msb, lsb } = {} }) =>
      capabilityMsb === msb && capabilityLsb === lsb
  );

  if (capabilityConf) {
    const parsedData = parseProperties(propertiesData, capabilityConf);
    const responseClassName = capitalize(capabilityConf.name_cased);
    const responseClass = new ResponseClass[responseClassName]();

    mergeWith(responseClass, parsedData, mergeCustomiser);

    applyResponseMetaData(responseClass, {
      autoApiLevel,
      lsb: capabilityLsb,
      msb: capabilityMsb,
    });

    return responseClass;
  }

  throw new Error('No configuration found for capability');
}

function applyResponseMetaData(responseClass, metaData) {
  Object.entries(metaData).forEach(([key, value]) => {
    Object.defineProperty(responseClass, key, { value });
  });

  return responseClass;
}

function mergeCustomiser(objValue, srcValue) {
  if (Array.isArray(objValue)) {
    return objValue.concat(srcValue);
  }

  return srcValue;
}

function parseProperties(propertiesData, capabilityConf) {
  const { properties } = capabilityConf;

  const parsedProperties = {};

  if (propertiesData.length > 0) {
    let counter = 0;

    while (counter < propertiesData.length) {
      const identifier = propertiesData[counter];
      const propertyComponentsLength = bytesSum(
        propertiesData.slice(counter + 1, counter + 3)
      );

      const propertyComponentsData = propertiesData.slice(
        counter + 3,
        counter + 3 + propertyComponentsLength
      );

      const property = properties.find(prop => prop.id === identifier);

      if (!!property) {
        const parsedProperty = parseProperty(propertyComponentsData, property);

        if (parsedProperty !== undefined) {
          const namespace = property.name_cased;

          if (property.multiple) {
            (parsedProperties[namespace] = parsedProperties[namespace]
              ? parsedProperties[namespace]
              : []).push(parsedProperty);
          } else {
            parsedProperties[namespace] = parsedProperty;
          }
        }
      }

      counter += 3 + propertyComponentsLength;
    }
  }

  return parsedProperties;
}

function parseProperty(propertyData, property) {
  const { data, time, error } = parsePropertyComponents(propertyData);

  const parsedTimestamp = time ? { timestamp: bytesToTimestamp(time) } : {};

  return {
    value: parsePropertyData(data, property),
    ...parsedTimestamp,
  };
}

export function parsePropertyData(data, property) {
  switch (property.type) {
    case PropertyType.STRING: {
      return bytesToString(data);
    }

    case PropertyType.CUSTOM: {
      return decodeCustomProperty(data, property);
    }

    case PropertyType.UINTEGER: {
      return bytesSum(data);
    }

    case PropertyType.LIST_UINTEGER: {
      return data;
    }

    case PropertyType.DOUBLE: {
      const double = ieee754DoubleToBase10(data, property.size);
      return Number(parseFloat(double).toPrecision(15));
    }

    case PropertyType.FLOAT: {
      const float = ieee754ToBase10(data, property.size);
      return Number(parseFloat(float).toPrecision(7));
    }

    case PropertyType.ENUM: {
      return decodeEnumProperty(data, property);
    }

    case PropertyType.TIMESTAMP: {
      return bytesToTimestamp(data);
    }

    case PropertyType.INTEGER: {
      return bytesSum(data);
    }

    case PropertyType.BYTES: {
      switch (property.customType) {
        case 'capability_state': {
          const responseClass = parseData(data);
          const capability = findCapabilityNameByIdentifier(
            responseClass.msb,
            responseClass.lsb
          );

          if (capability) {
            return {
              [capability.name_cased]: responseClass,
            };
          }

          return responseClass;
        }

        case 'supported_capability': {
          return data;
        }

        default: {
          return [...data];
        }
      }
    }
  }

  return {};
}

function findCapabilityNameByIdentifier(msb, lsb) {
  return Object.values(capabilitiesConfiguration).find(
    ({ identifier = {} }) => identifier.msb === msb && identifier.lsb === lsb
  );
}

function decodeCustomProperty(data, property) {
  if (property.size && property.items) {
    return decodeFixedLengthProperty(data, property);
  } else if (property.items) {
    return decodeCustomLengthProperty(data, property);
  }

  throw new Error('Found some cancer', data, property);
}

function decodeFixedLengthProperty(data, property) {
  const estimatedSize = property.items.reduce((sum, item) => {
    // TODO: This happens on invalid conf. Could be removed if spec is locked.
    if (!item.size) {
      throw new Error('Invalid configuration - no item size.');
    }

    return sum + (item.size || 0);
  }, 0);

  if (property.size === estimatedSize) {
    if (data.length !== estimatedSize) {
      console.log(
        'Insufficent data length',
        data,
        estimatedSize,
        property.size,
        property
      );
      throw new Error('Insufficent data length', data);
    }

    let counter = 0;
    return property.items.reduce((parsedChildren, childProp) => {
      const dataToParse = data.slice(counter, counter + childProp.size);
      counter += childProp.size;

      return {
        ...parsedChildren,
        [childProp.name_cased]: parsePropertyData(dataToParse, childProp),
      };
    }, {});
  }

  throw new Error('Invalid estimated size', estimatedSize, property);
}

const CustomLengthPropertyTypes = [PropertyType.STRING, PropertyType.BYTES];

function decodeCustomLengthProperty(data, property) {
  let counter = 0;

  return property.items.reduce((parsedChildren, childProp) => {
    let dataToParse = [];

    if (childProp.size) {
      dataToParse = data.slice(counter, counter + childProp.size);
      counter += childProp.size;
    } else if (CustomLengthPropertyTypes.includes(childProp.type)) {
      const len = bytesSum(data.slice(counter, counter + 2));

      dataToParse = data.slice(counter + 2, counter + 2 + len);
      counter += len + 2;
    } else {
      dataToParse = data.slice(counter);
    }

    return {
      ...parsedChildren,
      [childProp.name_cased]: parsePropertyData(dataToParse, childProp),
    };
  }, {});
}

function decodeEnumProperty(data, property) {
  if (data.length === property.size && property.enum_values) {
    const identifier = bytesSum(data);
    const enumValue = property.enum_values.find(val => val.id === identifier);

    if (enumValue) {
      return enumValue.name;
    }
  }

  throw new Error('Failed to decode enum');
}

function parsePropertyComponents(propertyComponentsData) {
  let componentCounter = 0;
  const componentBytes = {};

  while (componentCounter < propertyComponentsData.length) {
    const componentIdentifier = propertyComponentsData[componentCounter];
    const propertyComponentLength = bytesSum(
      propertyComponentsData.slice(componentCounter + 1, componentCounter + 3)
    );

    const propertyComponentData = propertyComponentsData.slice(
      componentCounter + 3,
      componentCounter + 3 + propertyComponentLength
    );

    switch (componentIdentifier) {
      case PROPERTY_DATA_ID: {
        componentBytes.data = propertyComponentData;
        break;
      }
      case PROPERTY_TIMESTAMP_ID: {
        componentBytes.time = propertyComponentData;
        break;
      }
      case PROPERTY_FAILURE_ID: {
        componentBytes.error = propertyComponentData;
        break;
      }
      default:
        break;
    }

    componentCounter += 3 + propertyComponentLength;
  }

  return componentBytes;
}
