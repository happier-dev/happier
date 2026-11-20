/** Shared executable JSON Schema semantics; dialect admission belongs to each contract owner. */
import { Ajv, _ } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formatsImport, { type FormatName, type FormatsPlugin } from 'ajv-formats';

import { forEachJsonSchemaChild, jsonSchemaContainsReference } from '../../actions/actionInputJsonSchema.js';
import { isNormalizedPluginJsonSchema, type PluginJsonSchemaV2 } from '../contributions/jsonSchema.js';
import { containsEquivalentPluginJsonValue, hasUniquePluginJsonValues, pluginJsonValuesEqual, scalarPluginJsonValueKey } from '../contributions/jsonSchemaValues.js';
import { assertStrictPluginJsonValue, measurePluginJsonUtf8Bytes, measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '../contributions/strictJsonValue.js';
import { HAPPIER_LENGTH_MULTIPLE_OF_KEYWORD, HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD, HAPPIER_MAX_UTF8_BYTES_KEYWORD, HAPPIER_VALUE_CONSTRAINTS_KEYWORD, type PluginJsonSchemaValidator } from './protocolComposableSchema.js';
import { isProtocolValueConstraints, satisfiesProtocolValueConstraints } from './protocolValueConstraints.js';
import { readPaddedBase64DecodedLength } from '../../crypto/base64.js';

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

// ajv-formats publishes a callable CommonJS export with an identical .default.
// NodeNext describes the namespace while bundlers describe the callable value.
function resolveFormatsPlugin(imported: FormatsPlugin | Readonly<{ default: FormatsPlugin }>): FormatsPlugin {
  return typeof imported === 'function' ? imported : imported.default;
}

const addFormats = resolveFormatsPlugin(formatsImport);

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

// Keyword values are checked where each keyword compiles. An AJV keyword
// metaSchema would compile one more validator per engine, and every distinct
// schema content owns an engine.
function readByteLimitKeywordValue(keyword: string, maximum: unknown): number {
  if (typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error(`Plugin JSON Schema ${keyword} must be a positive safe integer`);
  }
  return maximum;
}

function createAjv(dialect: 'draft-07' | 'draft-2020-12', inlineRefs: boolean): Ajv {
  const options = {
    allErrors: true, ownProperties: true, strict: false, inlineRefs,
    // Cold Action schemas spend seconds in optional generated-code rewrites.
    code: { optimize: false },
    // Plugin declarations have already passed their closed vocabulary. Native
    // Action projections use the selected dialect's schema/keyword admission.
    strictSchema: dialect === 'draft-2020-12',
    validateSchema: dialect === 'draft-2020-12',
  };
  const ajv = dialect === 'draft-2020-12' ? new Ajv2020(options) : new Ajv(options);
  addFormats(ajv, [...SUPPORTED_PLUGIN_JSON_SCHEMA_FORMATS]);
  // ajv-formats' repeated-group byte regexp also refuses large valid input in
  // Bun. Share the executable schema's structural byte grammar instead.
  ajv.addFormat('byte', { type: 'string', validate: value => readPaddedBase64DecodedLength(value) !== null });
  // Compile the dialect's own meta-schema with its native vocabulary before
  // replacing value-equality keywords.
  if (dialect === 'draft-2020-12') ajv.getSchema('https://json-schema.org/draft/2020-12/schema');
  ajv.removeKeyword('enum');
  ajv.addKeyword({
    keyword: 'enum',
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
    error: {
      message: 'must be equal to one of the allowed values',
      params: ({ schemaCode }) => _`{allowedValues: ${schemaCode}}`,
    },
  });
  ajv.removeKeyword('const');
  ajv.addKeyword({
    keyword: 'const',
    validate: (expected: unknown, value: unknown) => pluginJsonValuesEqual(expected, value),
    errors: false,
    error: {
      message: 'must be equal to constant',
      params: ({ schemaCode }) => _`{allowedValue: ${schemaCode}}`,
    },
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
    keyword: HAPPIER_LENGTH_MULTIPLE_OF_KEYWORD,
    type: 'string',
    schemaType: 'number',
    compile: (multiple: unknown) => {
      const lengthMultiple = readByteLimitKeywordValue(HAPPIER_LENGTH_MULTIPLE_OF_KEYWORD, multiple);
      return (value: unknown) => {
        if (typeof value !== 'string') return false;
        let length = 0;
        for (const _character of value) length += 1;
        return length % lengthMultiple === 0;
      };
    },
    errors: false,
  });
  ajv.addKeyword({
    keyword: HAPPIER_VALUE_CONSTRAINTS_KEYWORD,
    schemaType: 'array',
    compile: (constraints: unknown) => {
      if (!isProtocolValueConstraints(constraints)) throw new Error('Invalid declarative protocol value constraints');
      return (value: unknown) => satisfiesProtocolValueConstraints(value, constraints);
    },
    errors: false,
  });
  ajv.addKeyword({
    keyword: HAPPIER_MAX_UTF8_BYTES_KEYWORD,
    type: 'string',
    schemaType: 'number',
    compile: (maximum: unknown) => {
      const maximumBytes = readByteLimitKeywordValue(HAPPIER_MAX_UTF8_BYTES_KEYWORD, maximum);
      return (value: unknown) => {
        try {
          return typeof value === 'string' && measurePluginJsonUtf8Bytes(value, 'value') <= maximumBytes;
        } catch {
          return false;
        }
      };
    },
    errors: false,
  });
  ajv.addKeyword({
    keyword: HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD,
    schemaType: 'number',
    compile: (maximum: unknown) => {
      const maximumBytes = readByteLimitKeywordValue(HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD, maximum);
      return (value: unknown) => {
        try {
          assertStrictPluginJsonValue(value, 'value');
          return measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'value', maximumBytes) <= maximumBytes;
        } catch {
          return false;
        }
      };
    },
    errors: false,
  });
  return ajv;
}

