/** Protocol-internal Mini projection of the neutral composable schema. */
import * as mini from 'zod/mini';
import { createProtocolComposableSchema, createProtocolStoredReadSchema, embedProtocolJsonSchema, normalizePluginJsonSchema, projectProtocolStoredReadJsonSchema, ProtocolValidationError, type ProtocolComposableSchema, type ProtocolJsonValue } from './protocolComposableSchema.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';

import type {
  ProtocolSchemaSafeParseResult,
} from './jsonSchemaValidation.js';

/**
 * Projects an incumbent parser; domain validation and JSON derivation stay with
 * that owner. Successful output also passed the composable owner's strict JSON
 * normalization, even when the native schema carries opaque internal values.
 */
export function projectZodProtocolSchema<TSchema extends mini.core.$ZodType>(
  schema: TSchema,
): ProtocolComposableSchema<mini.input<TSchema>, mini.output<TSchema> & ProtocolJsonValue>;
export function projectZodProtocolSchema<TSchema extends mini.core.$ZodType>(
  schema: TSchema,
): ProtocolComposableSchema<mini.input<TSchema>, mini.output<TSchema>> {
  // Importing a projection must not force an otherwise lazy domain graph.
  let projection: ProtocolComposableSchema<mini.input<TSchema>, mini.output<TSchema>> | undefined;
  const readProjection = () => projection ??= createProtocolComposableSchema<mini.input<TSchema>, mini.output<TSchema>>(
      zodSchemaToJsonSchemaObject(schema, { target: 'draft-7' }),
      input => {
        const parsed = mini.safeParse(schema, input);
        return parsed.success
          ? { success: true, data: parsed.data }
          : { success: false, error: new ProtocolValidationError(parsed.error.issues.map(issue => ({
            code: issue.code,
            message: issue.message,
            path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number'),
          }))) };
      },
    );
  return Object.freeze({
    get jsonSchema() { return readProjection().jsonSchema; },
    parse(value: unknown) { return readProjection().parse(value); },
    safeParse(value: unknown) { return readProjection().safeParse(value); },
    optional() { return readProjection().optional(); },
    nullable() { return readProjection().nullable(); },
  });
}

/**
 * This private adapter receives the neutral parser surface structurally. Its
 * typed signature retains concrete input/output projections without publishing
 * a validator identity through the neutral authoring API.
 */
type ProtocolComposableSchemaForZod<TInput, TOutput> = Readonly<{
  readonly jsonSchema: object;
  parse(value: TInput): TOutput;
  safeParse(value: unknown): ProtocolSchemaSafeParseResult<TOutput>;
  optional(): unknown;
  nullable(): unknown;
}>;

// Catalog parents repeatedly compose the same immutable neutral definitions.
// Share their one adapter by definition identity, never by JSON document shape.
const protocolZodFacades = new WeakMap<object, mini.ZodMiniType>();

export function asProtocolZod<TInput, TOutput>(
  schema: ProtocolComposableSchemaForZod<TInput, TOutput>,
): mini.ZodMiniType<TOutput, TInput> {
  const existing = protocolZodFacades.get(schema);
  // Each definition identity fixes the input/output projections of its adapter.
  if (existing) return existing as mini.ZodMiniType<TOutput, TInput>;
  const facade = mini.lazy(() => {
    const createAdapter = (safeParse: (value: unknown) => ProtocolSchemaSafeParseResult<TOutput>, projectJsonSchema: () => object) => {
      // A native transform alone advertises optional input. The custom input
      // boundary retains requiredness; only the final transform can refuse.
      const adapter = mini.pipe(mini.custom<TInput>(), mini.transform<TInput, TOutput>((value, context) => {
        const parsed = safeParse(value);
        if (parsed.success) return parsed.data;
        context.issues.push({
          code: 'custom',
          input: value,
          message: parsed.error.issues[0]?.message ?? 'Value does not match the canonical Protocol schema',
        });
        // Admission has failed. Preserve its original input for parent checks
        // explicitly opting in; no rejected value can become a parsed output.
        return value as unknown as TOutput;
      }));
      // Each native adapter projects its own canonical write or stored-read
      // document only when a JSON exporter actually traverses it.
      adapter._zod.processJSONSchema = (_context, jsonSchema, params) => {
        // This is a fragment of the parent's document. Its exporter owns the
        // root dialect; the neutral owner stays an unchanged draft-07 document.
        const { $schema: _dialect, ...fragment } = normalizePluginJsonSchema(projectJsonSchema());
        Object.assign(jsonSchema, embedProtocolJsonSchema(fragment, params.path));
      };
      return adapter;
    };
    const adapter = createAdapter((value) => schema.safeParse(value), () => structuredClone(schema.jsonSchema));

    return defineStoredReadProjection<mini.core.$ZodType<TOutput, TInput>>(adapter, () => {
      // The incumbent portable-schema owner already derives additive-open/drop
      // readers; keep its constraints rather than introducing another validator.
      const stored = createProtocolStoredReadSchema(schema);
      return createAdapter((value) => stored.safeParse(value), () => projectProtocolStoredReadJsonSchema(schema.jsonSchema).document);
    });
  });
  protocolZodFacades.set(schema, facade);
  return facade;
}
