/**
 * Protocol-internal bridge for legacy Zod parents.
 *
 * The public composable remains a neutral five-member value. This bridge is
 * deliberately not exported from a package entry point: it delegates parsing
 * and normalization straight back to that public value while an incumbent
 * internal Zod parent is migrated.
 */
import { z } from 'zod';
import * as mini from 'zod/mini';
import { rehydrateCanonicalProtocolComposableSchema } from './protocolComposableSchema.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';

import type {
  ProtocolSchemaSafeParseResult,
} from './jsonSchemaValidation.js';

/**
 * This private bridge receives the neutral parser surface structurally. The
 * typed parser signature is deliberately separate from the broad public
 * admission overload so Zod parents retain concrete input/output projections
 * without publishing a validator identity or leaking private aliases into
 * generated SDK declarations.
 */
type ProtocolComposableSchemaForZod<TInput, TOutput> = Readonly<{
  readonly jsonSchema: object;
  parse(value: TInput): TOutput;
  safeParse(value: unknown): ProtocolSchemaSafeParseResult<TOutput>;
  optional(): unknown;
  nullable(): unknown;
}>;

// Catalog parents repeatedly compose the same immutable neutral definitions.
// Share their one facade by definition identity, never by JSON document shape.
const protocolZodFacades = new WeakMap<object, z.ZodType>();

export function asProtocolZod<TInput, TOutput>(
  schema: ProtocolComposableSchemaForZod<TInput, TOutput>,
): z.ZodType<TOutput, TInput> {
  const existing = protocolZodFacades.get(schema);
  // Each definition identity fixes the input/output projections of its facade.
  if (existing) return existing as z.ZodType<TOutput, TInput>;
  // This bridge exposes only ZodType, so Zod's native lazy combinator can
  // retain the actual adapter identity used by recursive JSON Schema exports.
  const facade = z.lazy(() => {
    // Keep refinement-before-transform: parent refinements explicitly opting
    // into failed admission must observe the original input, not NEVER.
    const createAdapter = (safeParse: (value: unknown) => ProtocolSchemaSafeParseResult<TOutput>) => {
      const admitted = mini.custom<TInput>().check(mini.superRefine((value, context) => {
        const parsed = safeParse(value);
        if (!parsed.success) {
          context.addIssue({
            code: 'custom',
            message: parsed.error.issues[0]?.message ?? 'Value does not match the canonical Protocol schema',
          });
        }
      }));
      const adapter = mini.pipe(admitted, mini.transform((value: TInput): TOutput => {
        const parsed = safeParse(value);
        if (!parsed.success) throw parsed.error;
        return parsed.data;
      }));
      return adapter;
    };
    const adapter = createAdapter((value) => schema.safeParse(value));

    const storedJsonSchema = () => {
      // Derive the stored policy from the DSL's own projection, never a second validator.
      // The canonical DTO is strict ordinary JSON. Keep stored parsing usable
      // in hosts without the structured-clone Web API, with no new polyfill.
      const projection = JSON.parse(JSON.stringify(schema.jsonSchema)) as object;
      const openObjects = (raw: unknown): void => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const value = raw as Record<string, unknown>;
        if (value.type === 'object' && value.properties) value.additionalProperties = true;
        for (const key of ['properties', 'definitions', '$defs']) {
          const children = value[key];
          if (children && typeof children === 'object' && !Array.isArray(children)) Object.values(children).forEach(openObjects);
        }
        for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(value[key])) value[key].forEach(openObjects);
        openObjects(value.items);
      };
      openObjects(projection);
      const stored = rehydrateCanonicalProtocolComposableSchema(projection);
      if (!stored) throw new Error('Stored Protocol projection is not a canonical composable schema');
      return stored;
    };

    // Zod cannot infer the portable schema hidden behind this neutral adapter.
    // Project the canonical Protocol-owned JSON Schema into exporters so public
    // authoring schemas retain the same admission constraints as runtime.
    adapter._zod.processJSONSchema = (_context, jsonSchema) => {
      Object.assign(jsonSchema, structuredClone(schema.jsonSchema));
    };

    return defineStoredReadProjection<z.core.$ZodType<TOutput, TInput>>(adapter, () => {
      // The incumbent portable-schema owner already derives additive-open/drop
      // readers; keep its constraints rather than introducing another validator.
      const stored = storedJsonSchema();
      return createAdapter((value) => {
        const projected = stored.safeParse(value);
        // Re-admit the normalized projection through its typed canonical owner.
        // A generic JSON projection alone cannot establish TOutput.
        return projected.success ? schema.safeParse(projected.data) : projected;
      });
    });
  });
  protocolZodFacades.set(schema, facade);
  return facade;
}
