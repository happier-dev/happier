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
import Ajv from 'ajv';
import addFormats, { type FormatName } from 'ajv-formats';
import { z } from 'zod';

import {
  containsEquivalentPluginJsonValue,
  hasUniquePluginJsonValues,
  pluginJsonValuesEqual,
  scalarPluginJsonValueKey,
} from '../contributions/jsonSchemaValues.js';
import type { PluginJsonSchemaV2 } from '../contributions/jsonSchema.js';
import {
  assertStrictPluginJsonValue,
  measurePluginJsonUtf8Bytes,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../contributions/strictJsonValue.js';
import {
  HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD,
  HAPPIER_MAX_UTF8_BYTES_KEYWORD,
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

const SUPPORTED_PLUGIN_JSON_SCHEMA_FORMATS = Object.freeze([
  'date-time',
  'time',
  'date',
  'duration',
  'uri',
  'uri-reference',
  'uri-template',
  'url',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'regex',
  'uuid',
  'json-pointer',
  'relative-json-pointer',
] satisfies readonly FormatName[]);

/**
 * The one normalized schema and executable validator prepared for a single
 * admitted schema lifetime in one JavaScript realm. The pair itself has no
 * registry or cache semantics; the caller owns retaining and retiring it.
 */
export type PreparedPluginJsonSchema = Readonly<{
  jsonSchema: PluginJsonSchemaV2;
  validate: PluginJsonSchemaValidator;
}>;

function createPluginJsonEnumValidator(allowed: readonly unknown[]): PluginJsonSchemaValidator {
  const allowedScalars = new Set<string>();
  const allowedCompounds: unknown[] = [];
  for (const candidate of allowed) {
    const scalarKey = scalarPluginJsonValueKey(candidate);
    if (scalarKey !== undefined) {
      allowedScalars.add(scalarKey);
    } else {
      allowedCompounds.push(candidate);
    }
  }
  return (value: unknown) => {
    const scalarKey = scalarPluginJsonValueKey(value);
    return scalarKey === undefined
      ? containsEquivalentPluginJsonValue(allowedCompounds, value)
      : allowedScalars.has(scalarKey);
  };
}

function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, ownProperties: true, strict: false, validateSchema: false });
  addFormats(ajv, [...SUPPORTED_PLUGIN_JSON_SCHEMA_FORMATS]);
  ajv.removeKeyword('enum');
  ajv.addKeyword({
    keyword: 'enum',
    metaSchema: { type: 'array', minItems: 1 },
    compile: (allowed: unknown) => {
      if (!Array.isArray(allowed) || allowed.length === 0) {
        throw new Error('Plugin JSON Schema enum must contain at least one value');
      }
      if (!hasUniquePluginJsonValues(allowed)) {
        throw new Error('Plugin JSON Schema enum values must be unique');
      }
      return createPluginJsonEnumValidator(allowed);
    },
    errors: false,
  });
  ajv.removeKeyword('const');
  ajv.addKeyword({
    keyword: 'const',
    validate: (expected: unknown, value: unknown) => pluginJsonValuesEqual(expected, value),
    errors: false,
  });
  ajv.removeKeyword('uniqueItems');
  ajv.addKeyword({
    keyword: 'uniqueItems',
    type: 'array',
    schemaType: 'boolean',
    validate: (enabled: boolean, value: unknown) => (
      enabled !== true || (Array.isArray(value) && hasUniquePluginJsonValues(value))
    ),
    errors: false,
  });
  ajv.addKeyword({
    keyword: HAPPIER_MAX_UTF8_BYTES_KEYWORD,
    type: 'string',
    schemaType: 'number',
    metaSchema: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    validate: (maximumBytes: number, value: unknown) => {
      try {
        return typeof value === 'string' && measurePluginJsonUtf8Bytes(value, 'value') <= maximumBytes;
      } catch {
        return false;
      }
    },
    errors: false,
  });
  ajv.addKeyword({
    keyword: HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD,
    schemaType: 'number',
    metaSchema: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    validate: (maximumBytes: number, value: unknown) => {
      try {
        assertStrictPluginJsonValue(value, 'value');
        return measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'value', maximumBytes) <= maximumBytes;
      } catch {
        return false;
      }
    },
    errors: false,
  });
  return ajv;
}

function compileNormalizedPluginJsonSchema(
  jsonSchema: PluginJsonSchemaV2,
): PluginJsonSchemaValidator {
  return createAjv().compile(jsonSchema);
}

/**
 * Prepares one bounded canonical projection and compiles it once. Consumers
 * retain this pair at their admitted schema/generation lifecycle; this pure
 * helper deliberately does not cache across callers or runtimes.
 */
export function preparePluginJsonSchema(schema: object): PreparedPluginJsonSchema {
  const jsonSchema = normalizePluginJsonSchema(schema);
  return Object.freeze({
    jsonSchema,
    validate: compileNormalizedPluginJsonSchema(jsonSchema),
  });
}

export function compilePluginJsonSchema(schema: object): PluginJsonSchemaValidator {
  return preparePluginJsonSchema(schema).validate;
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
