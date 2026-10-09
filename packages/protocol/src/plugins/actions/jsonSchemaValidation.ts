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
import Ajv, { type ErrorObject } from 'ajv';
import addFormats, { type FormatName } from 'ajv-formats';
import { z } from 'zod';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';

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
  cloneStrictPluginJsonValue,
  type PluginJsonSchemaValidator,
  type ProtocolJsonValue,
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
  return createPluginJsonSchemaZodAdapter(schema, z.object({}).passthrough(), true);
}

/** Native contributions may declare any ordinary JSON root, not only an object. */
export function createPluginJsonSchemaZodValueAdapter(schema: object) {
  // AJV admits the strict JSON value at this boundary. An unknown base keeps
  // Zod's exporter representable before the canonical projection hook runs.
  return createPluginJsonSchemaZodAdapter(schema, z.unknown(), false) as z.ZodType<ProtocolJsonValue>;
}

function createPluginJsonSchemaZodAdapter<Schema extends z.ZodType>(schema: object, root: Schema, objectRoot: boolean) {
  const prepared = preparePluginJsonSchema(schema);
  const { jsonSchema: normalized, validate } = prepared;
  const adapter = root.superRefine((value, ctx) => {
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
    if (objectRoot) json.type = 'object';
  };
  return defineStoredReadProjection(adapter, () => {
    const branchValidators = new WeakMap<object, PluginJsonSchemaValidator>();
    const matches = (branch: PluginJsonSchemaV2, value: unknown): boolean => {
      let validator = branchValidators.get(branch);
      if (!validator) {
        validator = compilePluginJsonSchema({ ...branch,
          ...(normalized.definitions ? { definitions: normalized.definitions } : {}),
          ...(normalized.$defs ? { $defs: normalized.$defs } : {}),
        });
        branchValidators.set(branch, validator);
      }
      return isValidPluginJsonSchemaValue(validator, value);
    };
    const reference = (pointer: string): PluginJsonSchemaV2 => {
      let node: unknown = normalized;
      for (const segment of pointer.slice(2).split('/').filter(() => pointer !== '#')) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid stored schema reference');
        node = (node as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
      }
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid stored schema reference');
      return node as PluginJsonSchemaV2;
    };
    // Projection changes only unknown-field handling. Every projected value
    // is re-admitted by the original portable compiler, including refinements.
    const project = (definition: PluginJsonSchemaV2, value: unknown): unknown => {
      const members: PluginJsonSchemaV2[] = [];
      const visited = new Set<PluginJsonSchemaV2>();
      const collect = (node: PluginJsonSchemaV2): void => {
        if (visited.has(node)) return;
        visited.add(node);
        members.push(node);
        if (node.$ref) collect(reference(node.$ref));
        node.allOf?.forEach(collect);
        for (const choices of [node.anyOf, node.oneOf]) {
          if (!choices) continue;
          const branch = choices.find((choice) => matches(choice, project(choice, value)));
          if (branch) collect(branch);
        }
      };
      collect(definition);
      if (Array.isArray(value)) {
        const items = members.flatMap((member) => member.items ? [member.items] : []);
        return items.length ? value.map((item) => project({ allOf: items }, item)) : value;
      }
      if (!value || typeof value !== 'object') return value;
      const objectMembers = members.filter((member) => member.type === 'object' || member.properties);
      if (!objectMembers.length) return value;
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        const declared = objectMembers.flatMap((member) => member.properties?.[key] ? [member.properties[key]!] : []);
        const catchalls = objectMembers.flatMap((member) => typeof member.additionalProperties === 'object' ? [member.additionalProperties] : []);
        const definitions = declared.length ? declared : catchalls;
        if (definitions.length) output[key] = project({ allOf: definitions }, child);
      }
      return output;
    };
    return z.unknown().transform((value, context) => {
      let projected: unknown;
      try { projected = project(normalized, cloneStrictPluginJsonValue(value, 'stored value')); }
      catch { context.addIssue({ code: 'custom', message: 'Stored value is not valid JSON' }); return z.NEVER; }
      const parsed = adapter.safeParse(projected);
      if (!parsed.success) { context.addIssue({ code: 'custom', message: 'Stored value does not match the declared plugin JSON Schema' }); return z.NEVER; }
      return parsed.data;
    });
  });
}
