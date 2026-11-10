import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Routing is admitted by the Action catalog, before approval and transport. */
export function withClientActionInput(schema: z.ZodMiniType): z.ZodMiniType {
  return lazyZodSchema(() => {
    // Resolve deferred definitions before testing their native schema identity.
    const kind = schema._zod.def.type;
    if (kind === 'object') {
      const object = schema as z.ZodMiniObject;
      return z.safeExtend(object, { clientId: object.shape.clientId
        ?? z.optional(z.string().check(z.minLength(1))) });
    }
    if (kind === 'union') {
      const union = schema as z.ZodMiniUnion;
      return z.core.clone(union, { ...union._zod.def, options: union._zod.def.options.map(option => withClientActionInput(option as z.ZodMiniType)) });
    }
    if (kind === 'intersection') {
      const intersection = schema as z.ZodMiniIntersection;
      return z.core.clone(intersection, { ...intersection._zod.def,
        left: withClientActionInput(intersection._zod.def.left as z.ZodMiniType),
        right: withClientActionInput(intersection._zod.def.right as z.ZodMiniType) });
    }
    throw new Error(`Client Action input must declare an object: ${kind}`);
  });
}

/** The selector belongs to delivery, not a domain owner's strict input. */
export function withoutClientActionInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'clientId')) return input;
  const { clientId: _clientId, ...domain } = input as Record<string, unknown>;
  return domain;
}

/** Surface vocabulary binders must carry the caller's exact delivery choice. */
export function retainClientActionInput(input: unknown, bound: unknown): unknown {
  const clientId = input && typeof input === 'object' ? Reflect.get(input, 'clientId') : undefined;
  return typeof clientId === 'string' && bound && typeof bound === 'object' && !Array.isArray(bound)
    ? { ...bound, clientId } : bound;
}
