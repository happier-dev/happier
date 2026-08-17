import Ajv from 'ajv';
import addFormats, { type FormatName } from 'ajv-formats';
import { z } from 'zod';

import {
  containsEquivalentPluginJsonValue,
  pluginJsonValuesEqual,
} from '../contributions/jsonSchemaValues.js';
import {
  PluginJsonSchemaV2Schema,
  type PluginJsonSchemaV2,
} from '../contributions/jsonSchema.js';
import {
  assertStrictPluginJsonValue,
  cloneStrictPluginJsonValue,
  measurePluginJsonUtf8Bytes,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../contributions/strictJsonValue.js';
import type { JsonValue as StrictRuntimeJsonValue } from '../../json/strictJsonValue.js';

export {
  containsEquivalentPluginJsonValue,
  pluginJsonValuesEqual,
} from '../contributions/jsonSchemaValues.js';
export { cloneStrictPluginJsonValue } from '../contributions/strictJsonValue.js';
export {
  measurePluginJsonUtf8Bytes,
  measureSerializedStrictPluginJsonUtf8Bytes,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../contributions/strictJsonValue.js';

const CANONICAL_PLUGIN_JSON_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#' as const;
const HAPPIER_MAX_UTF8_BYTES_KEYWORD = 'x-happier-max-utf8-bytes' as const;
const HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD = 'x-happier-max-serialized-utf8-bytes' as const;
const ACCEPTED_PLUGIN_JSON_SCHEMA_DIALECTS = new Set([
  CANONICAL_PLUGIN_JSON_SCHEMA_DIALECT,
  'http://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft-07/schema',
]);
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
 * The callable validation contract exposed by Protocol. AJV remains an
 * implementation detail so public declaration consumers do not inherit its
 * private type dependency graph.
 */
export type PluginJsonSchemaValidator = (value: unknown) => boolean;

/**
 * The one normalized schema and executable validator prepared for a single
 * admitted schema lifetime in one JavaScript realm. The pair itself has no
 * registry or cache semantics; the caller owns retaining and retiring it.
 */
export type PreparedPluginJsonSchema = Readonly<{
  jsonSchema: PluginJsonSchemaV2;
  validate: PluginJsonSchemaValidator;
}>;

function invalidSchema(message: string): Error {
  return new Error(`Invalid plugin JSON Schema: ${message}`);
}

function scalarPluginJsonValueKey(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return `boolean:${value}`;
    case 'number':
      return Number.isFinite(value) ? `number:${String(value)}` : undefined;
    case 'string':
      return `string:${value}`;
    default:
      return undefined;
  }
}

function hasUniquePluginJsonValues(values: readonly unknown[]): boolean {
  const seenScalars = new Set<string>();
  const seenCompounds: unknown[] = [];
  for (const value of values) {
    const scalarKey = scalarPluginJsonValueKey(value);
    if (scalarKey !== undefined) {
      if (seenScalars.has(scalarKey)) return false;
      seenScalars.add(scalarKey);
      continue;
    }
    if (containsEquivalentPluginJsonValue(seenCompounds, value)) return false;
    seenCompounds.push(value);
  }
  return true;
}

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

function assertUniqueStrings(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw invalidSchema(`${label} values must be unique`);
}

function assertSchemaSemantics(schema: Readonly<Record<string, unknown>>): void {
  if (Array.isArray(schema.enum) && schema.enum.length === 0) throw invalidSchema('enum must contain at least one value');
  if (Array.isArray(schema.required)) assertUniqueStrings(schema.required as readonly string[], 'required');
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = schema[keyword];
    if (!Array.isArray(variants)) continue;
    if (variants.length === 0) throw invalidSchema(`${keyword} must contain at least one schema`);
    for (const variant of variants) assertSchemaSemantics(variant as Readonly<Record<string, unknown>>);
  }
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    assertSchemaSemantics(schema.items as Readonly<Record<string, unknown>>);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object'
    && !Array.isArray(schema.additionalProperties)) {
    assertSchemaSemantics(schema.additionalProperties as Readonly<Record<string, unknown>>);
  }
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    for (const child of Object.values(schema.properties)) {
      assertSchemaSemantics(child as Readonly<Record<string, unknown>>);
    }
  }
}

