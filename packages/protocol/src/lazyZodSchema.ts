import './zodRuntimePolicy.js';
import { core, globalRegistry, lazy } from './zodRuntimePolicy.js';

const PARSE_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
type DefinitionLifetime = {
  readonly resolve: () => object;
  readonly resolvedValue?: object;
  readonly canonicalZodIdentity: boolean;
  readonly nativeZodSchema: boolean;
  parserSchema?: core.$ZodType;
};
const definitionLifetimes = new WeakMap<object, DefinitionLifetime>();
const resolvedDefinitionSources = new WeakMap<object, object>();

/** @internal Resolve method receivers to their admitted value without warming cold definitions. */
export function getResolvedLazyDefinitionValue<TDefinition extends object>(definition: TDefinition): TDefinition {
  return (definitionLifetimes.get(definition)?.resolvedValue ?? definition) as TDefinition;
}

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
  return new LazyDefinitionState(create, canonicalZodIdentity, nativeZodSchema).definition;
}

// Proxy handlers are shared prototype methods. Each definition retains state,
// not a fresh set of trap closures and its already-consumed constructor graph.
class LazyDefinitionState<TSchema extends object> implements ProxyHandler<TSchema> {
  readonly target = {} as TSchema;
  readonly definition: TSchema;
  private schema: TSchema | undefined;
  private methods: Map<PropertyKey, (...args: unknown[]) => unknown> | undefined;
  parserSchema?: core.$ZodType;

  constructor(
    private create: (() => TSchema) | undefined,
    readonly canonicalZodIdentity: boolean,
    readonly nativeZodSchema: boolean,
  ) {
    this.definition = new Proxy(this.target, this);
    definitionLifetimes.set(this.definition, this);
  }

  get resolvedValue(): TSchema | undefined { return this.schema; }

