import { z } from 'zod';

export type JsonSchemaObject = Readonly<Record<string, unknown>>;

/**
 * The Action catalog exports Zod's canonical JSON Schema projection. Callers
 * receive a stable, typed failure instead of a weakened object-shaped fallback
 * when Zod cannot represent a schema.
 */
export class ActionJsonSchemaProjectionError extends Error {
  readonly code: 'action_schema_unrepresentable' = 'action_schema_unrepresentable';

  constructor(reason: string) {
    super(`Action schema cannot be represented as JSON Schema: ${reason}`);
    this.name = 'ActionJsonSchemaProjectionError';
  }
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Uses Zod's canonical JSON Schema projection, shared with public manifest
 * and contribution-schema tooling. Action schemas are parser contracts, so
 * their advertised shape is always the canonical input projection.
 */
export function zodSchemaToJsonSchemaObject(
  schema: z.ZodTypeAny,
): JsonSchemaObject {
  try {
    const projectedSchema = schema.toJSONSchema({
      io: 'input',
      target: 'draft-2020-12',
      unrepresentable: 'throw',
    });
    if (!isJsonSchemaObject(projectedSchema)) {
      throw new ActionJsonSchemaProjectionError('Zod produced a non-object JSON Schema');
    }

    // Zod decorates the root with non-enumerable Standard Schema methods. They
    // are useful on Zod values but are not JSON and cross realm boundaries
    // (notably voice-tool catalogs) as function-bearing metadata. Keep the
    // canonical JSON Schema fields exactly as Zod projected them.
    return Object.fromEntries(Object.entries(projectedSchema));
  } catch (error) {
    if (error instanceof ActionJsonSchemaProjectionError) throw error;
    const reason = error instanceof Error ? error.message : 'Zod projection failed';
    throw new ActionJsonSchemaProjectionError(reason);
  }
}
