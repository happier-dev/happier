/**
 * Canonical owner of the Protocol composable-schema DSL and of JSON Schema
 * normalization for plugin declarations.
 *
 * This module deliberately holds no JSON Schema *compiler*: constructing and
 * parsing through a composable schema needs the normalizer, not AJV. Keeping
 * the compiler in `jsonSchemaValidation.ts` is what lets an id schema
 * (`PluginIdSchema`, `PluginContributionLocalIdSchema`, ...) reach a browser or
 * React Native plugin bundle without dragging AJV, ajv-formats and fast-uri in
 * with it. `jsonSchemaValidation.ts` re-exports everything below, so the
 * published `./plugins/actions/json-schema-validation` surface is unchanged.
 */
import {
  hasUniquePluginJsonValues,
  pluginJsonValuesEqual,
} from '../contributions/jsonSchemaValues.js';
import {
  PluginJsonSchemaV2Schema,
  type PluginJsonSchemaV2,
} from '../contributions/jsonSchema.js';
import {
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
const ACCEPTED_PLUGIN_JSON_SCHEMA_DIALECTS = new Set([
  CANONICAL_PLUGIN_JSON_SCHEMA_DIALECT,
  'http://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft-07/schema',
]);

/**
 * Protocol's two JSON Schema keyword extensions. They are declared here because
 * this module builds the projections that carry them; the AJV compiler imports
 * the same constants rather than re-spelling the keyword names.
 */
export const HAPPIER_MAX_UTF8_BYTES_KEYWORD = 'x-happier-max-utf8-bytes' as const;
export const HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD = 'x-happier-max-serialized-utf8-bytes' as const;

/**
 * The callable validation contract exposed by Protocol. AJV remains an
 * implementation detail so public declaration consumers do not inherit its
 * private type dependency graph.
 */
export type PluginJsonSchemaValidator = (value: unknown) => boolean;

function invalidSchema(message: string): Error {
  return new Error(`Invalid plugin JSON Schema: ${message}`);
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

/**
 * The one structural recognition of a complete composable schema.
 *
 * A composable value crosses realms and independently installed SDK copies, so
 * it can never be recognized by a local symbol or instanceof check — only by
 * its five-member surface. That surface is listed here and nowhere else: the
 * SDK facade's public recognizer and Protocol's own `require` helper both call
 * this, so a change to the composable contract cannot leave one of them
 * accepting a value the other rejects.
 */
export function isProtocolComposableSchema<TInput, TOutput = TInput>(
  value: unknown,
): value is ProtocolComposableSchema<TInput, TOutput> {
  return isProtocolRecord(value)
    && isProtocolRecord(value.jsonSchema)
    && typeof value.parse === 'function'
    && typeof value.safeParse === 'function'
    && typeof value.optional === 'function'
    && typeof value.nullable === 'function';
}

function requireProtocolComposableSchema<TInput, TOutput>(
  value: unknown,
  label: string,
): ProtocolComposableSchema<TInput, TOutput> {
  if (!isProtocolComposableSchema<TInput, TOutput>(value)) {
    throw new TypeError(`${label} must be a protocol composable schema`);
  }
  return value;
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
    // `true` is the canonical JSON Schema spelling for accepting then
    // dropping unknown keys. Preserve needs a distinct emitted spelling so an
    // exact-generation manifest can reconstruct the Protocol parser without
    // consulting a target module.
    projection.additionalProperties = {};
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
    // `uniqueItems` compares admitted JSON values. Child parsers may
    // intentionally normalize their outputs (for example, an open/drop
    // object), so comparing `output` here would reject inputs that the one
    // emitted JSON Schema accepts.
    return hasUniquePluginJsonValues(input)
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

type CanonicalComposableSchema = ProtocolComposableSchema<ProtocolJsonValue, ProtocolJsonValue>;
type CanonicalComposableObjectPropertySchema = ProtocolComposableSchema<
  ProtocolJsonValue | undefined,
  ProtocolJsonValue | undefined
>;

function eraseCanonicalObjectProjectionType(
  schema: AnyProtocolComposableSchema,
): CanonicalComposableSchema {
  // The object builder's mapped type preserves optional-property `undefined`
  // as an authoring input marker. At runtime those keys are omitted, so the
  // parsed whole object remains strict JSON at this canonical conversion seam.
  return schema as unknown as CanonicalComposableSchema;
}

function hasOnlyCanonicalSchemaKeys(
  schema: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(schema).every((key) => allowed.includes(key));
}

function readCanonicalComposableSchemaProjection(
  value: unknown,
): CanonicalComposableSchema | null {
  if (!isProtocolRecord(value) || Object.hasOwn(value, '$schema')) return null;

  try {
    if (Object.hasOwn(value, 'const')) {
      if (!hasOnlyCanonicalSchemaKeys(value, ['const'])) return null;
      const literal = value.const;
      if (literal !== null
        && typeof literal !== 'string'
        && typeof literal !== 'number'
        && typeof literal !== 'boolean') {
        return null;
      }
      return defineProtocolLiteral(literal);
    }

    if (Object.hasOwn(value, 'anyOf')) {
      if (!hasOnlyCanonicalSchemaKeys(value, ['anyOf']) || !Array.isArray(value.anyOf)) return null;
      const members = value.anyOf;
      if (members.length < 2) return null;
      if (members.length === 2
        && isProtocolRecord(members[1])
        && Object.keys(members[1]).length === 1
        && members[1].type === 'null') {
        const nullable = readCanonicalComposableSchemaProjection(members[0]);
        return nullable?.nullable() ?? null;
      }
      const rehydratedMembers = members.map(readCanonicalComposableSchemaProjection);
      if (rehydratedMembers.some((member) => member === null)) return null;
      return defineProtocolUnion(rehydratedMembers as [
        CanonicalComposableSchema,
        CanonicalComposableSchema,
        ...CanonicalComposableSchema[],
      ]);
    }

    if (value.type === 'string') {
      if (!hasOnlyCanonicalSchemaKeys(value, [
        'type',
        'minLength',
        'maxLength',
        'pattern',
        HAPPIER_MAX_UTF8_BYTES_KEYWORD,
      ])) return null;
      const options = Object.freeze({
        ...(typeof value.minLength === 'number' ? { minLength: value.minLength } : {}),
        ...(typeof value.maxLength === 'number' ? { maxLength: value.maxLength } : {}),
        ...(typeof value.pattern === 'string' ? { pattern: value.pattern } : {}),
      });
      const maxUtf8Bytes = value[HAPPIER_MAX_UTF8_BYTES_KEYWORD];
      return maxUtf8Bytes === undefined
        ? defineProtocolString(options)
        : typeof maxUtf8Bytes === 'number'
          ? defineProtocolUtf8String({ ...options, maxUtf8Bytes })
          : null;
    }

    if (value.type === 'number' || value.type === 'integer') {
      if (!hasOnlyCanonicalSchemaKeys(value, ['type', 'minimum', 'maximum'])) return null;
      const minimum = value.minimum;
      const maximum = value.maximum;
      if ((minimum !== undefined && typeof minimum !== 'number')
        || (maximum !== undefined && typeof maximum !== 'number')) return null;
      if (value.type === 'integer' && (minimum === undefined || maximum === undefined)) return null;
      return defineProtocolNumber({
        ...(value.type === 'integer' ? { integer: true } : {}),
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
      });
    }

    if (value.type === 'array') {
      if (!hasOnlyCanonicalSchemaKeys(value, [
        'type',
        'items',
        'minItems',
        'maxItems',
        'uniqueItems',
      ]) || !Object.hasOwn(value, 'items')) return null;
      if ((value.minItems !== undefined && typeof value.minItems !== 'number')
        || (value.maxItems !== undefined && typeof value.maxItems !== 'number')
        || (value.uniqueItems !== undefined && value.uniqueItems !== true)) return null;
      const item = readCanonicalComposableSchemaProjection(value.items);
      if (!item) return null;
      const options = Object.freeze({
        ...(value.minItems === undefined ? {} : { minItems: value.minItems }),
        ...(value.maxItems === undefined ? {} : { maxItems: value.maxItems }),
      });
      return value.uniqueItems === true
        ? defineProtocolUniqueArray(item, options)
        : defineProtocolArray(item, options);
    }

    if (value.type === 'object') {
      if (!hasOnlyCanonicalSchemaKeys(value, [
        'type',
        'properties',
        'required',
        'additionalProperties',
      ])
        || !isProtocolRecord(value.properties)
        || !Object.hasOwn(value, 'additionalProperties')) return null;
      const required = value.required;
      if (required !== undefined
        && (!Array.isArray(required)
          || required.some((key) => typeof key !== 'string')
          || new Set(required).size !== required.length)) return null;
      const requiredKeys = new Set(required ?? []);
      const shape: Record<string, CanonicalComposableObjectPropertySchema> = {};
      const propertyKeys = [
        ...requiredKeys,
        ...Object.keys(value.properties).filter((key) => !requiredKeys.has(key)),
      ];
      for (const key of propertyKeys) {
        const schema = value.properties[key];
        if (schema === undefined) return null;
        const child = readCanonicalComposableSchemaProjection(schema);
        if (!child) return null;
        shape[key] = requiredKeys.has(key) ? child : child.optional();
      }

      const additionalProperties = value.additionalProperties;
      if (additionalProperties === false) {
        return eraseCanonicalObjectProjectionType(defineProtocolObject(shape, { policy: 'closed' }));
      }
      if (additionalProperties === true) {
        return eraseCanonicalObjectProjectionType(defineProtocolObject(shape, { policy: 'additive-open/drop' }));
      }
      if (!isProtocolRecord(additionalProperties)) return null;
      if (Object.keys(additionalProperties).length === 0) {
        return eraseCanonicalObjectProjectionType(defineProtocolObject(shape, { policy: 'additive-open/preserve' }));
      }
      const additional = readCanonicalComposableSchemaProjection(additionalProperties);
      return additional
        ? eraseCanonicalObjectProjectionType(defineProtocolObject(shape, {
          policy: 'additive-open/preserve',
          additionalProperties: additional,
        }))
        : null;
    }

    if (Object.keys(value).length === 0) return defineProtocolJsonValue();
    if (hasOnlyCanonicalSchemaKeys(value, [HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD])
      && typeof value[HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD] === 'number') {
      return defineProtocolJsonValue({
        maxSerializedUtf8Bytes: value[HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD] as number,
      });
    }
  } catch {
    // A schema can be valid JSON Schema while not being an exact projection of
    // this DSL. This compiler intentionally declines such input instead of
    // inferring a similar parser.
  }
  return null;
}

/**
 * Rehydrates only the exact JSON Schema grammar emitted by this module's
 * composable-schema constructors. It is deliberately not a general JSON
 * Schema compiler: unsupported or hand-authored shapes return `null`.
 */
export function rehydrateCanonicalProtocolComposableSchema(
  schema: object,
): CanonicalComposableSchema | null {
  let normalized: PluginJsonSchemaV2;
  try {
    normalized = normalizePluginJsonSchema(schema);
  } catch {
    return null;
  }
  if (normalized.$schema !== CANONICAL_PLUGIN_JSON_SCHEMA_DIALECT) return null;
  const { $schema: _dialect, ...projection } = normalized;
  const rehydrated = readCanonicalComposableSchemaProjection(projection);
  return rehydrated && pluginJsonValuesEqual(rehydrated.jsonSchema, normalized)
    ? rehydrated
    : null;
}
