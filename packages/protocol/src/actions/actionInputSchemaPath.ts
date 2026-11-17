import { z } from '../zodRuntimePolicy.js';

import type { ActionSpec } from './actionSpecs.js';

/**
 * Peels the wrappers that decorate an Action input field schema without changing
 * which value it describes, reporting whether any of them admits absence or null.
 */
export function unwrapActionInputSchema(
  schema: z.core.$ZodType,
): Readonly<{ schema: z.core.$ZodType; optional: boolean; nullable: boolean }> {
  let current = schema;
  let optional = false;
  let nullable = false;

  for (;;) {
    if (current instanceof z.ZodMiniOptional) {
      optional = true;
      current = current._zod.def.innerType as z.ZodMiniType;
      continue;
    }
    if (current instanceof z.ZodMiniDefault) {
      optional = true;
      current = current._zod.def.innerType as z.ZodMiniType;
      continue;
    }
    if (current instanceof z.ZodMiniNullable) {
      nullable = true;
      current = current._zod.def.innerType as z.ZodMiniType;
      continue;
    }
    if (current instanceof z.ZodMiniPipe) {
      // A preprocessing transform has no fields; its output owns the input
      // structure and defaults presented by Action authoring surfaces.
      current = (current._zod.def.in instanceof z.ZodMiniTransform
        ? current._zod.def.out : current._zod.def.in) as z.ZodMiniType;
      continue;
    }
    break;
  }

  return { schema: current, optional, nullable };
}

/**
 * Whether the Action's own input schema declares `null` as a value of the field
 * at `path` — a stated "none" (for example `expectedItemRevision: null` requesting
 * creation), as distinct from context that is absent. A path the schema does not
 * describe structurally answers `false`.
 */
export function actionInputFieldAcceptsNull(
  spec: Pick<ActionSpec, 'inputSchema'>,
  path: string,
): boolean {
  const segments = path.split('.').map((part) => part.trim()).filter(Boolean);
  const acceptsNull = (schema: z.core.$ZodType, index: number): boolean => {
    if (index === segments.length) return z.safeParse(schema, null).success;
    const inner = unwrapActionInputSchema(schema).schema;
    if (inner instanceof z.ZodMiniUnion) return inner._zod.def.options.some((option) => acceptsNull(option, index));
    const segment = segments[index];
    if (segment === '[]') {
      if (!(inner instanceof z.ZodMiniArray)) return false;
      return acceptsNull(inner._zod.def.element as z.ZodMiniType, index + 1);
    }
    if (!(inner instanceof z.ZodMiniObject)) return false;
    const field = (inner.shape as Record<string, z.ZodMiniType | undefined>)[segment!];
    return field !== undefined && acceptsNull(field, index + 1);
  };
  return spec.inputSchema !== undefined && acceptsNull(spec.inputSchema as z.ZodMiniType, 0);
}