export function normalizePluginJsonSchema(schema: object): PluginJsonSchemaV2 {
  let normalized: unknown;
  try {
    normalized = cloneStrictPluginJsonValue(schema, 'schema');
  } catch (error) {
    throw invalidSchema(error instanceof Error ? error.message : 'schema is not strict JSON');
  }
  const cloned = normalized as Readonly<Record<string, unknown>>;
  if (cloned.$schema !== undefined) {
    if (typeof cloned.$schema !== 'string' || !ACCEPTED_PLUGIN_JSON_SCHEMA_DIALECTS.has(cloned.$schema)) {
      throw invalidSchema('schema.$schema must select the supported JSON Schema draft-07 dialect');
    }
    normalized = Object.freeze({ ...cloned, $schema: CANONICAL_PLUGIN_JSON_SCHEMA_DIALECT });
  }
  const parsed = PluginJsonSchemaV2Schema.safeParse(normalized);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const basePath = issue && issue.path.length > 0 ? `schema.${issue.path.join('.')}` : 'schema';
    const path = issue?.code === 'unrecognized_keys' && issue.keys[0]
      ? `${basePath}.${issue.keys[0]}`
      : basePath;
    throw invalidSchema(`${path}: ${issue?.message ?? 'outside the public plugin schema vocabulary'}`);
  }
  // `cloneStrictPluginJsonValue` is the sole strict, recursively immutable
  // JSON owner. Zod only verifies this established value; returning its
  // parser output would create a second mutable projection.
  assertSchemaSemantics(normalized as Readonly<Record<string, unknown>>);
  return normalized as PluginJsonSchemaV2;
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

export function isValidPluginJsonSchemaValue(validate: PluginJsonSchemaValidator, value: unknown): boolean {
  try {
    return validate(cloneStrictPluginJsonValue(value, 'value')) === true;
  } catch {
    return false;
  }
}

/**
 * Strict ordinary JSON accepted by the protocol-authoring constructors. This
 * is the public authoring spelling of the one strict runtime value owned by
 * `json/strictJsonValue.ts`, not a second contract: it names the already
 * normalized value that `normalizeStrictJsonValue` produces and freezes, so it
 * stays deliberately immutable and free of validator-library types.
 */
export type ProtocolJsonValue = StrictRuntimeJsonValue;

/** The single Protocol-owned public JSON Schema DTO used by composable schemas. */
export type PluginJsonSchema = PluginJsonSchemaV2;

export type ProtocolValidationIssue = Readonly<{
  path: readonly (string | number)[];
  code: string;
  message: string;
}>;

export class ProtocolValidationError extends Error {
  readonly issues: readonly ProtocolValidationIssue[];

