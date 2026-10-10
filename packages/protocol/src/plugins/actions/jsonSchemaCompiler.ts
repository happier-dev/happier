/** Shared executable JSON Schema semantics; dialect admission belongs to each contract owner. */
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats, { type FormatName } from 'ajv-formats';

import { containsEquivalentPluginJsonValue, hasUniquePluginJsonValues, pluginJsonValuesEqual, scalarPluginJsonValueKey } from '../contributions/jsonSchemaValues.js';
import { assertStrictPluginJsonValue, measurePluginJsonUtf8Bytes, measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '../contributions/strictJsonValue.js';
import { HAPPIER_MAX_SERIALIZED_UTF8_BYTES_KEYWORD, HAPPIER_MAX_UTF8_BYTES_KEYWORD, type PluginJsonSchemaValidator } from './protocolComposableSchema.js';

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

function createAjv(dialect: 'draft-07' | 'draft-2020-12'): Ajv {
  const options = {
    allErrors: true, ownProperties: true, strict: false,
    // Plugin declarations have already passed their closed vocabulary. Native
    // Action projections use the selected dialect's schema/keyword admission.
    strictSchema: dialect === 'draft-2020-12',
    validateSchema: dialect === 'draft-2020-12',
  };
  const ajv = dialect === 'draft-2020-12' ? new Ajv2020(options) : new Ajv(options);
  addFormats(ajv, [...SUPPORTED_PLUGIN_JSON_SCHEMA_FORMATS]);
  // Compile the dialect's own meta-schema with its native vocabulary before
  // replacing value-equality keywords. Keyword meta-schemas use this validator.
  if (dialect === 'draft-2020-12') ajv.getSchema('https://json-schema.org/draft/2020-12/schema');
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

export function compileProtocolJsonSchema(
  jsonSchema: object,
  dialect: 'draft-07' | 'draft-2020-12',
): PluginJsonSchemaValidator {
  return createAjv(dialect).compile(jsonSchema);
}
