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

/** The one Protocol owner for raw, well-formed UTF-8 string measurement. */
export function measurePluginJsonUtf8Bytes(value: string, path: string): number {
  assertWellFormedUnicode(value, path);
  return textEncoder.encode(value).byteLength;
}

/**
 * Copies ordinary JSON for Protocol-owned values. Complete-value byte ceilings
 * belong to the owning wire or transport boundary; this generic clone exposes
 * no node, depth, or member-count quota. The explicit work stack keeps valid
 * deep data off the JavaScript call stack while preserving strict
 * data/accessor/prototype/cycle rules.
 *
 * There is no depth quota here because there is no honest number to pick.
 * `JSON.stringify` is the only authority on what a runtime can serialize, and
 * across the engines this product ships on, the nesting it accepts for a chain
 * of single-key objects spans three orders of magnitude. Deepest value each
 * engine serialized without throwing, 2026-08-23. Every row except SpiderMonkey
 * was produced by running that engine on the measuring host; no SpiderMonkey
 * shell was installed there, so its row is reported for the Firefox build it
 * names rather than reproduced:
 *
 *   Hermes (this repository's react-native engine pod)                   511
 *   SpiderMonkey (Firefox 146.0.1)                                     3,899
 *   V8 (Node 22.22.1)                                                  6,079
 *   V8 (Node 24.14.0)                                                  6,173
 *   JavaScriptCore (macOS 26.3.1 system jsc)  accepted 40,000, refused 60,000
 *   V8 (Node 26.0.0) - iterative, no limit found                  >1,000,000
 *
 * The recursive V8 builds also move with the call stack already in use: Node
 * 24.14.0 accepted 6,173 on a fresh stack but 5,472 under 1,000 frames, 4,072
 * under 3,000, and 1,972 under 6,000. Hermes does not move, because its ceiling
 * is a fixed nesting counter rather than a machine-stack budget - so the lowest
 * limit in the product is also the one no caller can widen. Even the throwable
 * differs: Hermes throws `RangeError: Maximum nesting level in JSON stringifyer
 * exceeded`, V8 and JSC throw `RangeError: Maximum call stack size exceeded`,
 * and SpiderMonkey throws `InternalError: too much recursion`, which is not a
 * `RangeError` at all.
 *
 * So any fixed ceiling would be wrong in both directions at once: it would
 * reject data four of these engines serialize comfortably while still
 * overflowing Hermes. Boundary owners catch the refusal where they actually
 * serialize and report it as a typed permanent failure instead.
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

type StrictJsonObjectDescriptors = Readonly<{
  descriptors: Readonly<Record<string, PropertyDescriptor>>;
  keys: readonly string[];
}>;

function strictJsonObjectDescriptors(input: object, path: string): StrictJsonObjectDescriptors {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain objects`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new Error(`${path} must not contain symbol keys`);
  }
  const keys = ownKeys as readonly string[];
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${path}.${key} must be an enumerable data property`);
    }
  }
  return { descriptors, keys };
}

function strictJsonArrayDescriptors(input: object, path: string): Readonly<{
  descriptors: Readonly<Record<string, PropertyDescriptor>>;
  length: number;
}> {
  if (Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${path} must contain only ordinary arrays`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const ownKeys = Reflect.ownKeys(descriptors);
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
  if (ownKeys.some((key) => typeof key === 'symbol'
    || (key !== 'length' && (!/^\d+$/u.test(key) || String(Number(key)) !== key || Number(key) >= length)))) {
    throw new Error(`${path} must not contain extra array properties`);
  }
  return {
    descriptors,
    length,
  };
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
      const { descriptors, length } = strictJsonArrayDescriptors(input, path);
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

    const { descriptors, keys } = strictJsonObjectDescriptors(input, path);
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
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) {
        throw new Error(`${path}.${key} must be an enumerable data property`);
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
 * `JSON.stringify` has no spelling for these: it omits an object member that
 * holds one and writes `null` for an array element that does. Measuring the
 * exact serialized spelling means reproducing that rule rather than inventing
 * a third answer.
 */
function hasNoJsonSpelling(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

/**
 * Measures the exact JSON.stringify spelling in UTF-8 bytes without creating
 * a complete serialized JSON string. Individual strings still use
 * JSON.stringify so escaping, number spelling, and object-key spelling stay
 * aligned with the platform contract.
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
  if (hasNoJsonSpelling(value)) throw new Error(`${path} must contain strict JSON data`);
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
        const element = current[index];
        tasks.push(hasNoJsonSpelling(element)
          ? { kind: 'text', value: 'null' }
          : { kind: 'value', value: element });
      }
      tasks.push({ kind: 'text', value: '[' });
      continue;
    }
    if (typeof current !== 'object') throw new Error(`${path} must contain strict JSON data`);

    const object = current as Record<string, unknown>;
    const keys = Object.keys(object).filter((key) => !hasNoJsonSpelling(object[key]));
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
