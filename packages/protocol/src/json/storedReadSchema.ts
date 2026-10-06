import { z } from 'zod';

import { lazyDefinition } from '../lazyZodSchema.js';

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
  const cached = reads.get(schema);
  if (cached) return cached as T;
  // Registration after this admission must not replace the selected read contract.
  const custom = customReads.get(schema);
  const read = lazyDefinition(() => deriveStoredReadSchema(schema, custom));
  reads.set(schema, read);
  return read as T;
}

function deriveStoredReadSchema<T extends z.core.$ZodType>(schema: T, custom: (() => z.core.$ZodType) | undefined): T {
  if (custom) {
    const read = custom();
    return read as T;
  }
  const def = (schema as unknown as z.core.$ZodTypes)._zod.def;
  let overrides: Record<string, unknown>;
  switch (def.type) {
    case 'object':
      overrides = {
        shape: Object.fromEntries(Object.entries(def.shape).map(([key, value]) => [key, deriveStoredReadChildSchema(value)])),
        // A genuine catchall describes data fields (for example a JSON bag).
        // Closed and passthrough objects both drop undeclared fields on read.
        catchall: ['never', 'unknown', 'any'].includes(def.catchall?._zod.def.type ?? '') ? undefined
          : def.catchall && deriveStoredReadChildSchema(def.catchall),
      };
      break;
    case 'array': overrides = { element: deriveStoredReadChildSchema(def.element) }; break;
    case 'record': overrides = { keyType: deriveStoredReadChildSchema(def.keyType), valueType: deriveStoredReadChildSchema(def.valueType) }; break;
    case 'union': overrides = { options: def.options.map(deriveStoredReadChildSchema) }; break;
    case 'intersection': overrides = { left: deriveStoredReadChildSchema(def.left), right: deriveStoredReadChildSchema(def.right) }; break;
    case 'tuple': overrides = { items: def.items.map(deriveStoredReadChildSchema), rest: def.rest ? deriveStoredReadChildSchema(def.rest) : null }; break;
    case 'optional': case 'nullable': case 'default': case 'prefault': case 'nonoptional': case 'readonly': case 'catch':
      overrides = { innerType: deriveStoredReadChildSchema(def.innerType) }; break;
    case 'pipe': overrides = { in: deriveStoredReadChildSchema(def.in), out: deriveStoredReadChildSchema(def.out) }; break;
    case 'lazy': overrides = { getter: () => deriveStoredReadChildSchema(def.getter()) }; break;
    default: return schema;
  }
  const read = z.core.clone(schema, { ...def, ...overrides });
  // Structural clones preserve the canonical output and parser class.
  return read as T;
}

function deriveStoredReadChildSchema<T extends z.core.$ZodType>(schema: T): T {
  const cached = reads.get(schema);
  if (cached) return cached as T;
  const read = deriveStoredReadSchema(schema, customReads.get(schema));
  if (read !== schema) reads.set(schema, read);
  return read;
}