  constructor(issues: readonly ProtocolValidationIssue[]) {
    super('Protocol schema validation failed');
    this.name = 'ProtocolValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

export type ProtocolSchemaSafeParseResult<TOutput> =
  | Readonly<{ success: true; data: TOutput }>
  | Readonly<{ success: false; error: ProtocolValidationError }>;

/** The one validator-neutral composition surface available to SDK authors. */
export interface ProtocolComposableSchema<TInput, TOutput = TInput> {
  readonly jsonSchema: PluginJsonSchema;
  // The broad overload preserves runtime parser admission while the typed
  // overload retains authored-input inference through the neutral surface.
  parse(value: unknown): TOutput;
  parse(value: TInput): TOutput;
  safeParse(value: unknown): ProtocolSchemaSafeParseResult<TOutput>;
  optional(): ProtocolComposableSchema<TInput | undefined, TOutput | undefined>;
  nullable(): ProtocolComposableSchema<TInput | null, TOutput | null>;
}

export type ProtocolObjectEvolutionPolicy =
  | 'closed'
  | 'additive-open/drop'
  | 'additive-open/preserve';

export type ProtocolStringOptions = Readonly<{
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}>;

export type ProtocolUtf8StringOptions = Readonly<{
  maxUtf8Bytes: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}>;

export type ProtocolNumberOptions = Readonly<{
  integer?: boolean;
  minimum?: number;
  maximum?: number;
}>;

export type ProtocolArrayOptions = Readonly<{
  minItems?: number;
  maxItems?: number;
}>;

export type ProtocolUniqueJsonArrayOptions = ProtocolArrayOptions;

export type ProtocolJsonValueOptions = Readonly<{
  maxSerializedUtf8Bytes?: number;
}>;

export type ProtocolObjectOptions<
  TAdditional extends ProtocolComposableSchema<unknown, unknown> | undefined =
    ProtocolComposableSchema<unknown, unknown> | undefined,
> = Readonly<{
  policy: ProtocolObjectEvolutionPolicy;
  additionalProperties?: TAdditional;
}>;

const maxProtocolValidationIssues = 16;
const maxProtocolValidationPathSegments = 16;
const maxProtocolValidationPathSegmentLength = 128;

function isProtocolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedProtocolValidationPath(path: unknown): readonly (string | number)[] {
  if (!Array.isArray(path)) return Object.freeze([]);
  const bounded: (string | number)[] = [];
  for (const segment of path) {
    if (bounded.length >= maxProtocolValidationPathSegments) break;
    if (typeof segment === 'number' && Number.isSafeInteger(segment)) {
      bounded.push(segment);
    } else if (typeof segment === 'string') {
      bounded.push(segment.slice(0, maxProtocolValidationPathSegmentLength));
    }
  }
  return Object.freeze(bounded);
}

function createProtocolValidationIssue(
  code: string,
  message: string,
  path: unknown = [],
): ProtocolValidationIssue {
  return Object.freeze({ code, message, path: boundedProtocolValidationPath(path) });
}

function createProtocolFailure(
  issues: readonly ProtocolValidationIssue[],
): Readonly<{ success: false; error: ProtocolValidationError }> {
  return Object.freeze({
    success: false,
    error: new ProtocolValidationError(issues.slice(0, maxProtocolValidationIssues)),
  });
}

function createProtocolSingleFailure(
  code: string,
  message: string,
): Readonly<{ success: false; error: ProtocolValidationError }> {
  return createProtocolFailure([createProtocolValidationIssue(code, message)]);
}

function canonicalProtocolJsonSchema(projection: object): PluginJsonSchemaV2 {
  return normalizePluginJsonSchema({
    $schema: CANONICAL_PLUGIN_JSON_SCHEMA_DIALECT,
    ...projection,
  });
}

type ProtocolNormalizedParser<TOutput> = (
  value: ProtocolJsonValue,
) => ProtocolSchemaSafeParseResult<TOutput>;

function createProtocolComposableSchema<TInput, TOutput>(
  projection: object,
  parseNormalized: ProtocolNormalizedParser<TOutput>,
  allowsUndefined = false,
): ProtocolComposableSchema<TInput, TOutput> {
  const normalizedProjection = normalizePluginJsonSchema(projection);
  const jsonSchema = canonicalProtocolJsonSchema(normalizedProjection);
  const safeParse = (value: unknown): ProtocolSchemaSafeParseResult<TOutput> => {
    if (value === undefined && allowsUndefined) {
      return Object.freeze({ success: true, data: undefined as TOutput });
    }

    let normalizedInput: ProtocolJsonValue;
    try {
      normalizedInput = cloneStrictPluginJsonValue(value, 'value') as ProtocolJsonValue;
    } catch {
      return createProtocolSingleFailure('invalid_input', 'Protocol input must be strict JSON data');
    }

    let parsed: ProtocolSchemaSafeParseResult<TOutput>;
    try {
      parsed = parseNormalized(normalizedInput);
    } catch {
      return createProtocolSingleFailure('validator_error', 'Protocol validation did not produce a usable result');
    }
    if (!parsed.success) return parsed;
    if (parsed.data === undefined && allowsUndefined) {
      return Object.freeze({ success: true, data: undefined as TOutput });
    }

    let normalizedOutput: TOutput;
    try {
      normalizedOutput = (parsed.data === normalizedInput
        ? normalizedInput
        : cloneStrictPluginJsonValue(parsed.data, 'value')) as TOutput;
    } catch {
      return createProtocolSingleFailure('invalid_output', 'Protocol normalization did not produce strict JSON data');
    }
    return Object.freeze({ success: true, data: normalizedOutput });
  };

  return Object.freeze({
    jsonSchema,
    parse(value: unknown): TOutput {
      const result = safeParse(value);
      if (result.success) return result.data;
      throw result.error;
    },
    safeParse,
    optional(): ProtocolComposableSchema<TInput | undefined, TOutput | undefined> {
      return createProtocolComposableSchema<TInput | undefined, TOutput | undefined>(
        normalizedProjection,
        parseNormalized as ProtocolNormalizedParser<TOutput | undefined>,
        true,
      );
    },
    nullable(): ProtocolComposableSchema<TInput | null, TOutput | null> {
      return createProtocolComposableSchema<TInput | null, TOutput | null>(
        { anyOf: [normalizedProjection, { type: 'null' }] },
        (value) => value === null
          ? Object.freeze({ success: true, data: null as TOutput | null })
          : parseNormalized(value) as ProtocolSchemaSafeParseResult<TOutput | null>,
        allowsUndefined,
      );
    },
  });
}

function requireProtocolComposableSchema<TInput, TOutput>(
  value: unknown,
  label: string,
): ProtocolComposableSchema<TInput, TOutput> {
  if (!isProtocolRecord(value)
    || !isProtocolRecord(value.jsonSchema)
    || typeof value.parse !== 'function'
    || typeof value.safeParse !== 'function'
    || typeof value.optional !== 'function'
    || typeof value.nullable !== 'function') {
    throw new TypeError(`${label} must be a protocol composable schema`);
  }
  return value as unknown as ProtocolComposableSchema<TInput, TOutput>;
}

function protocolComposableProjection(schema: ProtocolComposableSchema<unknown, unknown>): PluginJsonSchemaV2 {
  const { $schema: _dialect, ...projection } = normalizePluginJsonSchema(schema.jsonSchema);
  return projection;
}

function protocolSchemaAllowsUndefined(schema: ProtocolComposableSchema<unknown, unknown>): boolean {
  try {
    return schema.safeParse(undefined).success;
  } catch {
    throw new TypeError('Protocol composable schema must safely parse its optional boundary');
  }
}

function prefixProtocolFailure(
  result: Extract<ProtocolSchemaSafeParseResult<unknown>, Readonly<{ success: false }>>,
  segment: string | number,
): Readonly<{ success: false; error: ProtocolValidationError }> {
  return createProtocolFailure(result.error.issues.map((issue) => createProtocolValidationIssue(
    issue.code,
    issue.message,
    [segment, ...issue.path],
  )));
}

function assertFiniteProtocolNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new TypeError(`Protocol ${name} must be finite`);
  return value;
}

function assertNonnegativeSafeInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Protocol ${name} must be a nonnegative safe integer`);
  }
  return value;
}

function assertPositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Protocol ${name} must be a positive safe integer`);
  }
  return value;
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

