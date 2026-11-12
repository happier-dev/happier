/**
 * Host-deferred declaration fields.
 *
 * Bundled declarations keep large values (Action input/result JSON Schemas) as
 * enumerable accessors that read the published value on first use. Only
 * accessors created here are deferred declaration fields: the strict JSON owner
 * (`strictJsonValue.ts`) reads them as data, while every other accessor stays
 * refused. A read, spread, clone, serialization or strict check therefore always
 * sees the exact declared value; only the cost moves to first use.
 */

const deferredDeclarationReaders = new WeakSet<() => unknown>();

/** The value of an own property descriptor when it is a host-deferred declaration field. */
export function readDeferredDeclarationDescriptor(
  owner: object,
  descriptor: PropertyDescriptor,
): Readonly<{ value: unknown }> | null {
  return typeof descriptor.get === 'function' && deferredDeclarationReaders.has(descriptor.get)
    ? { value: descriptor.get.call(owner) }
    : null;
}

function isDeferred(source: object, key: string): boolean {
  const read = Object.getOwnPropertyDescriptor(source, key)?.get;
  return typeof read === 'function' && deferredDeclarationReaders.has(read);
}

function defineReader(target: object, key: string, read: () => unknown): void {
  deferredDeclarationReaders.add(read);
  Object.defineProperty(target, key, { get: read, enumerable: true, configurable: true });
}

/** Defines `target[key]` as a deferred declaration field read on first use (memoized by `read`'s owner). */
export function defineDeferredDeclarationField(target: object, key: string, read: () => unknown): void {
  defineReader(target, key, read);
}

/** Object spread that keeps deferred declaration fields deferred (same key order and override rules). */
export function spreadPreservingDeferredFields<T extends object>(...sources: ReadonlyArray<object | undefined>): T {
  const target: Record<string, unknown> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const key of Object.keys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
      if (descriptor.get && deferredDeclarationReaders.has(descriptor.get)) {
        Object.defineProperty(target, key, { get: descriptor.get, enumerable: true, configurable: true });
      } else if (isDeferred(target, key)) {
        Object.defineProperty(target, key, { value: (source as Record<string, unknown>)[key], writable: true, enumerable: true, configurable: true });
      } else {
        target[key] = (source as Record<string, unknown>)[key];
      }
    }
  }
  return target as T;
}

/** `target[key] = source[sourceKey]` when present, without reading a deferred declaration field. */
export function forwardDeclarationField(target: Record<string, unknown>, key: string, source: object, sourceKey: string = key): void {
  const read = Object.getOwnPropertyDescriptor(source, sourceKey)?.get;
  if (read && deferredDeclarationReaders.has(read)) {
    Object.defineProperty(target, key, { get: read, enumerable: true, configurable: true });
    return;
  }
  const value: unknown = (source as Record<string, unknown>)[sourceKey];
  if (value !== undefined) target[key] = value;
}

/** A value derived from deferred declaration fields: computed once, on first read. */
export function defineDerivedDeclarationField(
  target: Record<string, unknown>,
  key: string,
  dependsOn: ReadonlyArray<readonly [object, string]>,
  compute: () => unknown,
): void {
  if (!dependsOn.some(([source, sourceKey]) => isDeferred(source, sourceKey))) {
    target[key] = compute();
    return;
  }
  let computed = false;
  let value: unknown;
  defineReader(target, key, () => {
    if (!computed) { value = compute(); computed = true; }
    return value;
  });
}

const PRECOMPUTED_DECLARATION_FIELDS = Symbol('happier.plugin.precomputedDeclarationFields');

/**
 * Publisher-derived values that a projection would otherwise compute from a
 * deferred field (bundled Action input hints or a manifest digest). Kept as a non-enumerable symbol
 * sidecar: spreads, clones, JSON and strict JSON never carry it.
 */
export function attachPrecomputedDeclarationFields(target: object, fields: Readonly<Record<string, unknown>>): void {
  Object.defineProperty(target, PRECOMPUTED_DECLARATION_FIELDS, { value: Object.freeze({ ...fields }), enumerable: false });
}

export function readPrecomputedDeclarationField(source: object, key: string): Readonly<{ value: unknown }> | null {
  const fields = (source as { [PRECOMPUTED_DECLARATION_FIELDS]?: Readonly<Record<string, unknown>> })[PRECOMPUTED_DECLARATION_FIELDS];
  return fields && Object.hasOwn(fields, key) ? { value: fields[key] } : null;
}

/** Preserve publisher facts only across an exact, byte-preserving normalization. */
export function forwardPrecomputedDeclarationFields(source: object, target: object): void {
  const fields = (source as { [PRECOMPUTED_DECLARATION_FIELDS]?: Readonly<Record<string, unknown>> })[PRECOMPUTED_DECLARATION_FIELDS];
  if (fields) attachPrecomputedDeclarationFields(target, fields);
}
