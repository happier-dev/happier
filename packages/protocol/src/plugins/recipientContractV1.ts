import { bytesToHex } from '@noble/hashes/utils';
import { asProtocolZod } from "./actions/internalProtocolZodAdapter.js";
import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';

import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from './contributionIdentity.js';
import { PluginIdSchema } from './pluginId.js';
import {
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './contributions/publicTypes.js';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from './actions/jsonSchemaValidation.js';

const RecipientContractDigestV1Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export type RecipientContractDigestV1 = z.infer<typeof RecipientContractDigestV1Schema>;

const RecipientPackageSourceV1Schema = z.object({
  kind: z.enum(['bundled', 'path', 'marketplace', 'package', 'archive']),
  locator: z.string().trim().min(1).max(2_048),
}).strict();

const RecipientPackageIdentityV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  source: RecipientPackageSourceV1Schema,
}).strict();

const RecipientPublisherIdentityV1Schema = z.object({
  trust: z.enum(['bundled', 'verified']),
  identity: z.string().trim().min(1).max(2_048),
}).strict();

const RecipientCredentialSlotV1Schema = z.object({
  id: z.string().trim().min(1).max(128),
  scope: z.literal('account'),
}).strict();

const RecipientOperationIdV1Schema = PluginContributionLocalIdSchema;
const RecipientOperationIdV1ZodSchema = asProtocolZod(RecipientOperationIdV1Schema);
const RecipientPurposeIdV1Schema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);

const CanonicalHttpsOriginSchema = z.string().trim().max(2_048).superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || url.origin !== value
    ) {
      context.addIssue({ code: 'custom', message: 'Expected an exact canonical HTTPS origin' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected an exact canonical HTTPS origin' });
  }
});

const HeaderNameSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/u)
  .transform((value) => value.toLowerCase());

const ContentTypeSchema = z.string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u)
  .transform((value) => value.toLowerCase());

const RecipientStaticTemplateEntryV1Schema = z.object({
  name: z.string().trim().min(1).max(256),
  value: z.string().max(16_384),
}).strict();

const RecipientBodyTemplateV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('json'), value: PluginJsonValueV2Schema }).strict(),
]);

const RecipientCredentialPlacementV1Schema = z.object({
  kind: z.literal('httpHeader'),
  name: HeaderNameSchema,
  format: z.enum(['raw', 'bearer']),
}).strict();

const RecipientParameterMappingTargetV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('path'),
    placeholder: z.string().trim().min(1).max(128),
    encoding: z.literal('uri_component'),
  }).strict(),
  z.object({
    kind: z.literal('query'),
    name: z.string().trim().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal('header'),
    name: HeaderNameSchema,
  }).strict(),
  z.object({
    kind: z.literal('body'),
    pointer: z.string().max(1_024).regex(/^(?:\/(?:[^~/]|~0|~1)*)*$/u),
  }).strict(),
]);

const RecipientParameterMappingV1Schema = z.object({
  parameter: z.string().trim().min(1).max(128),
  target: RecipientParameterMappingTargetV1Schema,
}).strict();