function protocolStringProjection(options: ProtocolStringOptions): PluginJsonSchemaV2 {
  const projection: PluginJsonSchemaV2 = { type: 'string' };
  if (options.minLength !== undefined) projection.minLength = options.minLength;
  if (options.maxLength !== undefined) projection.maxLength = options.maxLength;
  if (options.pattern !== undefined) projection.pattern = options.pattern;
  return projection;
}

function readProtocolStringConstraint(options: ProtocolStringOptions): (value: string) => boolean {
  let pattern: RegExp | undefined;
  if (options.pattern !== undefined) {
    try {
      pattern = new RegExp(options.pattern, 'u');
    } catch {
      throw new TypeError('Protocol string pattern must be a valid ECMAScript pattern source');
    }
  }
  return (value: string): boolean => {
    const length = codePointLength(value);
    return !((options.minLength !== undefined && length < options.minLength)
      || (options.maxLength !== undefined && length > options.maxLength)
      || (pattern !== undefined && !pattern.test(value)));
  };
}

export function defineProtocolLiteral<const TValue extends string | number | boolean | null>(
  value: TValue,
): ProtocolComposableSchema<TValue, TValue> {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Protocol literal numbers must be finite');
  }
  return createProtocolComposableSchema<TValue, TValue>(
    { const: value },
    (input) => pluginJsonValuesEqual(input, value)
      ? { success: true, data: value }
      : createProtocolSingleFailure('invalid_literal', 'Value does not match the protocol literal'),
  );
}

