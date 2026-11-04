/** Retain tuple row correlations when declaring a deferred array concatenation. */
export type ActionSpecArrayConcat<TArrays extends readonly (readonly unknown[])[]> =
  TArrays extends readonly [
    infer First extends readonly unknown[],
    ...infer Rest extends readonly (readonly unknown[])[],
  ]
    ? readonly [...First, ...ActionSpecArrayConcat<Rest>]
    : readonly [];

/** Preserve exported array identity and shape while spec modules finish loading. */
export function lazyActionSpecArray<const T extends readonly unknown[]>(create: () => T): T {
  return lazyActionSpecValue([] as unknown as T, create);
}

/** Schema projections share the same first-consumer lifetime as their rows. */
export function lazyActionSpecRecord<T extends object>(create: () => T): T {
  return lazyActionSpecValue({} as T, create);
}

/** Private native Map/Set indexes retain their own method receivers. */
export function memoizeActionSpecValue<T extends object>(create: () => T): () => T {
  let value: T | undefined;
  return () => value ??= create();
}

function lazyActionSpecValue<T extends object>(target: T, create: () => T): T {
  let initialize: (() => T) | undefined = create;
  const resolve = () => {
    if (initialize) {
      const value = initialize();
      Object.defineProperties(target, Object.getOwnPropertyDescriptors(value));
      if (!Object.isExtensible(value)) Object.preventExtensions(target);
      initialize = undefined;
    }
    return target;
  };
  return new Proxy(target, {
    get(_target, key, receiver: unknown): unknown {
      // Fast Refresh inspects exported values before cyclic modules finish.
      if (initialize && key === '$$typeof') return undefined;
      return Reflect.get(resolve(), key, receiver);
    },
    has: (_target, key) => Reflect.has(resolve(), key),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(resolve(), key),
    isExtensible: () => Reflect.isExtensible(resolve()),
    preventExtensions: () => Reflect.preventExtensions(resolve()),
    set: (_target, key, value: unknown, receiver: unknown) => Reflect.set(resolve(), key, value, receiver),
    defineProperty: (_target, key, descriptor) => Reflect.defineProperty(resolve(), key, descriptor),
    deleteProperty: (_target, key) => Reflect.deleteProperty(resolve(), key),
  });
}