export const RecipientOperationV1Schema = z.object({
  id: RecipientOperationIdV1ZodSchema,
  purpose: RecipientPurposeIdV1Schema,
  credentialSlotId: z.string().trim().min(1).max(128),
  effect: z.enum(['read', 'mutation']),
  request: z.object({
    origin: CanonicalHttpsOriginSchema,
    pathTemplate: z.string()
      .min(1)
      .max(2_048)
      .startsWith('/')
      .refine((value) => (
        !value.startsWith('//')
        && !value.includes('\\')
        && !value.includes('%')
        && !value.includes('?')
        && !value.includes('#')
        && !/(?:^|\/)\.{1,2}(?:\/|$)/u.test(value)
      ), {
        message: 'Path templates must be canonical origin-relative paths',
      }),
    queryTemplate: z.array(RecipientStaticTemplateEntryV1Schema).max(64),
    headerTemplate: z.array(RecipientStaticTemplateEntryV1Schema.extend({
      name: HeaderNameSchema,
    }).strict()).max(64),
    bodyTemplate: RecipientBodyTemplateV1Schema,
    method: z.enum(['GET', 'POST', 'PATCH']),
    credential: RecipientCredentialPlacementV1Schema,
    redirect: z.literal('error'),
    maxBodyBytes: z.number().int().min(0).max(4 * 1024 * 1024),
    contentTypes: z.array(ContentTypeSchema).max(16),
  }).strict(),
  parameters: z.object({
    schema: PluginJsonSchemaV2Schema,
    mapping: z.array(RecipientParameterMappingV1Schema).max(128),
  }).strict(),
  response: z.object({
    maxBytes: z.number().int().min(1).max(8 * 1024 * 1024),
    contentTypes: z.array(ContentTypeSchema).min(1).max(16),
  }).strict(),
}).strict().superRefine((operation, context) => {
  const schema = operation.parameters.schema;
  const properties = schema.type === 'object' && schema.properties
    ? schema.properties
    : null;
  if (!properties || schema.additionalProperties !== false) {
    context.addIssue({
      code: 'custom',
      path: ['parameters', 'schema'],
      message: 'Recipient operation parameters require a closed object schema',
    });
    return;
  }
  const mappedTargets = new Set<string>();
  const pathMappings = new Set<string>();
  const staticQueryNames = new Set(operation.request.queryTemplate.map((entry) => entry.name));
  const staticHeaderNames = new Set(operation.request.headerTemplate.map((entry) => entry.name));
  for (const [index, mapping] of operation.parameters.mapping.entries()) {
    if (!Object.prototype.hasOwnProperty.call(properties, mapping.parameter)) {
      context.addIssue({
        code: 'custom',
        path: ['parameters', 'mapping', index, 'parameter'],
        message: 'Recipient parameter mappings must reference declared properties',
      });
    }
    const targetKey = JSON.stringify(mapping.target);
    if (mappedTargets.has(targetKey)) {
      context.addIssue({
        code: 'custom',
        path: ['parameters', 'mapping', index, 'target'],
        message: 'Recipient parameter mapping targets must be unique',
      });
    }
    mappedTargets.add(targetKey);
    if (mapping.target.kind === 'path') pathMappings.add(mapping.target.placeholder);
    if (
      mapping.target.kind === 'header'
      && (
        mapping.target.name === operation.request.credential.name
        || staticHeaderNames.has(mapping.target.name)
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['parameters', 'mapping', index, 'target', 'name'],
        message: 'Credential headers cannot be populated by parameters',
      });
    }
    if (mapping.target.kind === 'query' && staticQueryNames.has(mapping.target.name)) {
      context.addIssue({
        code: 'custom',
        path: ['parameters', 'mapping', index, 'target', 'name'],
        message: 'Recipient query parameters cannot replace static query template entries',
      });
    }
  }
  const placeholders = [...operation.request.pathTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9_-]*)\}/gu)]
    .map((match) => match[1]!);
  if (
    new Set(placeholders).size !== placeholders.length
    || placeholders.some((placeholder) => !pathMappings.has(placeholder))
    || [...pathMappings].some((placeholder) => !placeholders.includes(placeholder))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['request', 'pathTemplate'],
      message: 'Path placeholders and path parameter mappings must match exactly',
    });
  }
  staticHeaderNames.clear();
  for (const [index, header] of operation.request.headerTemplate.entries()) {
    if (
      header.name === operation.request.credential.name
      || staticHeaderNames.has(header.name)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['request', 'headerTemplate', index, 'name'],
        message: 'Recipient non-secret header names must be unique and cannot target the credential header',
      });
    }
    staticHeaderNames.add(header.name);
  }
  staticQueryNames.clear();
  for (const [index, query] of operation.request.queryTemplate.entries()) {
    if (staticQueryNames.has(query.name)) {
      context.addIssue({
        code: 'custom',
        path: ['request', 'queryTemplate', index, 'name'],
        message: 'Recipient static query names must be unique',
      });
    }
    staticQueryNames.add(query.name);
  }
  if (operation.request.bodyTemplate.kind === 'none'
    && operation.parameters.mapping.some((mapping) => mapping.target.kind === 'body')) {
    context.addIssue({
      code: 'custom',
      path: ['request', 'bodyTemplate'],
      message: 'Body parameter mappings require a JSON body template',
    });
  }
  if (operation.request.method === 'GET'
    && operation.request.bodyTemplate.kind !== 'none') {
    context.addIssue({
      code: 'custom',
      path: ['request', 'bodyTemplate'],
      message: 'GET recipient operations cannot declare a body',
    });
  }
});

