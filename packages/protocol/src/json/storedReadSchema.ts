import * as z from 'zod/mini';

import { getResolvedLazyDefinitionSource, lazyDefinition } from '../lazyZodSchema.js';

const reads = new WeakMap<z.core.$ZodType, z.core.$ZodType>();
const customReads = new WeakMap<z.core.$ZodType, () => z.core.$ZodType>();

/** Custom parsers supply their read projection at their existing owner. */
export function defineStoredReadProjection<T extends z.core.$ZodType>(schema: T, read: () => z.core.$ZodType<z.core.output<T>>): T {
  customReads.set(schema, read);
  return schema;
}

/**
 * Persistence-only projection of the canonical schema. Known-field checks,
 * refinements and transforms remain intact; unknown object fields are dropped.
 * Never use this at request, Action, event or write admission boundaries.
 * Zod 4's documented core definitions keep this derivation at one owner.
 */
export function createStoredReadSchema<T extends z.core.$ZodType>(schema: T): T {
  const admitted = reads.get(schema);
  if (admitted) return admitted as T;
  // Native composition can return the concrete schema behind a resolved lazy
  // definition. Share their reader unless the concrete schema owns a distinct
  // explicitly registered read contract.
  const source = getResolvedLazyDefinitionSource(schema);
  const ownCustom = customReads.get(schema);
  const identity = source && !ownCustom ? source : schema;
  const cached = reads.get(identity);
  if (cached) {
    reads.set(schema, cached);
    return cached as T;
  }
  // Registration after this admission must not replace the selected read contract.
  const custom = ownCustom ?? (source && customReads.get(source));
  const read = lazyDefinition(() => deriveStoredReadSchema(identity, custom), identity);
  reads.set(identity, read);
  reads.set(schema, read);
  return read as T;
}

function deriveStoredReadSchema<T extends z.core.$ZodType>(schema: T, custom: (() => z.core.$ZodType) | undefined): T {
  if (custom) {
    const read = custom();
    return read as T;
  }
  const def = (schema as unknown as z.core.$ZodTypes)._zod.def;
  // Children share this same identity/lifetime owner. Eager recursive cloning
  // would admit untouched defaults while projecting their containing object.
  let overrides: Record<string, unknown>;
  switch (def.type) {
    case 'object':
      overrides = {
        shape: Object.fromEntries(Object.entries(def.shape).map(([key, value]) => [key, createStoredReadSchema(value)])),
        // A genuine catchall describes data fields (for example a JSON bag).
        // Closed and passthrough objects both drop undeclared fields on read.
        catchall: ['never', 'unknown', 'any'].includes(def.catchall?._zod.def.type ?? '') ? undefined
          : def.catchall && createStoredReadSchema(def.catchall),
      };
      break;
    case 'array': overrides = { element: createStoredReadSchema(def.element) }; break;
    case 'record': overrides = { keyType: createStoredReadSchema(def.keyType), valueType: createStoredReadSchema(def.valueType) }; break;
    case 'union': overrides = { options: def.options.map(createStoredReadSchema) }; break;
    case 'intersection': overrides = { left: createStoredReadSchema(def.left), right: createStoredReadSchema(def.right) }; break;
    case 'tuple': overrides = { items: def.items.map(createStoredReadSchema), rest: def.rest ? createStoredReadSchema(def.rest) : null }; break;
    case 'optional': case 'nullable': case 'default': case 'prefault': case 'nonoptional': case 'readonly': case 'catch':
      overrides = { innerType: createStoredReadSchema(def.innerType) }; break;
    case 'pipe': overrides = { in: createStoredReadSchema(def.in), out: createStoredReadSchema(def.out) }; break;
    // Native lazy parsing caches this inner definition. Calling def.getter()
    // again would build a second source graph instead of projecting that one.
    case 'lazy': overrides = {
      getter: () => createStoredReadSchema((schema as unknown as z.core.$ZodLazy)._zod.innerType),
      // Native lazy clones cache their inner schema on the definition. A warm
      // canonical cache would bypass this reader's projected getter entirely.
      _cachedInner: undefined,
    }; break;
    default: return schema;
  }
  // Spreading the definition would evaluate native default/prefault getters
  // during construction and cache their values across later reads.
  const readDefinition = Object.defineProperties({ type: def.type }, {
    ...Object.getOwnPropertyDescriptors(def),
    ...Object.getOwnPropertyDescriptors(overrides),
  });
  const read = z.core.clone(schema, readDefinition);
  // Structural clones preserve the canonical output and parser class.
  return read as T;
}
