import { core, globalRegistry, lazy } from 'zod/mini';

const PARSE_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
type DefinitionLifetime = {
  readonly resolve: () => object;
  readonly canonicalZodIdentity: boolean;
  readonly nativeZodSchema: boolean;
  parserSchema?: core.$ZodType;
};
const definitionLifetimes = new WeakMap<object, DefinitionLifetime>();
const resolvedDefinitionSources = new WeakMap<object, object>();

/** @internal Fluent composition may retain the concrete identity of this same definition. */
export function getResolvedLazyDefinitionSource<TDefinition extends object>(definition: TDefinition): TDefinition | undefined {
  return resolvedDefinitionSources.get(definition) as TDefinition | undefined;
}

/** Internal native-parser handle; framework reflection must not admit a definition. */
export function deferZodSchemaForParser(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return schema;
  const lifetime = definitionLifetimes.get(schema);
  if (!lifetime?.nativeZodSchema) return schema;
  // One handle belongs to the existing definition lifetime, not each route,
  // registration or request. Native and non-schema values pass through intact.
  return lifetime.parserSchema ??= lazy(() => schema as core.$ZodType);
}

/** Keeps the concrete Core/Mini schema identity while admitting construction on demand. */
export function lazyZodSchema<TSchema extends core.$ZodType>(create: () => TSchema): TSchema {
  return createLazyDefinition(create, true);
}

/** A catalog's derived artifact is admitted by the same definition lifetime. */
export function lazyDefinition<TDefinition extends object>(create: () => TDefinition): TDefinition;
export function lazyDefinition<TSchema extends core.$ZodType>(
  create: () => TSchema,
  schemaSource: core.$ZodType,
): TSchema;
export function lazyDefinition<TDefinition extends object>(
  create: () => TDefinition,
  schemaSource?: core.$ZodType,
): TDefinition {
  return createLazyDefinition(create, false, schemaSource !== undefined);
}

function createLazyDefinition<TSchema extends object>(
  create: () => TSchema,
  canonicalZodIdentity: boolean,
  nativeZodSchema = canonicalZodIdentity,
): TSchema {
  const target = {} as TSchema;
  let schema: TSchema | undefined;
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const resolve = (): TSchema => {
    if (!schema) {
      const created = create();
      // A deferred composition may return another facade from this owner.
      // Resolve it before inspecting its prototype, since reflection stays
      // cold. Copy the actual schema's prototype and internals together.
      const createdLifetime = definitionLifetimes.get(created);
      const concrete = (createdLifetime
        ? createdLifetime.resolve() : created) as TSchema;
      Object.setPrototypeOf(target, Object.getPrototypeOf(concrete));
      const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(concrete);
      const concreteSchema = concrete instanceof core.$ZodType ? concrete : undefined;
      if (concreteSchema && canonicalZodIdentity && !resolvedDefinitionSources.has(concreteSchema)) {
        resolvedDefinitionSources.set(concreteSchema, definition);
      }
      if (concreteSchema) {
        // Projection processors close over the concrete instance. Construction
        // deferral is not a new schema wrapper: share its traversal identity so
        // recursive definitions and refinements do not gain extra references.
        // Inherit all other internals, including lazy getters and the parser.
        const processJSONSchema: NonNullable<core.$ZodType['_zod']['processJSONSchema']> = (context, json, params) => {
          if (!canonicalZodIdentity) {
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
      Object.defineProperties(target, descriptors);
      schema = concrete;
      if (concreteSchema && canonicalZodIdentity) {
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
      // Native parse getters now memoize on first access. Retain the existing
      // cached invocation for frozen facades without prewarming every member.
      if (canonicalZodIdentity && typeof key === 'string'
        && ((!schema && (key === 'check' || key === 'with'))
          || (PARSE_METHODS.has(key) && (!schema || !Object.hasOwn(target, key))))) {
        let method = methods.get(key);
        if (!method) {
          method = key === 'check' || key === 'with'
            ? (...args) => lazyZodSchema(() => invoke(key, args) as core.$ZodType)
            : (...args) => invoke(key, args);
          methods.set(key, method);
        }
        return method;
      }
      resolve();
      // Native Zod getters bind and memoize methods on their receiver. Keep
      // fluent parents attached to the public facade, never its hidden target.
      return Reflect.get(target, key, definition);
    },
    ownKeys() { resolve(); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(_target, key) { resolve(); return Reflect.getOwnPropertyDescriptor(target, key); },
    has(_target, key) { resolve(); return Reflect.has(target, key); },
    set(_target, key, value) { resolve(); return Reflect.set(target, key, value); },
    defineProperty(_target, key, descriptor) { resolve(); return Reflect.defineProperty(target, key, descriptor); },
    deleteProperty(_target, key) { resolve(); return Reflect.deleteProperty(target, key); },
    preventExtensions() { resolve(); return Reflect.preventExtensions(target); },
  });
  definitionLifetimes.set(definition, { resolve, canonicalZodIdentity, nativeZodSchema });
  return definition;
}
