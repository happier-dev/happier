import { forEachJsonSchemaChild } from './actionInputJsonSchema.js';
import { compileProtocolJsonSchema } from '../plugins/actions/jsonSchemaCompiler.js';
import { compilePluginJsonSchema } from '../plugins/actions/jsonSchemaValidation.js';
import type { PluginJsonSchemaValidator } from '../plugins/actions/protocolComposableSchema.js';
import { cloneStrictPluginJsonValue } from '../plugins/contributions/strictJsonValue.js';

export { readCompleteActionSpecV1 } from './actionSpecSections.js';

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
  forEachJsonSchemaChild(node, assertDocumentLocalActionSchema);
}

/** Compiles the published native Action dialect without broadening Plugin admission. */
export function compileActionInputJsonSchema(schema: object): PluginJsonSchemaValidator {
  // Choose the dialect without invoking an accessor; strict JSON admission still
  // runs on the first compilation. The compiler keys the caller's immutable
  // identity before preparing the cloned schema, as it does for Plugin schemas.
  if (Object.getOwnPropertyDescriptor(schema, '$schema')?.value === ACTION_JSON_SCHEMA_DIALECT) {
    return compileProtocolJsonSchema(schema, 'draft-2020-12', prepareActionInputJsonSchema);
  }
  prepareActionInputJsonSchema(schema);
  return compilePluginJsonSchema(schema);
}

function prepareActionInputJsonSchema(schema: object): object {
  const normalized = cloneStrictPluginJsonValue(schema, 'schema');
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new Error('Invalid Action JSON Schema: expected a schema object');
  }
  if ('$schema' in normalized && normalized.$schema === ACTION_JSON_SCHEMA_DIALECT) assertDocumentLocalActionSchema(normalized);
  return normalized;
}

/**
 * Non-ignorable Message fields need evidence from the selected host's schema.
 * A passthrough predecessor accepting the actual input is not sufficient: the
 * same parser must also reject an invalid value for every requested semantic.
 */
export function supportsSessionMessageInputJsonSchema(
  schema: object,
  input: Readonly<Record<string, unknown>>,
): boolean {
  try {
    const validate = compileActionInputJsonSchema(schema);
    const structuredInput = input.structuredInput;
    return validate(input)
      && (input.reply === undefined || input.reply === 'none'
        || !validate({ ...input, reply: '__unsupported_reply__' }))
      && (input.returnToSessionId === undefined || !validate({ ...input, returnToSessionId: '' }))
      && (input.structuredInput === undefined || !validate({ ...input, structuredInput: null }))
      && (structuredInput === null || typeof structuredInput !== 'object' || Array.isArray(structuredInput)
        || Object.entries(structuredInput).every(([field, value]) => value === undefined
          || !['reviewComments', 'sessionAttachments', 'composerAttachments', 'browserContext', 'imageInputs', 'mentions',
            'vendorPluginMentions', 'skillMentions', 'discussionSelectionSourceV1'].includes(field)
          || !validate({ ...input, structuredInput: { ...structuredInput, [field]: null } })))
      && (input.modelOverride === undefined || !validate({ ...input, modelOverride: 42 }))
      && (input.providerConnectionId === undefined || !validate({ ...input, providerConnectionId: 42 }))
      && (input.attachments === undefined || !validate({ ...input, attachments: null }))
      && (input.source === undefined || !validate({ ...input, source: null }))
      && (input.idempotencyKey === undefined || !validate({ ...input, idempotencyKey: null }));
  } catch {
    return false;
  }
}
