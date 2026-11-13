import { readDeferredDeclarationDescriptor } from './deferredDeclarationFields.js';
// Only snapshots created and recursively frozen by this owner are proofs of
// strict JSON. A caller's Object.freeze is shallow and cannot provide that proof.
const normalizedStrictJsonObjects = new WeakSet<object>();

// `Object.create(null)` puts an object in V8 dictionary mode, and freezing a dictionary
// object gives it its own map. Snapshots are retained by the tens of thousands, so build
// them from a literal: they stay fast and share one map per shape, still without a prototype.
function createNullPrototypeSnapshotRecord(): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  Object.setPrototypeOf(record, null);
  return record;
}

/** The one Protocol owner for raw, well-formed UTF-8 string measurement. */
export function measurePluginJsonUtf8Bytes(value: string, path: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7F) {
      bytes += 1;
      continue;
    }
    if (codeUnit <= 0x7FF) {
      bytes += 2;
      continue;
    }
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const trailingCodeUnit = value.charCodeAt(index + 1);
      if (!(trailingCodeUnit >= 0xDC00 && trailingCodeUnit <= 0xDFFF)) {
        throw new Error(`${path} must contain well-formed Unicode`);
      }
      bytes += 4;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      throw new Error(`${path} must contain well-formed Unicode`);
    }
    bytes += 3;
  }
  return bytes;
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
// One task shape for the explicit work stack. A visited value is written to
// `target[key]` (or becomes the root when `target` is undefined); a finish task
// freezes and publishes its `output` container the same way. No per-value closures.
type StrictJsonWalkTask = {
  kind: 'visit' | 'finish';
  input: unknown;
  path: string;
  depth: number;
  target: Record<string, unknown> | unknown[] | undefined;
  key: string | number;
  output: Record<string, unknown> | unknown[] | undefined;
};

type StrictJsonObjectDescriptors = Readonly<{
  descriptors: Readonly<Record<string, PropertyDescriptor>>;
  keys: readonly string[];
}>;

export type StrictPluginJsonTraversalLimits = Readonly<{
  maxDepth: number;
  maxValues: number;
}>;

export class StrictPluginJsonTraversalLimitError extends Error {
  readonly limit: 'depth' | 'values';

  constructor(limit: 'depth' | 'values') {
    super(`Strict JSON ${limit} limit exceeded`);
    this.name = 'StrictPluginJsonTraversalLimitError';
    this.limit = limit;
  }
}