  resolve(): TSchema {
    if (!this.schema) {
      const create = this.create!;
      const created = create();
      // A deferred composition may return another facade from this owner.
      // Resolve it before inspecting its prototype, since reflection stays
      // cold. Copy the actual schema's prototype and internals together.
      const createdLifetime = definitionLifetimes.get(created);
      const concrete = (createdLifetime
        ? createdLifetime.resolve() : created) as TSchema;
      Object.setPrototypeOf(this.target, Object.getPrototypeOf(concrete));
      const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(concrete);
      const concreteSchema = concrete instanceof core.$ZodType ? concrete : undefined;
      if (concreteSchema && this.canonicalZodIdentity && !resolvedDefinitionSources.has(concreteSchema)) {
        resolvedDefinitionSources.set(concreteSchema, this.definition);
      }
      // Core/Mini processors use the native walker's facade directly. Only
      // instance-bound hooks need the scoped concrete-to-facade identity view.
      if (concreteSchema && (!this.canonicalZodIdentity || concreteSchema._zod.processJSONSchema)) {
        // Projection processors close over the concrete instance. Construction
        // deferral is not a new schema wrapper: share its traversal identity so
        // recursive definitions and refinements do not gain extra references.
        // Inherit all other internals, including lazy getters and the parser.
        const processJSONSchema: NonNullable<core.$ZodType['_zod']['processJSONSchema']> = (context, json, params) => {
          if (!this.canonicalZodIdentity) {
            context.seen.delete(this.definition as unknown as core.$ZodType);
            core.process(concreteSchema, context, {
              ...params,
              schemaPath: params.schemaPath.map(item => item === this.definition ? concreteSchema : item),
            });
            context.seen.set(this.definition as unknown as core.$ZodType, context.seen.get(concreteSchema)!);
            return;
          }
          // Canonical schemas keep their public facade as the native walker's
          // sole identity. Bound hooks see that same record through the concrete
          // instance they capture, without a second ancestry/metadata walk.
          const facade = this.definition as unknown as core.$ZodType;
          const records = new Set<core.Seen>();
          const trackRecord = (record: core.Seen | undefined) => {
            if (record) records.add(record);
            return record;
          };
          const nativeSeen = context.seen;
          const seen = new Proxy(nativeSeen, {
            get: (target, field) => {
              const translate = (schema: core.$ZodType) => schema === concreteSchema ? facade : schema;
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
          context.seen = seen;
          try {
            trackRecord(nativeSeen.get(facade));
            concreteSchema._zod.processJSONSchema!(context, json, {
              ...params, schemaPath: [...params.schemaPath, concreteSchema],
            });
          } finally {
            context.seen = nativeSeen;
            // Native hooks settle refs synchronously; the finalizer must read
            // facade edges without replacing records held by reentrant hooks.
            for (const record of records) {
              if (record.ref === concreteSchema) record.ref = facade;
            }
          }
        };
        descriptors._zod = {
          ...descriptors._zod,
          value: Object.create(concreteSchema._zod, {
            processJSONSchema: { value: processJSONSchema },
          }),
        };
      }
      Object.defineProperties(this.target, descriptors);
      this.schema = concrete;
      this.create = undefined;
      if (concreteSchema && this.canonicalZodIdentity) {
        // Zod stores annotations by instance identity, outside the definition.
        // The public facade must carry those annotations as well as its fields.
        const metadata = globalRegistry.get(concreteSchema);
        if (metadata) globalRegistry.add(this.definition as unknown as core.$ZodType, metadata);
      }
    }
    return this.schema;
  }

  private invoke(key: PropertyKey, args: unknown[]): unknown {
    const concrete = this.resolve();
    const method: unknown = Reflect.get(concrete, key);
    if (typeof method !== 'function') throw new TypeError(`Invalid Zod method: ${String(key)}`);
    return Reflect.apply(method, concrete, args);
  }

  get(_target: TSchema, key: PropertyKey): unknown {
    // Fast Refresh probes every exported value before cyclic importers finish.
    // React's component marker is not schema access and must keep definitions cold.
    if (!this.schema && this.nativeZodSchema && key === '$$typeof') return undefined;
    // Native parse getters now memoize on first access. Retain the existing
    // cached invocation for frozen facades without prewarming every member.
    if (this.canonicalZodIdentity && typeof key === 'string'
      && ((!this.schema && (key === 'check' || key === 'with'))
        || (PARSE_METHODS.has(key) && (!this.schema || !Object.hasOwn(this.target, key))))) {
      const methods = this.methods ??= new Map<PropertyKey, (...args: unknown[]) => unknown>();
      let method = methods.get(key);
      if (!method) {
        method = key === 'check' || key === 'with'
          ? (...args: unknown[]) => lazyZodSchema(() => this.invoke(key, args) as core.$ZodType)
          : (...args: unknown[]) => this.invoke(key, args);
        methods.set(key, method);
      }
      return method;
    }
    this.resolve();
    // Native Zod getters bind and memoize methods on their receiver. Keep
    // fluent parents attached to the public facade, never its hidden target.
    return Reflect.get(this.target, key, this.definition);
  }
  ownKeys() { this.resolve(); return Reflect.ownKeys(this.target); }
  getOwnPropertyDescriptor(_target: TSchema, key: PropertyKey) { this.resolve(); return Reflect.getOwnPropertyDescriptor(this.target, key); }
  has(_target: TSchema, key: PropertyKey) { this.resolve(); return Reflect.has(this.target, key); }
  set(_target: TSchema, key: PropertyKey, value: unknown) { this.resolve(); return Reflect.set(this.target, key, value); }
  defineProperty(_target: TSchema, key: PropertyKey, descriptor: PropertyDescriptor) { this.resolve(); return Reflect.defineProperty(this.target, key, descriptor); }
  deleteProperty(_target: TSchema, key: PropertyKey) { this.resolve(); return Reflect.deleteProperty(this.target, key); }
  preventExtensions() { this.resolve(); return Reflect.preventExtensions(this.target); }
}
