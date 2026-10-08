/**
 * Canonical owner of the AJV-backed plugin JSON Schema compiler and of the Zod
 * object adapter built on it.
 *
 * The composable-schema DSL and JSON Schema normalization live in
 * `protocolComposableSchema.ts` and are re-exported here unchanged: this module
 * stays the published `./plugins/actions/json-schema-validation` surface, while
 * consumers that only construct or parse schemas import the DSL module directly
 * and keep AJV out of their module graph.
 */
import type { ErrorObject } from 'ajv';
import { z } from 'zod';

import { compileProtocolJsonSchema } from './jsonSchemaCompiler.js';

import type { PluginJsonSchemaV2 } from '../contributions/jsonSchema.js';
import {
  isValidPluginJsonSchemaValue,
  normalizePluginJsonSchema,
  type PluginJsonSchemaValidator,
} from './protocolComposableSchema.js';

// The composable-schema surface is re-exported name-for-name so this module's
// published subpath keeps the exact contract it had before the compiler split.
export {
  cloneStrictPluginJsonValue,
  containsEquivalentPluginJsonValue,
  defineProtocolArray,
  defineProtocolJsonValue,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  defineProtocolUniqueArray,
  defineProtocolUtf8String,
  isValidPluginJsonSchemaValue,
  measurePluginJsonUtf8Bytes,
  measureSerializedStrictPluginJsonUtf8Bytes,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
  normalizePluginJsonSchema,
  pluginJsonValuesEqual,
  ProtocolValidationError,
  rehydrateCanonicalProtocolComposableSchema,
} from './protocolComposableSchema.js';
export type {
  PluginJsonSchema,
  PluginJsonSchemaValidator,
  ProtocolArrayOptions,
  ProtocolComposableSchema,
  ProtocolJsonValue,
  ProtocolJsonValueOptions,
  ProtocolNumberOptions,
  ProtocolObjectEvolutionPolicy,
  ProtocolObjectOptions,
  ProtocolSchemaSafeParseResult,
  ProtocolStringOptions,
  ProtocolUniqueJsonArrayOptions,
  ProtocolUtf8StringOptions,
  ProtocolValidationIssue,
} from './protocolComposableSchema.js';

/**
 * The one normalized schema and executable validator prepared for a single
 * admitted schema lifetime in one JavaScript realm. The pair itself has no
 * registry or cache semantics; the caller owns retaining and retiring it.
 */
export type PreparedPluginJsonSchema = Readonly<{
  jsonSchema: PluginJsonSchemaV2;
  validate: PluginJsonSchemaValidator;
}>;

/**
 * Prepares one bounded canonical projection and compiles it once. Consumers
 * retain this pair at their admitted schema/generation lifecycle; this pure
 * helper deliberately does not cache across callers or runtimes.
 */
export function preparePluginJsonSchema(schema: object): PreparedPluginJsonSchema {
  const jsonSchema = normalizePluginJsonSchema(schema);
  return Object.freeze({
    jsonSchema,
    validate: compileProtocolJsonSchema(jsonSchema, 'draft-07'),
  });
}

export function compilePluginJsonSchema(schema: object): PluginJsonSchemaValidator {
  return preparePluginJsonSchema(schema).validate;
}

export type PluginJsonSchemaValueIssue = Readonly<{ pointer: string; message: string }>;

/** Projects the most recent AJV validation errors without exposing AJV in the public validator type. */
export function describePluginJsonSchemaValueIssues(
  validate: PluginJsonSchemaValidator,
): readonly PluginJsonSchemaValueIssue[] {
  // compilePluginJsonSchema returns an AJV callable; its error bag is an implementation boundary.
  const errors = (validate as PluginJsonSchemaValidator & { errors?: readonly ErrorObject[] | null }).errors;
  return (errors ?? []).map((error) => {
    const property = error.keyword === 'required'
      ? error.params.missingProperty
      : error.keyword === 'additionalProperties'
        ? error.params.additionalProperty
        : undefined;
    const suffix = typeof property === 'string' ? `/${property.replace(/~/g, '~0').replace(/\//g, '~1')}` : '';
    return { pointer: `${error.instancePath}${suffix}`, message: error.message ?? error.keyword };
  });
}

/**
 * Adapts the protocol-owned JSON Schema vocabulary to Zod consumers that
 * require an object schema, without making Zod a second schema-semantics owner.
 */
export function createPluginJsonSchemaZodObjectAdapter(schema: object) {
  const prepared = preparePluginJsonSchema(schema);
  const { jsonSchema: normalized, validate } = prepared;
  const adapter = z.object({}).passthrough().superRefine((value, ctx) => {
    if (!isValidPluginJsonSchemaValue(validate, value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Value does not match the plugin JSON Schema',
      });
    }
  });

  // The pinned Zod exporter exposes a processor hook for boundary adapters.
  // Copy a fresh protocol-validated value because the exporter mutates its
  // destination while adding the selected draft marker.
  adapter._zod.processJSONSchema = (_ctx, json) => {
    Object.assign(json, normalized);
    json.type = 'object';
  };
  return adapter;
}