function strictJsonObjectDescriptors(input: object, path: string): StrictJsonObjectDescriptors {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain objects`);
  }
  // One descriptor read per member. Every listed own key must still describe a
  // property: a reflective object that lists a key it cannot describe is refused.
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== Reflect.ownKeys(input).length) throw new Error(`${path} must contain stable own properties`);
  const keys: string[] = [];
  for (const key of ownKeys) {
    let descriptor = descriptors[key as string]!;
    // A host-deferred declaration field (bundled Action schemas) is data that
    // has not been read yet: read it here, the one strict JSON owner. Any other
    // accessor is still refused below.
    const deferred = typeof key === 'string' && descriptor.enumerable === true
      ? readDeferredDeclarationDescriptor(input, descriptor) : null;
    if (deferred) {
      descriptor = { value: deferred.value, writable: false, enumerable: true, configurable: true };
      (descriptors as Record<string, PropertyDescriptor>)[key as string] = descriptor;
    }
    if (typeof key === 'symbol') {
      // Host-only brands are deliberately non-enumerable because they are
      // process-local sidecars, not JSON members. Drop those exactly as
      // JSON.stringify does; an enumerable symbol would silently lose an
      // author-visible member and is therefore rejected.
      if (descriptor.enumerable) throw new Error(`${path} must not contain enumerable symbol keys`);
      continue;
    }
    if (!('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${path}.${key} must be an enumerable data property`);
    }
    keys.push(key);
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
  for (const key of ownKeys) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) throw new Error(`${path} must contain stable own properties`);
    if (typeof key === 'symbol') {
      if (descriptor.enumerable) throw new Error(`${path} must not contain enumerable symbol keys`);
      continue;
    }
    if (!/^\d+$/u.test(key) || String(Number(key)) !== key || Number(key) >= length) {
      throw new Error(`${path} must not contain extra array properties`);
    }
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
  limits?: StrictPluginJsonTraversalLimits,
  omitUndefinedObjectMembers = false,
): unknown {
  if (limits && (
    !Number.isSafeInteger(limits.maxDepth)
    || limits.maxDepth < 1
    || !Number.isSafeInteger(limits.maxValues)
    || limits.maxValues < 1
  )) {
    throw new TypeError('Strict JSON traversal limits must be positive safe integers');
  }
  // A scalar or an already admitted snapshot is its own result. Composed schemas
  // walk every member again, so this path must not build traversal state.
  if (!limits) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return copiesValue ? value : undefined;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`${path} must contain finite JSON numbers`);
      return copiesValue ? value : undefined;
    }
    if (typeof value !== 'object') throw new Error(`${path} must contain strict JSON data`);
    if (normalizedStrictJsonObjects.has(value)) return copiesValue ? value : undefined;
  }
  let root: unknown;
  let scheduledValues = 1;
  if (limits && scheduledValues > limits.maxValues) {
    throw new StrictPluginJsonTraversalLimitError('values');
  }
  const ancestors = new WeakSet<object>();
  const publish = (task: StrictJsonWalkTask, value: unknown): void => {
    if (!copiesValue) return;
    if (task.target === undefined) root = value;
    else (task.target as Record<string | number, unknown>)[task.key] = value;
  };
  const tasks: StrictJsonWalkTask[] = [{
    kind: 'visit', input: value, path, depth: 1, target: undefined, key: '', output: undefined,
  }];

  while (tasks.length > 0) {
    const task = tasks.pop()!;

    if (task.kind === 'finish') {
      ancestors.delete(task.input as object);
      if (task.output !== undefined) {
        Object.freeze(task.output);
        normalizedStrictJsonObjects.add(task.output);
        publish(task, task.output);
      }
      continue;
    }

    const input = task.input;
    const path = task.path;
    if (limits && task.depth > limits.maxDepth) {
      throw new StrictPluginJsonTraversalLimitError('depth');
    }
    if (input === null || typeof input === 'boolean' || typeof input === 'string') {
      publish(task, input);
      continue;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error(`${path} must contain finite JSON numbers`);
      publish(task, input);
      continue;
    }
    if (typeof input !== 'object') throw new Error(`${path} must contain strict JSON data`);
    // Bounded walks must still count every value and depth at their own boundary.
    if (!limits && normalizedStrictJsonObjects.has(input)) {
      publish(task, input);
      continue;
    }
    if (ancestors.has(input)) throw new Error(`${path} must not contain cyclic data`);
    ancestors.add(input);

    if (Array.isArray(input)) {
      const { descriptors, length } = strictJsonArrayDescriptors(input, path);
      if (limits && scheduledValues + length > limits.maxValues) {
        throw new StrictPluginJsonTraversalLimitError('values');
      }
      scheduledValues += length;
      const output = copiesValue ? new Array<unknown>(length) : undefined;
      tasks.push({ kind: 'finish', input, path, depth: task.depth, target: task.target, key: task.key, output });
      for (let index = length - 1; index >= 0; index -= 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) {
          throw new Error(`${path} must contain dense JSON array values`);
        }
        tasks.push({
          kind: 'visit', input: descriptor.value, path: `${path}[${index}]`, depth: task.depth + 1,
          target: output, key: index, output: undefined,
        });
      }
      continue;
    }

    const { descriptors, keys } = strictJsonObjectDescriptors(input, path);
    if (limits && scheduledValues + keys.length > limits.maxValues) {
      throw new StrictPluginJsonTraversalLimitError('values');
    }
    scheduledValues += keys.length;
    // Members are written in order before the record is frozen; the null
    // prototype keeps `__proto__` an ordinary own key.
    const output = copiesValue ? createNullPrototypeSnapshotRecord() : undefined;
    tasks.push({ kind: 'finish', input, path, depth: task.depth, target: task.target, key: task.key, output });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) {
        throw new Error(`${path}.${key} must be an enumerable data property`);
      }
      if (omitUndefinedObjectMembers && descriptor.value === undefined) continue;
      tasks.push({
        kind: 'visit', input: descriptor.value, path: `${path}.${key}`, depth: task.depth + 1,
        target: output, key, output: undefined,
      });
    }
  }

  return root;
}

