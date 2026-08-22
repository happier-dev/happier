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
  try {
    type ComparisonWorkItem =
      | Readonly<{ kind: 'compare'; left: unknown; right: unknown }>
      | Readonly<{ kind: 'finish'; left: object; right: object }>;

    const pending: ComparisonWorkItem[] = [{ kind: 'compare', left, right }];
    // These track only the current path, so shared acyclic JSON is still valid
    // while cyclic/exotic graphs fail closed instead of keeping this loop alive.
    const activeLeft = new WeakSet<object>();
    const activeRight = new WeakSet<object>();

    while (pending.length > 0) {
      const workItem = pending.pop()!;
      if (workItem.kind === 'finish') {
        activeLeft.delete(workItem.left);
        activeRight.delete(workItem.right);
        continue;
      }

      const { left: currentLeft, right: currentRight } = workItem;
      if (typeof currentLeft === 'number' || typeof currentRight === 'number') {
        if (typeof currentLeft !== 'number'
          || typeof currentRight !== 'number'
          || !Number.isFinite(currentLeft)
          || !Number.isFinite(currentRight)
          || currentLeft !== currentRight) {
          return false;
        }
        continue;
      }
      if (currentLeft === null || currentRight === null
        || typeof currentLeft === 'boolean' || typeof currentRight === 'boolean'
        || typeof currentLeft === 'string' || typeof currentRight === 'string') {
        if (currentLeft !== currentRight) return false;
        continue;
      }
      if (currentLeft === null || currentRight === null
        || typeof currentLeft !== 'object' || typeof currentRight !== 'object') {
        return false;
      }

      const leftIsArray = Array.isArray(currentLeft);
      const rightIsArray = Array.isArray(currentRight);
      if (leftIsArray || rightIsArray) {
        if (!leftIsArray || !rightIsArray || currentLeft.length !== currentRight.length) return false;
        if (hasUnsupportedOwnProperty(currentLeft, true)
          || hasUnsupportedOwnProperty(currentRight, true)
          || activeLeft.has(currentLeft)
          || activeRight.has(currentRight)) {
          return false;
        }

        activeLeft.add(currentLeft);
        activeRight.add(currentRight);
        pending.push({ kind: 'finish', left: currentLeft, right: currentRight });
        for (let index = currentLeft.length - 1; index >= 0; index -= 1) {
          const key = String(index);
          if (!Object.prototype.hasOwnProperty.call(currentLeft, key)
            || !Object.prototype.hasOwnProperty.call(currentRight, key)) {
            return false;
          }
          pending.push({
            kind: 'compare',
            left: readOwnDataValue(currentLeft, key),
            right: readOwnDataValue(currentRight, key),
          });
        }
        continue;
      }

      if (!isPlainJsonObject(currentLeft) || !isPlainJsonObject(currentRight)) return false;
      if (hasUnsupportedOwnProperty(currentLeft, false)
        || hasUnsupportedOwnProperty(currentRight, false)
        || activeLeft.has(currentLeft)
        || activeRight.has(currentRight)) {
        return false;
      }

      const leftKeys = Object.keys(currentLeft);
      const rightKeys = Object.keys(currentRight);
      if (leftKeys.length !== rightKeys.length) return false;

      activeLeft.add(currentLeft);
      activeRight.add(currentRight);
      pending.push({ kind: 'finish', left: currentLeft, right: currentRight });
      for (let index = leftKeys.length - 1; index >= 0; index -= 1) {
        const key = leftKeys[index]!;
        if (!Object.prototype.hasOwnProperty.call(currentRight, key)) return false;
        pending.push({
          kind: 'compare',
          left: readOwnDataValue(currentLeft, key),
          right: readOwnDataValue(currentRight, key),
        });
      }
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

/**
 * Stable comparison key for the JSON scalars that compare by value, so
 * uniqueness and enum membership can be decided without a pairwise structural
 * walk. Compound values return `undefined` and fall back to
 * `containsEquivalentPluginJsonValue`.
 */
export function scalarPluginJsonValueKey(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return `boolean:${value}`;
    case 'number':
      return Number.isFinite(value) ? `number:${String(value)}` : undefined;
    case 'string':
      return `string:${value}`;
    default:
      return undefined;
  }
}

/**
 * JSON Schema `uniqueItems`/`enum` uniqueness decided under this module's one
 * structural-equality rule. It belongs with that rule rather than with the AJV
 * compiler, so schema construction can enforce uniqueness without reaching a
 * validator-library graph.
 */
export function hasUniquePluginJsonValues(values: readonly unknown[]): boolean {
  const seenScalars = new Set<string>();
  const seenCompounds: unknown[] = [];
  for (const value of values) {
    const scalarKey = scalarPluginJsonValueKey(value);
    if (scalarKey !== undefined) {
      if (seenScalars.has(scalarKey)) return false;
      seenScalars.add(scalarKey);
      continue;
    }
    if (containsEquivalentPluginJsonValue(seenCompounds, value)) return false;
    seenCompounds.push(value);
  }
  return true;
}
