const textEncoder = new TextEncoder();

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const trailingCodeUnit = value.charCodeAt(index + 1);
      if (!(trailingCodeUnit >= 0xDC00 && trailingCodeUnit <= 0xDFFF)) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) return false;
  }
  return true;
}

function assertWellFormedUnicode(value: string, path: string): void {
  if (!isWellFormedUnicode(value)) {
    throw new Error(`${path} must contain well-formed Unicode`);
  }
}

/**
 * The one Protocol owner for UTF-8 byte measurement. Strict JSON data rejects
 * malformed UTF-16 rather than relying on platform replacement behavior.
 */
export function measurePluginJsonUtf8Bytes(value: string, path: string): number {
  assertWellFormedUnicode(value, path);
  return textEncoder.encode(value).byteLength;
}

/**
 * Copies ordinary JSON for Protocol-owned values. Complete-value byte ceilings
 * belong to the owning wire or transport boundary; this generic clone exposes
 * no node, depth, or member-count quota. The explicit work stack keeps valid
 * deep data off the JavaScript call stack while preserving strict
 * data/accessor/cycle rules.
 */
type StrictJsonWalkTask =
  | Readonly<{
    kind: 'visit';
    input: unknown;
    assign?: (value: unknown) => void;
  }>
  | Readonly<{
    kind: 'finish-array';
    input: object;
    output?: unknown[];
    assign?: (value: unknown) => void;
  }>
  | Readonly<{
    kind: 'finish-object';
    input: object;
    output?: Record<string, unknown>;
    assign?: (value: unknown) => void;
  }>;

function assertStrictJsonArrayDescriptors(
  input: object,
  path: string,
): Readonly<Record<string, PropertyDescriptor>> {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number') {
    throw new Error(`${path} must contain a dense JSON array`);
  }
  const length = lengthDescriptor.value;
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${path} must not contain holes or accessors`);
    }
  }
  if (keys.some((key) => typeof key === 'symbol'
    || (key !== 'length' && (!/^\d+$/u.test(key) || String(Number(key)) !== key || Number(key) >= length)))) {
    throw new Error(`${path} must not contain extra array properties`);
  }
  return descriptors;
}

function strictJsonArrayLength(descriptors: Readonly<Record<string, PropertyDescriptor>>): number {
  const length = descriptors.length;
  if (!length || !('value' in length) || typeof length.value !== 'number') {
    throw new Error('Strict JSON array descriptors lost their length');
  }
  return length.value;
}

function strictJsonObjectKeys(input: object, path: string): readonly string[] {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain objects`);
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new Error(`${path} must not contain symbol keys`);
  }
  return keys as readonly string[];
}

function walkStrictPluginJsonValue(
  value: unknown,
  path: string,
  copiesValue: boolean,
): unknown {
  let root: unknown;
  const ancestors = new WeakSet<object>();
  const rootAssign = copiesValue
    ? (cloned: unknown) => {
      root = cloned;
    }
    : undefined;
  const tasks: StrictJsonWalkTask[] = [{
    kind: 'visit',
    input: value,
    ...(rootAssign === undefined ? {} : { assign: rootAssign }),
  }];

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (!task) continue;

    if (task.kind === 'finish-array') {
      ancestors.delete(task.input);
      if (task.assign !== undefined && task.output !== undefined) {
        task.assign(Object.freeze(task.output));
      }
      continue;
    }
    if (task.kind === 'finish-object') {
      ancestors.delete(task.input);
      if (task.assign !== undefined && task.output !== undefined) {
        task.assign(Object.freeze(task.output));
      }
      continue;
    }

    const input = task.input;
    if (input === null || typeof input === 'boolean') {
      task.assign?.(input);
      continue;
    }
    if (typeof input === 'string') {
      task.assign?.(input);
      continue;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error(`${path} must contain finite JSON numbers`);
      task.assign?.(input);
      continue;
    }
    if (typeof input !== 'object') throw new Error(`${path} must contain strict JSON data`);
    if (ancestors.has(input)) throw new Error(`${path} must not contain cyclic data`);
    ancestors.add(input);

    if (Array.isArray(input)) {
      const descriptors = assertStrictJsonArrayDescriptors(input, path);
      const length = strictJsonArrayLength(descriptors);
      const output = task.assign === undefined ? undefined : new Array<unknown>(length);
      tasks.push({
        kind: 'finish-array',
        input,
        ...(output === undefined || task.assign === undefined ? {} : { output, assign: task.assign }),
      });
      for (let index = length - 1; index >= 0; index -= 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) {
          throw new Error(`${path} must contain dense JSON array values`);
        }
        tasks.push({
          kind: 'visit',
          input: descriptor.value,
          ...(output === undefined ? {} : { assign: (cloned: unknown) => {
            output[index] = cloned;
          } }),
        });
      }
      continue;
    }

    const keys = strictJsonObjectKeys(input, path);
    const output = task.assign === undefined
      ? undefined
      : Object.create(null) as Record<string, unknown>;
    tasks.push({
      kind: 'finish-object',
      input,
      ...(output === undefined || task.assign === undefined ? {} : { output, assign: task.assign }),
    });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new Error(`${path}.${key} must be enumerable data`);
      }
      tasks.push({
        kind: 'visit',
        input: descriptor.value,
        ...(output === undefined ? {} : { assign: (cloned: unknown) => {
          Object.defineProperty(output, key, {
            value: cloned,
            enumerable: true,
            writable: false,
            configurable: false,
          });
        } }),
      });
    }
  }

  return root;
}

