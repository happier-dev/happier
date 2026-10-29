import * as z from 'zod/mini';

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

/** @internal Visit subschemas without interpreting defaults, examples or other literal JSON as schemas. */
export function forEachJsonSchemaChild(node: JsonSchemaObject, visit: (child: unknown) => void): void {
  for (const keyword of ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']) {
    const children = node[keyword];
    if (isJsonSchemaObject(children)) Object.values(children).forEach(visit);
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const children = node[keyword];
    if (Array.isArray(children)) children.forEach(visit);
  }
  for (const keyword of ['not', 'if', 'then', 'else', 'items', 'contains', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames']) {
    const child = node[keyword];
    if (child === undefined) continue;
    // Draft-07 tuple items are an array of schemas; later drafts use prefixItems.
    if (keyword === 'items' && Array.isArray(child)) child.forEach(visit);
    else visit(child);
  }
}

function projectPortableSchemaKeywords(value: unknown): void {
  if (!isJsonSchemaObject(value)) return;
  const node = value as Record<string, unknown>;
  // Native readonly freezes parsed values, not portable inputs. Normalize the
  // finished document so embedded fragments follow the same rule, while the
  // schema-only walker preserves literal data and properties named readOnly.
  delete node.readOnly;
  if (Array.isArray(node.type)) {
    // Zod 4.6 compacts unions after its override callback. Keep the existing
    // single-type Plugin vocabulary without changing the union's semantics.
    const union = { anyOf: node.type.map(type => ({ type })) };
    delete node.type;
    if (node.anyOf === undefined) node.anyOf = union.anyOf;
    else node.allOf = [...(Array.isArray(node.allOf) ? node.allOf : []), union];
  }
  forEachJsonSchemaChild(node, projectPortableSchemaKeywords);
}

// Zod 4.6 emits these check names as formats as well as their complete pattern
// constraints. They are not JSON Schema formats; keep the patterns portable.
const patternOnlyStringChecks = new Set(['starts_with', 'ends_with', 'includes', 'lowercase', 'uppercase']);

/**
 * Uses Zod's canonical JSON Schema projection, shared with public manifest
 * and contribution-schema tooling. Action schemas are parser contracts, so
 * their advertised shape is always the canonical input projection.
 */
export function zodSchemaToJsonSchemaObject(
  schema: z.core.$ZodType,
  options?: Readonly<{ target?: 'draft-2020-12' | 'draft-7'; reused?: 'inline' | 'ref'; unrepresentable?: 'throw' | 'any'; override?: z.core.ToJSONSchemaParams['override'] }>,
): JsonSchemaObject {
  try {
    // The top-level projector supplies native processors for genuine Mini/Core
    // children; an instance method only carries its Classic processors.
    const projectedSchema = z.toJSONSchema(schema, {
      io: 'input',
      target: options?.target ?? 'draft-2020-12',
      reused: options?.reused ?? 'inline',
      unrepresentable: options?.unrepresentable ?? 'throw',
      override: context => {
        options?.override?.(context);
        const { jsonSchema } = context;
        if (typeof jsonSchema.format === 'string' && patternOnlyStringChecks.has(jsonSchema.format)
          && (typeof jsonSchema.pattern === 'string' || jsonSchema.allOf?.some(part => typeof part.pattern === 'string'))) {
          delete jsonSchema.format;
        }
      },
    });
    if (!isJsonSchemaObject(projectedSchema)) {
      throw new ActionJsonSchemaProjectionError('Zod produced a non-object JSON Schema');
    }

    projectPortableSchemaKeywords(projectedSchema);

    // Zod decorates the root with non-enumerable Standard Schema methods. They
    // are useful on Zod values but are not JSON and cross realm boundaries
    // (notably voice-tool catalogs) as function-bearing metadata. Keep the
    // portable JSON Schema fields after the projection override.
    return Object.fromEntries(Object.entries(projectedSchema));
  } catch (error) {
    if (error instanceof ActionJsonSchemaProjectionError) throw error;
    const reason = error instanceof Error ? error.message : 'Zod projection failed';
    throw new ActionJsonSchemaProjectionError(reason);
  }
}