export function defineProtocolString(
  options: ProtocolStringOptions = {},
): ProtocolComposableSchema<string, string> {
  const minLength = assertNonnegativeSafeInteger(options.minLength, 'string minLength');
  const maxLength = assertNonnegativeSafeInteger(options.maxLength, 'string maxLength');
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw new TypeError('Protocol string maxLength must not be less than minLength');
  }
  if (options.pattern !== undefined && typeof options.pattern !== 'string') {
    throw new TypeError('Protocol string pattern must be a string');
  }
  const normalized = Object.freeze({
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
  });
  const matches = readProtocolStringConstraint(normalized);
  return createProtocolComposableSchema<string, string>(
    protocolStringProjection(normalized),
    (input) => typeof input === 'string' && matches(input)
      ? { success: true, data: input }
      : createProtocolSingleFailure('invalid_string', 'Value does not satisfy the protocol string constraint'),
  );
}

export function defineProtocolUtf8String(
  options: ProtocolUtf8StringOptions,
): ProtocolComposableSchema<string, string> {
  const maxUtf8Bytes = assertPositiveSafeInteger(options.maxUtf8Bytes, 'UTF-8 string maxUtf8Bytes');
  const minLength = assertNonnegativeSafeInteger(options.minLength, 'UTF-8 string minLength');
  const maxLength = assertNonnegativeSafeInteger(options.maxLength, 'UTF-8 string maxLength');
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw new TypeError('Protocol UTF-8 string maxLength must not be less than minLength');
  }
  if (options.pattern !== undefined && typeof options.pattern !== 'string') {
    throw new TypeError('Protocol UTF-8 string pattern must be a string');
  }
  const normalized = Object.freeze({
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
  });
  const matches = readProtocolStringConstraint(normalized);
  const projection = protocolStringProjection(normalized);
  projection[HAPPIER_MAX_UTF8_BYTES_KEYWORD] = maxUtf8Bytes;
  return createProtocolComposableSchema<string, string>(projection, (input) => {
    if (typeof input !== 'string' || !matches(input)) {
      return createProtocolSingleFailure('invalid_string', 'Value does not satisfy the protocol string constraint');
    }
    try {
      return measurePluginJsonUtf8Bytes(input, 'value') <= maxUtf8Bytes
        ? { success: true, data: input }
        : createProtocolSingleFailure('invalid_string', 'Value exceeds the protocol UTF-8 byte limit');
    } catch {
      return createProtocolSingleFailure('invalid_string', 'Value must be well-formed Unicode');
    }
  });
}

export function defineProtocolNumber(
  options: ProtocolNumberOptions = {},
): ProtocolComposableSchema<number, number> {
  const minimum = assertFiniteProtocolNumber(options.minimum, 'number minimum');
  const maximum = assertFiniteProtocolNumber(options.maximum, 'number maximum');
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new TypeError('Protocol number maximum must not be less than minimum');
  }
  if (options.integer === true) {
    if ((minimum !== undefined && !Number.isSafeInteger(minimum))
      || (maximum !== undefined && !Number.isSafeInteger(maximum))) {
      throw new TypeError('Protocol integer bounds must be safe integers');
    }
  }
  const projection: PluginJsonSchemaV2 = { type: options.integer === true ? 'integer' : 'number' };
  if (options.integer === true) {
    projection.minimum = Math.max(minimum ?? Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER);
    projection.maximum = Math.min(maximum ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  } else {
    if (minimum !== undefined) projection.minimum = minimum;
    if (maximum !== undefined) projection.maximum = maximum;
  }
  return createProtocolComposableSchema<number, number>(projection, (input) => (
    typeof input === 'number'
      && Number.isFinite(input)
      && (minimum === undefined || input >= minimum)
      && (maximum === undefined || input <= maximum)
      && (options.integer !== true || Number.isSafeInteger(input))
  )
    ? { success: true, data: input }
    : createProtocolSingleFailure('invalid_number', 'Value does not satisfy the protocol number constraint'));
}

type AnyProtocolComposableSchema = ProtocolComposableSchema<unknown, unknown>;
type ProtocolSchemaInput<TSchema> =
  TSchema extends { parse: (...args: infer TArguments) => unknown }
    ? TArguments extends readonly [infer TInput, ...readonly unknown[]]
      ? TInput
      : never
    : never;