export function cloneStrictPluginJsonValue(
  value: unknown,
  path: string,
): unknown {
  return walkStrictPluginJsonValue(value, path, true);
}

/** @internal Protocol-only non-copying validation for an already admitted input. */
export function assertStrictPluginJsonValue(value: unknown, path: string): void {
  walkStrictPluginJsonValue(value, path, false);
}

type StrictJsonMeasurementTask =
  | Readonly<{ kind: 'text'; value: string }>
  | Readonly<{ kind: 'value'; value: unknown }>;

/**
 * Measures the exact JSON.stringify spelling in UTF-8 bytes without creating
 * a complete serialized JSON string. Individual strings still use
 * JSON.stringify so escaping (including lone-surrogate escapes), number
 * spelling, and object-key spelling stay aligned with the platform contract.
 *
 * When a maximum is supplied, return `maximum + 1` as soon as the complete
 * serialization is known to exceed it. This gives boundary owners an exact
 * fail-closed sentinel without retaining an unbounded serialized payload.
 */
export function measureSerializedStrictPluginJsonUtf8Bytes(
  value: unknown,
  path: string,
  maximumBytes?: number,
): number {
  if (maximumBytes !== undefined
    && (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)) {
    throw new TypeError('Strict JSON serialized byte maximum must be a nonnegative safe integer');
  }

  return measureSerializedValidatedStrictPluginJsonUtf8Bytes(
    cloneStrictPluginJsonValue(value, path),
    path,
    maximumBytes,
  );
}

/**
 * @internal No-copy measurement for a value already admitted as immutable
 * strict JSON. Unknown or mutable inputs must use the cloning measurement
 * entry point instead.
 */
export function measureSerializedValidatedStrictPluginJsonUtf8Bytes(
  value: unknown,
  path: string,
  maximumBytes?: number,
): number {
  const tasks: StrictJsonMeasurementTask[] = [{ kind: 'value', value }];
  let measuredBytes = 0;

  const appendText = (text: string): boolean => {
    const textBytes = textEncoder.encode(text).byteLength;
    if (maximumBytes !== undefined && textBytes > maximumBytes - measuredBytes) {
      measuredBytes = maximumBytes + 1;
      return false;
    }
    measuredBytes += textBytes;
    return true;
  };

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (!task) continue;
    if (task.kind === 'text') {
      if (!appendText(task.value)) return measuredBytes;
      continue;
    }

    const current = task.value;
    if (current === null) {
      if (!appendText('null')) return measuredBytes;
      continue;
    }
    if (typeof current === 'boolean' || typeof current === 'number') {
      const serialized = JSON.stringify(current);
      if (serialized === undefined) throw new Error(`${path} must contain strict JSON data`);
      if (!appendText(serialized)) return measuredBytes;
      continue;
    }
    if (typeof current === 'string') {
      if (!appendText(JSON.stringify(current))) return measuredBytes;
      continue;
    }
    if (Array.isArray(current)) {
      tasks.push({ kind: 'text', value: ']' });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (index < current.length - 1) tasks.push({ kind: 'text', value: ',' });
        tasks.push({ kind: 'value', value: current[index] });
      }
      tasks.push({ kind: 'text', value: '[' });
      continue;
    }

    const object = current as Record<string, unknown>;
    const keys = Object.keys(object);
    tasks.push({ kind: 'text', value: '}' });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      if (index < keys.length - 1) tasks.push({ kind: 'text', value: ',' });
      tasks.push({ kind: 'value', value: object[key] });
      tasks.push({ kind: 'text', value: ':' });
      tasks.push({ kind: 'text', value: JSON.stringify(key) });
    }
    tasks.push({ kind: 'text', value: '{' });
  }

  return measuredBytes;
}

/** Fail closed for schema predicates, including proxies that throw during reflection. */
export function isStrictPluginJsonValue(
  value: unknown,
): boolean {
  try {
    assertStrictPluginJsonValue(value, 'value');
    return true;
  } catch {
    return false;
  }
}
