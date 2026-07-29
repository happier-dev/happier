function hasUnsupportedOwnProperty(value: object, arrayValue: boolean): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor)) return true;
    if (!arrayValue) {
      if (!descriptor.enumerable) return true;
      continue;
    }
    if (key === 'length') continue;
    const index = Number(key);
    if (!descriptor.enumerable
      || !Number.isInteger(index)
      || index < 0
      || String(index) !== key
      || index >= (value as readonly unknown[]).length) {
      return true;
    }
  }
  return Object.getOwnPropertySymbols(value).length > 0;
}

function isPlainJsonObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function readOwnDataValue(value: object, key: string): unknown | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * Compares strict JSON values without consulting prototypes or invoking accessors.
 * JSON numbers are finite and treat -0 and 0 as the same mathematical value.
 */
export function pluginJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' || typeof right === 'number') {
    return typeof left === 'number'
      && typeof right === 'number'
      && Number.isFinite(left)
      && Number.isFinite(right)
      && left === right;
  }
  if (left === null || right === null || typeof left === 'boolean' || typeof right === 'boolean'
    || typeof left === 'string' || typeof right === 'string') {
    return left === right;
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  try {
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      if (hasUnsupportedOwnProperty(left, true) || hasUnsupportedOwnProperty(right, true)) return false;
      for (let index = 0; index < left.length; index += 1) {
        const key = String(index);
        if (!Object.prototype.hasOwnProperty.call(left, key) || !Object.prototype.hasOwnProperty.call(right, key)) return false;
        if (!pluginJsonValuesEqual(readOwnDataValue(left, key), readOwnDataValue(right, key))) return false;
      }
      return true;
    }

    if (!isPlainJsonObject(left) || !isPlainJsonObject(right)) return false;
    if (hasUnsupportedOwnProperty(left, false) || hasUnsupportedOwnProperty(right, false)) return false;

    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      if (!pluginJsonValuesEqual(readOwnDataValue(left, key), readOwnDataValue(right, key))) return false;
    }
    return true;
  } catch {
    // Proxies and exotic objects are not strict JSON values. Fail closed without
    // leaking host exceptions through author-controlled schema evaluation.
    return false;
  }
}

export function containsEquivalentPluginJsonValue(
  values: readonly unknown[],
  candidate: unknown,
): boolean {
  return values.some((value) => pluginJsonValuesEqual(value, candidate));
}