type ProtocolSchemaOutput<TSchema> =
  TSchema extends { parse: (...args: infer _TArguments) => infer TOutput }
    ? TOutput
    : never;
type ProtocolObjectProjection<TShape extends Readonly<Record<string, AnyProtocolComposableSchema>>, TProjection extends 'input' | 'output'> = {
  -readonly [TKey in keyof TShape as undefined extends (
    TProjection extends 'input' ? ProtocolSchemaInput<TShape[TKey]> : ProtocolSchemaOutput<TShape[TKey]>
  ) ? never : TKey]: Exclude<
    TProjection extends 'input' ? ProtocolSchemaInput<TShape[TKey]> : ProtocolSchemaOutput<TShape[TKey]>,
    undefined
  >;
} & {
  -readonly [TKey in keyof TShape as undefined extends (
    TProjection extends 'input' ? ProtocolSchemaInput<TShape[TKey]> : ProtocolSchemaOutput<TShape[TKey]>
  ) ? TKey : never]?: Exclude<
    TProjection extends 'input' ? ProtocolSchemaInput<TShape[TKey]> : ProtocolSchemaOutput<TShape[TKey]>,
    undefined
  >;
};
type ProtocolObjectAdditionalValue<
  TOptions extends ProtocolObjectOptions,
  TProjection extends 'input' | 'output',
> = TOptions['additionalProperties'] extends AnyProtocolComposableSchema
  ? TProjection extends 'input'
    ? ProtocolSchemaInput<TOptions['additionalProperties']>
    : ProtocolSchemaOutput<TOptions['additionalProperties']>
  : ProtocolJsonValue;
type ProtocolObjectKnownValue<
  TShape extends Readonly<Record<string, AnyProtocolComposableSchema>>,
  TProjection extends 'input' | 'output',
> = Exclude<
  ProtocolObjectProjection<TShape, TProjection>[keyof ProtocolObjectProjection<TShape, TProjection>],
  undefined
>;
type ProtocolObjectPreservedProjection<
  TShape extends Readonly<Record<string, AnyProtocolComposableSchema>>,
  TOptions extends ProtocolObjectOptions,
  TProjection extends 'input' | 'output',
> = ProtocolObjectProjection<TShape, TProjection> & Readonly<Record<
  string,
  ProtocolObjectAdditionalValue<TOptions, TProjection> | ProtocolObjectKnownValue<TShape, TProjection>
>>;
type ProtocolObjectInput<TShape extends Readonly<Record<string, AnyProtocolComposableSchema>>, TOptions extends ProtocolObjectOptions> =
  TOptions['policy'] extends 'additive-open/preserve'
    ? ProtocolObjectPreservedProjection<TShape, TOptions, 'input'>
    : ProtocolObjectProjection<TShape, 'input'>;
type ProtocolObjectOutput<TShape extends Readonly<Record<string, AnyProtocolComposableSchema>>, TOptions extends ProtocolObjectOptions> =
  TOptions['policy'] extends 'additive-open/preserve'
    ? ProtocolObjectPreservedProjection<TShape, TOptions, 'output'>
    : ProtocolObjectProjection<TShape, 'output'>;
export function defineProtocolObject<
  const TShape extends Readonly<Record<string, AnyProtocolComposableSchema>>,
  const TOptions extends ProtocolObjectOptions,
>(
  shape: TShape,
  options: TOptions,
): ProtocolComposableSchema<
  ProtocolObjectInput<TShape, TOptions>,
  ProtocolObjectOutput<TShape, TOptions>