export const RecipientContractV1Schema = z.object({
  version: z.literal(1),
  package: RecipientPackageIdentityV1Schema,
  publisher: RecipientPublisherIdentityV1Schema,
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  credentialSlot: RecipientCredentialSlotV1Schema,
  operations: z.array(RecipientOperationV1Schema).min(1).max(64),
  presentation: z.object({
    title: PluginLocalizedStringV2Schema.optional(),
  }).strict().optional(),
}).strict().superRefine((contract, context) => {
  if (contract.package.pluginId !== contract.contribution.pluginId) {
    context.addIssue({
      code: 'custom',
      path: ['contribution', 'pluginId'],
      message: 'Recipient package and contribution plugin identities must match',
    });
  }
  const operationIds = new Set<string>();
  const purposes = new Set<string>();
  contract.operations.forEach((operation, index) => {
    if (operation.credentialSlotId !== contract.credentialSlot.id) {
      context.addIssue({
        code: 'custom',
        path: ['operations', index, 'credentialSlotId'],
        message: 'Recipient operations must reference the approved credential slot',
      });
    }
    if (operationIds.has(operation.id)) {
      context.addIssue({
        code: 'custom',
        path: ['operations', index, 'id'],
        message: 'Recipient operation ids must be unique',
      });
    }
    if (purposes.has(operation.purpose)) {
      context.addIssue({
        code: 'custom',
        path: ['operations', index, 'purpose'],
        message: 'Recipient operation purpose ids must be unique',
      });
    }
    operationIds.add(operation.id);
    purposes.add(operation.purpose);
  });
});

export type RecipientContractV1 = Readonly<z.infer<typeof RecipientContractV1Schema>>;
export type RecipientOperationV1 = Readonly<z.infer<typeof RecipientOperationV1Schema>>;

function normalizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonSchema);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const normalized = normalizeJsonSchema((value as Record<string, unknown>)[key]);
    output[key] = key === 'required' && Array.isArray(normalized)
      ? [...normalized].sort()
      : normalized;
  }
  return output;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return output;
}

export function normalizeRecipientContractV1(input: unknown): RecipientContractV1 {
  const parsed = RecipientContractV1Schema.parse(input);
  const operations = [...parsed.operations]
    .map((operation) => Object.freeze({
      ...operation,
      request: Object.freeze({
        ...operation.request,
        queryTemplate: [...operation.request.queryTemplate]
          .sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value)),
        headerTemplate: [...operation.request.headerTemplate]
          .sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value)),
        contentTypes: [...new Set(operation.request.contentTypes)].sort(),
      }),
      parameters: Object.freeze({
        schema: normalizeJsonSchema(operation.parameters.schema) as typeof operation.parameters.schema,
        mapping: [...operation.parameters.mapping].sort((left, right) => (
          left.parameter.localeCompare(right.parameter)
          || JSON.stringify(left.target).localeCompare(JSON.stringify(right.target))
        )),
      }),
      response: Object.freeze({
        ...operation.response,
        contentTypes: [...new Set(operation.response.contentTypes)].sort(),
      }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    version: 1,
    package: Object.freeze(parsed.package),
    publisher: Object.freeze(parsed.publisher),
    contribution: Object.freeze(parsed.contribution),
    credentialSlot: Object.freeze(parsed.credentialSlot),
    operations,
    ...(parsed.presentation ? { presentation: Object.freeze(parsed.presentation) } : {}),
  });
}

export function serializeRecipientContractV1(input: unknown): string {
  const { presentation: _presentation, ...contract } = normalizeRecipientContractV1(input);
  return JSON.stringify(canonicalize(contract));
}

export function createRecipientContractDigestV1(input: unknown): RecipientContractDigestV1 {
  const bytes = new TextEncoder().encode(serializeRecipientContractV1(input));
  return RecipientContractDigestV1Schema.parse(`sha256:${bytesToHex(sha256(bytes))}`);
}

/**
 * Final Voice declaration projection. The credential slot and mediated
 * operations stay owned by `credentials`; callers do not reconstruct the
 * retired top-level account-mediation shape.
 */
export function createVoiceProviderRecipientContractFromCredentialsV1(input: Readonly<{
  package: RecipientContractV1['package'];
  publisher: RecipientContractV1['publisher'];
  contribution: RecipientContractV1['contribution'];
  credentials: Readonly<{
    slot: Readonly<{ id: RecipientContractV1['credentialSlot']['id'] }>;
    hostMediated: Readonly<{ operations: readonly RecipientOperationV1[] }>;
  }>;
  presentation?: RecipientContractV1['presentation'];
}>): RecipientContractV1 {
  return normalizeRecipientContractV1({
    version: 1,
    package: input.package,
    publisher: input.publisher,
    contribution: input.contribution,
    credentialSlot: { id: input.credentials.slot.id, scope: 'account' },
    operations: input.credentials.hostMediated.operations,
    ...(input.presentation ? { presentation: input.presentation } : {}),
  });
}

export type MaterializedRecipientOperationRequestV1 = Readonly<{
  operation: RecipientOperationV1;
  url: string;
  method: 'GET' | 'POST' | 'PATCH';
  headers: Readonly<Record<string, string>>;
  body: Uint8Array | null;
  redirect: 'error';
}>;

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readParameter(
  parameters: Readonly<Record<string, unknown>>,
  name: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(parameters, name)) {
    throw new TypeError(`Missing recipient operation parameter '${name}'`);
  }
  return parameters[name];
}

function stringifyRequestScalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  throw new TypeError('Recipient path, query, and header parameters must be scalar values');
}

function setJsonPointer(target: unknown, pointer: string, value: unknown): unknown {
  if (pointer === '') return cloneJsonValue(value);
  if (!target || typeof target !== 'object') {
    throw new TypeError('Recipient body mappings require an object or array body template');
  }
  const segments = pointer.slice(1).split('/').map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  let cursor = target as Record<string, unknown> | unknown[];
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      if (Array.isArray(cursor)) {
        const arrayIndex = Number(segment);
        if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= cursor.length) {
          throw new TypeError('Recipient body mapping array index is outside the declared template');
        }
        cursor[arrayIndex] = cloneJsonValue(value);
      } else {
        cursor[segment] = cloneJsonValue(value);
      }
      return target;
    }
    const next = Array.isArray(cursor)
      ? cursor[Number(segment)]
      : cursor[segment];
    if (!next || typeof next !== 'object') {
      throw new TypeError('Recipient body mapping pointer does not exist in the declared template');
    }
    cursor = next as Record<string, unknown> | unknown[];
  }
  return target;
}

export function materializeRecipientOperationRequestV1(input: Readonly<{
  contract: unknown;
  operationId: string;
  parameters: unknown;
}>): MaterializedRecipientOperationRequestV1 {
  const contract = normalizeRecipientContractV1(input.contract);
  const operation = contract.operations.find((candidate) => candidate.id === input.operationId);
  if (!operation) throw new TypeError('Unknown recipient operation');
  return materializeRecipientOperationRequestV1FromOperation({
    operation,
    parameters: input.parameters,
  });
}

export function materializeRecipientOperationRequestV1FromOperation(input: Readonly<{
  operation: unknown;
  parameters: unknown;
}>): MaterializedRecipientOperationRequestV1 {
  const operation = RecipientOperationV1Schema.parse(input.operation);
  const validate = compilePluginJsonSchema(operation.parameters.schema);
  if (!isValidPluginJsonSchemaValue(validate, input.parameters)) {
    throw new TypeError('Invalid recipient operation parameters');
  }
  const parameters = input.parameters as Readonly<Record<string, unknown>>;
  let path = operation.request.pathTemplate;
  const query = new URLSearchParams(operation.request.queryTemplate.map((entry) => [entry.name, entry.value]));
  const headers: Record<string, string> = Object.fromEntries(
    operation.request.headerTemplate.map((entry) => [entry.name, entry.value]),
  );
  let bodyValue: unknown = operation.request.bodyTemplate.kind === 'json'
    ? cloneJsonValue(operation.request.bodyTemplate.value)
    : null;
  for (const mapping of operation.parameters.mapping) {
    if (
      !Object.prototype.hasOwnProperty.call(parameters, mapping.parameter)
      && (mapping.target.kind === 'query' || mapping.target.kind === 'header')
    ) {
      continue;
    }
    const value = readParameter(parameters, mapping.parameter);
    if (mapping.target.kind === 'path') {
      path = path.replace(
        `{${mapping.target.placeholder}}`,
        encodeURIComponent(stringifyRequestScalar(value)),
      );
    } else if (mapping.target.kind === 'query') {
      query.set(mapping.target.name, stringifyRequestScalar(value));
    } else if (mapping.target.kind === 'header') {
      headers[mapping.target.name] = stringifyRequestScalar(value);
    } else {
      bodyValue = setJsonPointer(bodyValue, mapping.target.pointer, value);
    }
  }
  if (/\{[A-Za-z][A-Za-z0-9_-]*\}/u.test(path)) {
    throw new TypeError('Recipient operation path contains an unresolved placeholder');
  }
  const url = new URL(path, operation.request.origin);
  if (
    url.origin !== operation.request.origin
    || url.protocol !== 'https:'
    || url.username
    || url.password
  ) {
    throw new TypeError('Recipient operation URL escaped the declared origin');
  }
  for (const [name, value] of query) url.searchParams.set(name, value);
  const body = operation.request.bodyTemplate.kind === 'json'
    ? new TextEncoder().encode(JSON.stringify(bodyValue))
    : null;
  if ((body?.byteLength ?? 0) > operation.request.maxBodyBytes) {
    throw new TypeError('Recipient operation body exceeds the declared bound');
  }
  return Object.freeze({
    operation,
    url: url.toString(),
    method: operation.request.method,
    headers: Object.freeze(headers),
    body,
    redirect: 'error',
  });
}