/**
 * @internal For Protocol composers: a record the composer just built whose members are
 * scalars or admitted snapshots becomes an admitted snapshot without walking it again.
 * Returns undefined when any member lacks that proof, and the caller walks it as usual.
 */
export function sealComposedStrictJsonRecord(members: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  const snapshot = createNullPrototypeSnapshotRecord();
  for (const key of Object.keys(members)) {
    const value = members[key];
    if (value === null || typeof value === 'boolean' || typeof value === 'string'
      || (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'object' && normalizedStrictJsonObjects.has(value))) {
      snapshot[key] = value;
      continue;
    }
    return undefined;
  }
  Object.freeze(snapshot);
  normalizedStrictJsonObjects.add(snapshot);
  return snapshot;
}

export function cloneStrictPluginJsonValue(
  value: unknown,
  path: string,
): unknown {
  return walkStrictPluginJsonValue(value, path, true);
}

/** @internal Native optional members omit undefined exactly at the JSON transport boundary. */
export function cloneNativeJsonValueForTransport(value: unknown, path: string): unknown {
  return walkStrictPluginJsonValue(value, path, true, undefined, true);
}

/** @internal Feature-owned bounded cloning through the one strict JSON walker. */
export function cloneStrictPluginJsonValueWithTraversalLimits(
  value: unknown,
  path: string,
  limits: StrictPluginJsonTraversalLimits,
): unknown {
  return walkStrictPluginJsonValue(value, path, true, limits);
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
    // Counting must not allocate an encoded buffer for every JSON token.
    const textBytes = measurePluginJsonUtf8Bytes(text, path);
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

type StrictJsonAdoptTask = Readonly<{ kind: 'visit' | 'finish'; input: unknown; path: string }>;

/**
 * @internal Admits a graph its caller has just produced and that no other owner
 * retains (a schema parse output) as an immutable snapshot in place, instead of
 * copying it. The strict rules are the cloning walk's: plain objects or ordinary
 * dense arrays, enumerable data members, finite numbers, no cycles; undefined
 * object members are omitted as at the JSON transport boundary. Every container
 * is frozen and becomes an admitted snapshot, so later transport projections share
 * it by identity. Already admitted subgraphs (and repeated references inside the
 * graph) are kept. Objects keep their prototype: adopted values are read by
 * consumers that already hold them, and nothing is constructed from keys here.
 */
export function adoptParsedNativeJsonValueForTransport<T>(value: T, path: string): T {
  const tasks: StrictJsonAdoptTask[] = [{ kind: 'visit', input: value, path }];
  const ancestors = new WeakSet<object>();
  while (tasks.length > 0) {
    const task = tasks.pop()!;
    const input = task.input;
    if (task.kind === 'finish') {
      ancestors.delete(input as object);
      Object.freeze(input);
      normalizedStrictJsonObjects.add(input as object);
      continue;
    }
    if (input === null || typeof input === 'boolean' || typeof input === 'string') continue;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error(`${task.path} must contain finite JSON numbers`);
      continue;
    }
    if (typeof input !== 'object') throw new Error(`${task.path} must contain strict JSON data`);
    if (normalizedStrictJsonObjects.has(input)) continue;
    if (ancestors.has(input)) throw new Error(`${task.path} must not contain cyclic data`);
    ancestors.add(input);
    tasks.push({ kind: 'finish', input, path: task.path });
    if (Array.isArray(input)) {
      const { descriptors, length } = strictJsonArrayDescriptors(input, task.path);
      for (let index = length - 1; index >= 0; index -= 1) {
        tasks.push({ kind: 'visit', input: descriptors[String(index)]!.value, path: `${task.path}[${index}]` });
      }
      continue;
    }
    const { descriptors, keys } = strictJsonObjectDescriptors(input, task.path);
    const record = input as Record<string, unknown>;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      const member = descriptors[key]!.value;
      if (member === undefined) {
        delete record[key];
        continue;
      }
      // A host-deferred field the descriptor owner just read becomes plain data.
      if (!('value' in (Object.getOwnPropertyDescriptor(record, key) ?? {}))) {
        Object.defineProperty(record, key, { value: member, enumerable: true, writable: true, configurable: true });
      }
      tasks.push({ kind: 'visit', input: member, path: `${task.path}.${key}` });
    }
  }
  return value;
}
