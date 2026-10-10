import { compileProtocolJsonSchema } from '../plugins/actions/jsonSchemaCompiler.js';
import { compilePluginJsonSchema } from '../plugins/actions/jsonSchemaValidation.js';
import { type PluginJsonSchemaValidator } from '../plugins/actions/protocolComposableSchema.js';
import { cloneStrictPluginJsonValue } from '../plugins/contributions/strictJsonValue.js';

const ACTION_JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

function assertDocumentLocalActionSchema(schema: unknown): void {
  if (typeof schema === 'boolean') return;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('Invalid Action JSON Schema: expected a schema object');
  }
  const node = schema as Readonly<Record<string, unknown>>;
  if (node.$schema !== undefined && node.$schema !== ACTION_JSON_SCHEMA_DIALECT) {
    throw new Error('Invalid Action JSON Schema: unsupported nested dialect');
  }
  if (node.$ref !== undefined && (typeof node.$ref !== 'string' || !/^#(?:\/.*)?$/u.test(node.$ref))) {
    throw new Error('Invalid Action JSON Schema: references must be document-local JSON Pointers');
  }
  for (const keyword of ['$id', '$anchor', '$dynamicRef', '$dynamicAnchor', '$async']) {
    if (node[keyword] !== undefined) throw new Error('Invalid Action JSON Schema: only synchronous document-local schemas are supported');
  }
  // Visit schema positions only: a literal/default JSON value can itself contain
  // keys such as "$ref" without acquiring schema or reference authority.
  for (const keyword of ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']) {
    const children = node[keyword];
    if (children !== null && typeof children === 'object' && !Array.isArray(children)) {
      for (const child of Object.values(children)) assertDocumentLocalActionSchema(child);
    }
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const children = node[keyword];
    if (Array.isArray(children)) for (const child of children) assertDocumentLocalActionSchema(child);
  }
  for (const keyword of ['not', 'if', 'then', 'else', 'items', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames']) {
    if (node[keyword] !== undefined) assertDocumentLocalActionSchema(node[keyword]);
  }
}

/** Compiles the published native Action dialect without broadening Plugin admission. */
export function compileActionInputJsonSchema(schema: object): PluginJsonSchemaValidator {
  const normalized = cloneStrictPluginJsonValue(schema, 'schema');
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new Error('Invalid Action JSON Schema: expected a schema object');
  }
  if (!('$schema' in normalized) || normalized.$schema !== ACTION_JSON_SCHEMA_DIALECT) return compilePluginJsonSchema(schema);
  assertDocumentLocalActionSchema(normalized);
  return compileProtocolJsonSchema(normalized, 'draft-2020-12');
}