> {
  if (!isProtocolRecord(shape)) throw new TypeError('Protocol object shape must be a record');
  if (!isProtocolRecord(options)
    || (options.policy !== 'closed'
      && options.policy !== 'additive-open/drop'
      && options.policy !== 'additive-open/preserve')) {
    throw new TypeError('Protocol object requires a supported unknown-key policy');
  }
  const children: Record<string, ProtocolComposableSchema<unknown, unknown>> = {};
  const properties: Record<string, PluginJsonSchemaV2> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    const schema = requireProtocolComposableSchema<unknown, unknown>(child, `Protocol object field '${key}'`);
    children[key] = schema;
    properties[key] = protocolComposableProjection(schema);
    if (!protocolSchemaAllowsUndefined(schema)) required.push(key);
  }

  const additional = options.additionalProperties;
  if (additional !== undefined && options.policy !== 'additive-open/preserve') {
    throw new TypeError('Typed additionalProperties requires additive-open/preserve');
  }
  const projection: PluginJsonSchemaV2 = {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
  let additionalSchema: ProtocolComposableSchema<unknown, unknown> | undefined;
  if (options.policy === 'closed') {
    projection.additionalProperties = false;
  } else if (options.policy === 'additive-open/drop') {
    projection.additionalProperties = true;
  } else if (additional === undefined) {
    projection.additionalProperties = true;
  } else {
    additionalSchema = requireProtocolComposableSchema<unknown, unknown>(
      additional,
      'Protocol object additionalProperties schema',
    );
    projection.additionalProperties = protocolComposableProjection(additionalSchema);
  }
  return createProtocolComposableSchema<
    ProtocolObjectInput<TShape, TOptions>,
    ProtocolObjectOutput<TShape, TOptions>
  >(projection, (input) => {
    if (!isProtocolRecord(input)) {
      return createProtocolSingleFailure('invalid_object', 'Value must be a protocol object');
    }
    const values = input as Record<string, ProtocolJsonValue>;
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(children)) {
      const present = Object.hasOwn(values, key);
      const parsed = child.safeParse(values[key]);
      if (!parsed.success) return prefixProtocolFailure(parsed, key);
      if (present) output[key] = parsed.data;
    }
    for (const key of Object.keys(values)) {
      if (Object.hasOwn(children, key)) continue;
      if (options.policy === 'closed') {
        return createProtocolSingleFailure('unknown_key', 'Value contains an unknown protocol object key');
      }
      if (options.policy === 'additive-open/drop') continue;
      const value = values[key];
      if (additionalSchema !== undefined) {
        const parsed = additionalSchema.safeParse(value);
        if (!parsed.success) return prefixProtocolFailure(parsed, key);
        output[key] = parsed.data;
      } else {
        output[key] = value;
      }
    }
    return { success: true, data: output as ProtocolObjectOutput<TShape, TOptions> };
  });
}

function readProtocolArrayOptions(options: ProtocolArrayOptions): Required<Pick<ProtocolArrayOptions, never>> & ProtocolArrayOptions {
  const minItems = assertNonnegativeSafeInteger(options.minItems, 'array minItems');
  const maxItems = assertNonnegativeSafeInteger(options.maxItems, 'array maxItems');
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    throw new TypeError('Protocol array maxItems must not be less than minItems');
  }
  return Object.freeze({
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
  });
}

function protocolArrayProjection(item: PluginJsonSchemaV2, options: ProtocolArrayOptions, unique = false): PluginJsonSchemaV2 {
  return {
    type: 'array',
    items: item,
    ...(options.minItems === undefined ? {} : { minItems: options.minItems }),
    ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
    ...(unique ? { uniqueItems: true } : {}),
  };
}

export function defineProtocolArray<
  TSchema extends AnyProtocolComposableSchema,
>(
  itemSchema: TSchema,
  options: ProtocolArrayOptions = {},
): ProtocolComposableSchema<
  readonly ProtocolSchemaInput<TSchema>[],
  readonly ProtocolSchemaOutput<TSchema>[]
> {
  const item = requireProtocolComposableSchema<ProtocolSchemaInput<TSchema>, ProtocolSchemaOutput<TSchema>>(
    itemSchema,
    'Protocol array item schema',
  );
  const normalized = readProtocolArrayOptions(options);
  return createProtocolComposableSchema<
    readonly ProtocolSchemaInput<TSchema>[],
    readonly ProtocolSchemaOutput<TSchema>[]
  >(protocolArrayProjection(protocolComposableProjection(item), normalized), (input) => {
    if (!Array.isArray(input)
      || (normalized.minItems !== undefined && input.length < normalized.minItems)
      || (normalized.maxItems !== undefined && input.length > normalized.maxItems)) {
      return createProtocolSingleFailure('invalid_array', 'Value does not satisfy the protocol array constraint');
    }
    const output: ProtocolSchemaOutput<TSchema>[] = [];
    for (const [index, value] of input.entries()) {
      const parsed = item.safeParse(value);
      if (!parsed.success) return prefixProtocolFailure(parsed, index);
      output.push(parsed.data);
    }
    return { success: true, data: output as readonly ProtocolSchemaOutput<TSchema>[] };
  });
}

