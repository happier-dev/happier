import { globalRegistry, type core } from 'zod';

/**
 * Defers building a module-level schema until it is first used.
 *
 * Importing the protocol package used to construct every schema it declares
 * (~22k zod instances, ~37 MB private memory), while any single process — a
 * session runner, the daemon, the app — touches a small fraction of them.
 *
 * The returned proxy forwards every operation to the schema built on first
 * access, so callers keep the exact schema type and API (`parse`, `shape`,
 * `extend`, `instanceof`, ...). Identity is the proxy's, and stays stable for
 * the lifetime of the module.
 *
 * Keep this module free of first-party imports: every schema module imports
 * it, so such an import would join their initialization cycles.
 */
export function lazySchema<T extends core.$ZodType>(build: () => T): T {
  let schema: T | undefined;
  const resolve = (): T => {
    if (schema) return schema;
    schema = build();
    // Zod keeps `.describe()`/`.meta()` in a registry keyed by instance, and
    // JSON Schema projection looks it up by the reference it walks — the proxy.
    const metadata = globalRegistry.get(schema);
    if (metadata) globalRegistry.add(proxy, metadata);
    return schema;
  };

  const proxy: T = new Proxy({} as T, {
    get: (_target, key) => Reflect.get(resolve(), key),
    set: (_target, key, value) => Reflect.set(resolve(), key, value),
    has: (_target, key) => Reflect.has(resolve(), key),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), key);
      // Proxy invariants forbid reporting a non-configurable property the
      // (empty) target does not own.
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    defineProperty: (_target, key, descriptor) => Reflect.defineProperty(resolve(), key, descriptor),
    deleteProperty: (_target, key) => Reflect.deleteProperty(resolve(), key),
    getPrototypeOf: () => Reflect.getPrototypeOf(resolve()),
  });
  return proxy;
}
