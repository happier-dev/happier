import { core, globalRegistry, toJSONSchema, ZodType } from 'zod';

const SCHEMA_METHODS = new Set([
  'check', 'with', 'clone', 'refine', 'superRefine', 'overwrite', 'optional',
  'exactOptional', 'nullable', 'nullish', 'nonoptional', 'array', 'or', 'and',
  'transform', 'default', 'prefault', 'catch', 'pipe', 'readonly', 'describe',
  'extend', 'safeExtend', 'merge', 'pick', 'omit', 'partial', 'required',
  'strict', 'strip', 'passthrough', 'loose', 'catchall',
  'trim', 'min', 'max', 'regex', 'keyof',
]);
const PARSE_METHODS = new Set([
  'parse', 'safeParse', 'parseAsync', 'safeParseAsync', 'spa', 'encode', 'decode',
  'encodeAsync', 'decodeAsync', 'safeEncode', 'safeDecode', 'safeEncodeAsync', 'safeDecodeAsync',
]);
const concreteSchemaResolvers = new WeakMap<object, () => object>();

/** Keeps the concrete Zod contract while admitting construction on demand. */
export function lazyZodSchema<TSchema extends ZodType>(create: () => TSchema): TSchema {
  return createLazyDefinition(create, true);
}

/** A catalog's derived artifact is admitted by the same definition lifetime. */
export function lazyDefinition<TDefinition extends object>(create: () => TDefinition): TDefinition {
  return createLazyDefinition(create, false);
}

function createLazyDefinition<TSchema extends object>(create: () => TSchema, deferZodMethods: boolean): TSchema {
  const target = {} as TSchema;
  let schema: TSchema | undefined;
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const resolve = (): TSchema => {
    if (!schema) {
      const created = create();
      // A deferred composition may return another facade from this owner.
      // Flatten it before copying internals: otherwise native parent identity
      // can refer to an intermediate facade instead of the actual schema.
      const concrete = (deferZodMethods ? concreteSchemaResolvers.get(created)?.() ?? created : created) as TSchema;
      Object.setPrototypeOf(target, Object.getPrototypeOf(concrete));
      const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(concrete);
      const concreteSchema = concrete instanceof core.$ZodType ? concrete : undefined;
      if (concreteSchema) {
        // Projection processors close over the concrete instance. Construction
        // deferral is not a new schema wrapper: share its traversal identity so
        // recursive definitions and refinements do not gain extra references.
        // Inherit all other internals, including lazy getters and the parser.
        const processJSONSchema: NonNullable<core.$ZodType['_zod']['processJSONSchema']> = (context, json, params) => {
          if (!deferZodMethods) {
            context.seen.delete(definition as unknown as core.$ZodType);
            core.process(concreteSchema, context, {
              ...params,
              schemaPath: params.schemaPath.map(item => item === definition ? concreteSchema : item),
            });
            context.seen.set(definition as unknown as core.$ZodType, context.seen.get(concreteSchema)!);
            return;
          }
          // Native callbacks refer to their concrete constructor instance.
          // Give that callback the facade's existing record, rather than
          // traversing a second wrapper or processing its parent twice.
          const facade = definition as unknown as core.$ZodType;
          const seen = context.seen.get(facade)!;
          const existing = context.seen.get(concreteSchema);
          if (existing) {
            core.process(concreteSchema, context, params);
            context.seen.set(facade, existing);
            return;
          }
          context.seen.set(concreteSchema, seen);
          const processor = concreteSchema._zod.processJSONSchema;
          const callbackParams = { ...params, schemaPath: [...params.schemaPath, concreteSchema] };
          if (processor) processor(context, json, callbackParams);
          else {
            const fallback = context.processors[concreteSchema._zod.def.type];
            if (!fallback) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${concreteSchema._zod.def.type}`);
            fallback(concreteSchema, context, json, callbackParams);
          }
        };
        descriptors._zod = {
          ...descriptors._zod,
          value: Object.create(concreteSchema._zod, {
            processJSONSchema: { value: processJSONSchema },
          }),
        };
      }
      if (deferZodMethods && concrete instanceof ZodType) {
        // Keep the concrete root's projection identity while using Zod's
        // native processors for genuine Core/Mini child definitions.
        descriptors.toJSONSchema = {
          ...descriptors.toJSONSchema,
          value: (params?: core.ToJSONSchemaParams) => toJSONSchema(concrete, params),
        };
      }
      Object.defineProperties(target, descriptors);
      schema = concrete;
      if (concreteSchema && deferZodMethods) {
        // Zod stores annotations by instance identity, outside the definition.
        // The public facade must carry those annotations as well as its fields.
        const metadata = globalRegistry.get(concreteSchema);
        if (metadata) globalRegistry.add(definition as unknown as core.$ZodType, metadata);
      }
    }
    return schema;
  };
  const invoke = (key: PropertyKey, args: unknown[]): unknown => {
    const concrete = resolve();
    const method: unknown = Reflect.get(concrete, key);
    if (typeof method !== 'function') throw new TypeError(`Invalid Zod method: ${String(key)}`);
    return Reflect.apply(method, concrete, args);
  };
  const definition = new Proxy(target, {
    get(_target, key) {
      if (schema) return Reflect.get(target, key);
      if (deferZodMethods && typeof key === 'string' && (SCHEMA_METHODS.has(key) || PARSE_METHODS.has(key))) {
        let method = methods.get(key);
        if (!method) {
          method = SCHEMA_METHODS.has(key)
            ? (...args) => lazyZodSchema(() => invoke(key, args) as ZodType)
            : (...args) => invoke(key, args);
          methods.set(key, method);
        }
        return method;
      }
      resolve();
      return Reflect.get(target, key);
    },
    getPrototypeOf() { resolve(); return Reflect.getPrototypeOf(target); },
    ownKeys() { resolve(); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(_target, key) { resolve(); return Reflect.getOwnPropertyDescriptor(target, key); },
    has(_target, key) { resolve(); return Reflect.has(target, key); },
    set(_target, key, value) { resolve(); return Reflect.set(target, key, value); },
    defineProperty(_target, key, descriptor) { resolve(); return Reflect.defineProperty(target, key, descriptor); },
    deleteProperty(_target, key) { resolve(); return Reflect.deleteProperty(target, key); },
    preventExtensions() { resolve(); return Reflect.preventExtensions(target); },
  });
  if (deferZodMethods) concreteSchemaResolvers.set(definition, resolve);
  return definition;
}