export function defineProtocolUniqueArray<
  TSchema extends AnyProtocolComposableSchema,
>(
  itemSchema: TSchema,
  options: ProtocolUniqueJsonArrayOptions = {},
): ProtocolComposableSchema<
  readonly ProtocolSchemaInput<TSchema>[],
  readonly ProtocolSchemaOutput<TSchema>[]
> {
  const item = requireProtocolComposableSchema<ProtocolSchemaInput<TSchema>, ProtocolSchemaOutput<TSchema>>(
    itemSchema,
    'Protocol unique-array item schema',
  );
  const normalized = readProtocolArrayOptions(options);
  return createProtocolComposableSchema<
    readonly ProtocolSchemaInput<TSchema>[],
    readonly ProtocolSchemaOutput<TSchema>[]
  >(protocolArrayProjection(protocolComposableProjection(item), normalized, true), (input) => {
    if (!Array.isArray(input)
      || (normalized.minItems !== undefined && input.length < normalized.minItems)
      || (normalized.maxItems !== undefined && input.length > normalized.maxItems)) {
      return createProtocolSingleFailure('invalid_array', 'Value does not satisfy the protocol array constraint');
    }
    const output: ProtocolSchemaOutput<TSchema>[] = [];
    for (const [index, value] of input.entries()) {
      const parsed = item.safeParse(value);
      if (!parsed.success) return prefixProtocolFailure(parsed, index);
      output.push(parsed.data);
    }
    return hasUniquePluginJsonValues(output)
      ? { success: true, data: output as readonly ProtocolSchemaOutput<TSchema>[] }
      : createProtocolSingleFailure('duplicate_array_item', 'Protocol array items must be unique');
  });
}

export function defineProtocolUnion<
  const TMembers extends readonly [AnyProtocolComposableSchema, AnyProtocolComposableSchema, ...AnyProtocolComposableSchema[]],
>(
  members: TMembers,
): ProtocolComposableSchema<
  ProtocolSchemaInput<TMembers[number]>,
  ProtocolSchemaOutput<TMembers[number]>
> {
  if (!Array.isArray(members) || members.length < 2) {
    throw new TypeError('Protocol union requires at least two member schemas');
  }
  const schemas = members.map((member) => requireProtocolComposableSchema<
    ProtocolSchemaInput<TMembers[number]>,
    ProtocolSchemaOutput<TMembers[number]>
  >(member, 'Protocol union member schema'));
  return createProtocolComposableSchema<
    ProtocolSchemaInput<TMembers[number]>,
    ProtocolSchemaOutput<TMembers[number]>
  >({ anyOf: schemas.map(protocolComposableProjection) }, (input) => {
    for (const schema of schemas) {
      const parsed = schema.safeParse(input);
      if (parsed.success) return { success: true, data: parsed.data };
    }
    return createProtocolSingleFailure('invalid_union', 'Value does not match any protocol union member');
  });
}

export function defineProtocolJsonValue<TValue extends ProtocolJsonValue = ProtocolJsonValue>(
  options: ProtocolJsonValueOptions = {},
): ProtocolComposableSchema<TValue, TValue> {
  const maximum = options.maxSerializedUtf8Bytes === undefined
    ? undefined
    : assertPositiveSafeInteger(options.maxSerializedUtf8Bytes, 'JSON value maxSerializedUtf8Bytes');
  return createProtocolComposableSchema<TValue, TValue>(
    maximum === undefined ? {} : { [HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD]: maximum },
    (input) => {
      try {
        if (maximum !== undefined
          && measureSerializedValidatedStrictPluginJsonUtf8Bytes(input, 'value', maximum) > maximum) {
          return createProtocolSingleFailure(
            'invalid_json_value',
            'Value exceeds the protocol serialized-byte limit',
          );
        }
        return { success: true, data: input as TValue };
      } catch {
        return createProtocolSingleFailure('invalid_json_value', 'Value must be strict JSON data');
      }
    },
  );
}