function separateOptionalPropertySchemas(schema: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  if (schema.type !== 'object' || schema.additionalProperties !== false || !schema.properties) return schema;
  const required = new Set(schema.required);
  const definitions: Record<string, PluginJsonSchemaV2> = {};
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([key, property], index) => {
    if (required.has(key)) return [key, property];
    let hasChild = false;
    forEachJsonSchemaChild(property, child => { if (typeof child === 'object' && child !== null) hasChild = true; });
    if (!hasChild) return [key, property];
    definitions[index] = property;
    return [key, { $ref: `#/definitions/${index}` }];
  }));
  // Existing pointers can depend on the original location of these properties.
  // For a pointer-free document, the isolated optional schemas compile as
  // separate functions. The initial Action compiles no unused recovery code
  // into the function it runs, even when the optional branch is very large.
  if (Object.keys(definitions).length === 0 || jsonSchemaContainsReference(schema)) return schema;
  return { ...schema, properties, definitions };
}

// Reuse validators for admitted immutable schema identities. Each new identity
// owns its AJV scope: removeSchema() clears AJV's cache, but its generated-code
// scope still retains schemas and validators until the entire engine retires.
const compiledSchemas = {
  'draft-07': new WeakMap<object, PluginJsonSchemaValidator>(),
  'draft-2020-12': new WeakMap<object, PluginJsonSchemaValidator>(),
};
// Normalization and declaration parsing hand over a fresh object for the same
// schema, so equal content also shares a validator while any identity keeps it
// alive. Held weakly: a retired content's engine is still collectable.
const compiledContents = {
  'draft-07': new Map<string, WeakRef<PluginJsonSchemaValidator>>(),
  'draft-2020-12': new Map<string, WeakRef<PluginJsonSchemaValidator>>(),
};

export function compileProtocolJsonSchema(
  jsonSchema: object,
  dialect: 'draft-07' | 'draft-2020-12',
  prepareSchema?: (schema: object) => object,
): PluginJsonSchemaValidator {
  const validators = compiledSchemas[dialect];
  const existing = validators.get(jsonSchema);
  if (existing) return existing;
  const schema = prepareSchema ? prepareSchema(jsonSchema) : jsonSchema;
  const compiled = dialect === 'draft-07' && isNormalizedPluginJsonSchema(schema)
    ? separateOptionalPropertySchemas(schema)
    : schema;
  const content = JSON.stringify(compiled);
  const contents = compiledContents[dialect];
  let validate = contents.get(content)?.deref();
  if (!validate) {
    validate = createAjv(dialect, compiled === schema).compile(compiled);
    // A new compilation is the rare path: drop keys whose validators were collected.
    for (const [key, ref] of contents) if (!ref.deref()) contents.delete(key);
    contents.set(content, new WeakRef(validate));
  }
  validators.set(jsonSchema, validate);
  return validate;
}
