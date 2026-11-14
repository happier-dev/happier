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
  let internals: T['_zod'] | undefined;
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
    get: (_target, key) => {
      const built = resolve();
      if (key !== '_zod') return Reflect.get(built, key);
      if (!internals) {
        const original = built._zod;
        const processJSONSchema: NonNullable<typeof original.processJSONSchema> = (ctx, json, params) => {
          // Zod's instance hook closes over `built`, while the native walker
          // registered the facade. Translate only that identity during the
          // hook; leave ancestry, metadata and overrides to Zod's walker.
          const records = new Set<core.Seen>();
          const trackRecord = (record: core.Seen | undefined) => {
            if (record) records.add(record);
            return record;
          };
          const nativeSeen = ctx.seen;
          const seen = new Proxy(nativeSeen, {
            get: (target, field) => {
              const translate = (schema: core.$ZodType) => schema === built ? proxy : schema;
              if (field === 'get') return (schema: core.$ZodType) => trackRecord(target.get(translate(schema)));
              if (field === 'has') return (schema: core.$ZodType) => target.has(translate(schema));
              if (field === 'set') return (schema: core.$ZodType, entry: core.Seen) => {
                target.set(translate(schema), trackRecord(entry)!);
                return seen;
              };
              if (field === 'delete') return (schema: core.$ZodType) => target.delete(translate(schema));
              const value: unknown = Reflect.get(target, field, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          ctx.seen = seen;
          try {
            trackRecord(nativeSeen.get(proxy));
            original.processJSONSchema!(ctx, json, {
              ...params,
              schemaPath: [...params.schemaPath, built],
            });
          } finally {
            ctx.seen = nativeSeen;
            // Native hooks finish assigning refs synchronously. Normalize
            // their edges for the later finalizer without replacing records
            // that a reentrant hook may still hold.
            for (const record of records) {
              if (record.ref === built) record.ref = proxy;
            }
          }
        };
        internals = new Proxy(original, {
          get: (target, field) => field === 'processJSONSchema' && original.processJSONSchema ? processJSONSchema : Reflect.get(target, field),
        });
      }
      return internals;
    },
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
