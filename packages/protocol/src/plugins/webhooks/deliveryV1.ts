import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { normalizePluginJsonSchema } from '../actions/protocolComposableSchema.js';

import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import { PluginMachineMaterializationRefV1Schema } from '../availability/materializationRefV1.js';
import { PluginWebhookEndpointIdV1Schema } from './endpointV1.js';
import { PluginWebhookAutomationAdmissionUnresolvedV1Schema } from './statusV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1 = 26_214_400;
export const PLUGIN_WEBHOOK_MAX_ENCODED_RAW_BODY_CHARS_V1 = 34_952_536;
export const PLUGIN_WEBHOOK_MAX_CONTENT_JSON_BYTES_V1 = 36_700_160;
export const PLUGIN_WEBHOOK_MAX_ENCRYPTED_BUNDLE_BYTES_V1 = 36_700_232;
export const PLUGIN_WEBHOOK_MAX_STORED_ENVELOPE_BYTES_V1 = 51_380_224;

const ASCII_TOKEN_128_SCHEMA = z.string().check(z.regex(/^[A-Za-z0-9._:-]{1,128}$/u));
const WEBHOOK_EVENT_SCHEMA = z.string().check(z.regex(/^[A-Za-z0-9._-]{1,128}$/u));
const SIGNED_WEBHOOK_VERIFIER_SCHEMA = z.enum(['github_hmac_sha256_v1', 'sentry_hmac_sha256_v1']);

/** The one provider event header each signed verifier selects into delivery content. */
const SELECTED_EVENT_HEADER_BY_VERIFIER_V1 = {
  github_hmac_sha256_v1: 'x-github-event',
  sentry_hmac_sha256_v1: 'sentry-hook-resource',
} as const;
const CONTENT_TYPE_SCHEMA = z.string().check(z.maxLength(128), z.regex(/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/u));
const DIAGNOSTIC_CODE_SCHEMA = z.string().check(z.regex(/^[a-z0-9._-]{1,64}$/u));
const ENDPOINT_REVISION_SCHEMA = z.number().check(z.int(), z.positive(), z.int());

function isCanonicalPaddedBase64(value: string, expectedBytes?: number): boolean {
  const decodedLength = readCanonicalPaddedBase64DecodedLength(value);
  if (decodedLength === null || (expectedBytes !== undefined && decodedLength !== expectedBytes)) return false;

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (value.endsWith('==')) {
    const sextet = alphabet.indexOf(value[value.length - 3] ?? '');
    return sextet >= 0 && (sextet & 0b1111) === 0;
  }
  if (value.endsWith('=')) {
    const sextet = alphabet.indexOf(value[value.length - 2] ?? '');
    return sextet >= 0 && (sextet & 0b11) === 0;
  }
  return true;
}

const PluginWebhookSelectedHeaderV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  name: z.enum(['x-github-event', 'sentry-hook-resource']),
  value: WEBHOOK_EVENT_SCHEMA,
})));

function checkSelectedEventHeaderV1(
  selected: Readonly<{ name: string; value: string }> | undefined,
  verified: Readonly<{ verifier: keyof typeof SELECTED_EVENT_HEADER_BY_VERIFIER_V1; eventType?: string | undefined }>,
): string | null {
  if (selected?.value !== verified.eventType) return 'Verified event type must match the selected event header';
  if (selected && selected.name !== SELECTED_EVENT_HEADER_BY_VERIFIER_V1[verified.verifier]) {
    return 'Selected event header must belong to the verifier';
  }
  return null;
}

const PluginWebhookVerifiedContentV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  verifier: SIGNED_WEBHOOK_VERIFIER_SCHEMA,
  providerDeliveryId: ASCII_TOKEN_128_SCHEMA,
  eventType: z.optional(WEBHOOK_EVENT_SCHEMA),
  credentialVersionId: ASCII_TOKEN_128_SCHEMA,
})));

export const PluginWebhookDeliveryContentV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  v: z.literal(1),
  receivedAtMs: z.number().check(z.int(), z.nonnegative(), z.int()),
  contentType: z.nullable(CONTENT_TYPE_SCHEMA),
  headers: z.readonly(z.array(PluginWebhookSelectedHeaderV1Schema).check(z.maxLength(1))),
  rawBodyBytes: z.number().check(z.int(), z.minimum(0), z.maximum(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1)),
  rawBodyBase64: z.string().check(z.maxLength(PLUGIN_WEBHOOK_MAX_ENCODED_RAW_BODY_CHARS_V1)),
  verified: PluginWebhookVerifiedContentV1Schema,
}).check(z.superRefine((value, context) => {
  if (!isCanonicalPaddedBase64(value.rawBodyBase64, value.rawBodyBytes)) {
    context.addIssue({ code: 'custom', path: ['rawBodyBase64'], message: 'Raw body must be canonical padded base64 with the declared decoded length' });
  }
  const headerIssue = checkSelectedEventHeaderV1(value.headers[0], value.verified);
  if (headerIssue) context.addIssue({ code: 'custom', path: ['verified', 'eventType'], message: headerIssue });
}))));

const PluginWebhookEncryptedContentV1Schema = lazyZodSchema(() => z.strictObject({
  t: z.literal('encrypted'),
  c: z.string().check(z.maxLength(48_933_644)),
}).check(z.superRefine((value, context) => {
  const decodedLength = readCanonicalPaddedBase64DecodedLength(value.c);
  if (!isCanonicalPaddedBase64(value.c) || decodedLength === null || decodedLength > PLUGIN_WEBHOOK_MAX_ENCRYPTED_BUNDLE_BYTES_V1) {
    context.addIssue({ code: 'custom', path: ['c'], message: 'Encrypted content must be a bounded canonical padded base64 bundle' });
  }
})));

export const StoredPluginWebhookDeliveryContentV1Schema = lazyZodSchema(() => z.readonly(z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: PluginWebhookDeliveryContentV1Schema }),
  PluginWebhookEncryptedContentV1Schema,
])));

const QualifiedWebhookContributionRefV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  localId: asProtocolZod(PluginContributionLocalIdSchema),
}));

export const PluginWebhookActionInputV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  v: z.literal(1),
  endpoint: z.strictObject({
    webhookContribution: QualifiedWebhookContributionRefV1Schema,
    sourceInstanceId: ASCII_TOKEN_128_SCHEMA,
  }),
  delivery: z.strictObject({
    deliveryId: ASCII_TOKEN_128_SCHEMA,
    attempt: z.number().check(z.int(), z.minimum(1), z.maximum(12)),
    replay: z.number().check(z.int(), z.minimum(0), z.maximum(10)),
    receivedAtMs: z.number().check(z.int(), z.nonnegative(), z.int()),
    providerDeliveryId: ASCII_TOKEN_128_SCHEMA,
  }),
  request: z.strictObject({
    contentType: z.nullable(CONTENT_TYPE_SCHEMA),
    headers: z.readonly(z.array(PluginWebhookSelectedHeaderV1Schema).check(z.maxLength(1))),
    rawBodyBytes: z.number().check(z.int(), z.minimum(0), z.maximum(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1)),
    rawBodyBase64: z.string().check(z.maxLength(PLUGIN_WEBHOOK_MAX_ENCODED_RAW_BODY_CHARS_V1)),
  }),
  verified: z.strictObject({
    verifier: SIGNED_WEBHOOK_VERIFIER_SCHEMA,
    eventType: z.optional(WEBHOOK_EVENT_SCHEMA),
  }),
}).check(z.superRefine((value, context) => {
  if (!isCanonicalPaddedBase64(value.request.rawBodyBase64, value.request.rawBodyBytes)) {
    context.addIssue({ code: 'custom', path: ['request', 'rawBodyBase64'], message: 'Raw body must be canonical padded base64 with the declared decoded length' });
  }
  const headerIssue = checkSelectedEventHeaderV1(value.request.headers[0], value.verified);
  if (headerIssue) context.addIssue({ code: 'custom', path: ['verified', 'eventType'], message: headerIssue });
}))));

export const PluginWebhookActionResultV1Schema = lazyZodSchema(() => z.readonly(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('settled'), disposition: z.enum(['accepted', 'ignored']) }),
  z.strictObject({ kind: z.literal('retry'), code: DIAGNOSTIC_CODE_SCHEMA }),
  z.strictObject({ kind: z.literal('deadLetter'), code: DIAGNOSTIC_CODE_SCHEMA }),
])));

/** Action declarations project the same parsers that retain dispatch refinements. */
export const PluginWebhookActionInputV1DeclarationSchema = lazyDefinition(() => Object.freeze({
  jsonSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(PluginWebhookActionInputV1Schema, { target: 'draft-7' })),
  parse: (value: unknown) => PluginWebhookActionInputV1Schema.parse(value),
  safeParse: (value: unknown) => PluginWebhookActionInputV1Schema.safeParse(value),
}));
export const PluginWebhookActionResultV1DeclarationSchema = lazyDefinition(() => Object.freeze({
  jsonSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(PluginWebhookActionResultV1Schema, { target: 'draft-7' })),
  parse: (value: unknown) => PluginWebhookActionResultV1Schema.parse(value),
  safeParse: (value: unknown) => PluginWebhookActionResultV1Schema.safeParse(value),
}));

const PluginWebhookClaimTargetV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  materialization: PluginMachineMaterializationRefV1Schema,
  machineInstallationId: z.string().check(z.minLength(1), z.maxLength(256), z.refine((value) => value === value.trim())),
})));

/**
 * Claim authority is the authenticated Account/machine installation pair. The
 * server selects the one currently eligible exact materialization target; only
 * renew/complete/fail address work by exact target.
 */
export const PluginWebhookMachineInstallationV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  machineId: z.string().check(z.minLength(1), z.maxLength(256), z.refine((value) => value === value.trim())),
  machineInstallationId: z.string().check(z.minLength(1), z.maxLength(256), z.refine((value) => value === value.trim())),
})));

const PluginWebhookLeaseIdentityV1Shape = {
  leaseId: ASCII_TOKEN_128_SCHEMA,
  revision: z.number().check(z.int(), z.nonnegative(), z.int()),
};

const PluginWebhookLeaseIdentityV1Schema = lazyZodSchema(() => z.readonly(z.strictObject(PluginWebhookLeaseIdentityV1Shape)));

const PluginWebhookClaimedEndpointV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: ENDPOINT_REVISION_SCHEMA,
  webhookContribution: QualifiedWebhookContributionRefV1Schema,
  handlerActionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  sourceInstanceId: ASCII_TOKEN_128_SCHEMA,
})));

/**
 * Host-only proof that an Event operation originates inside the currently
 * claimed Webhook Action. This is never exposed through plugin Action input.
 */
export const PluginWebhookInvocationReferenceV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  v: z.literal(1),
  deliveryId: ASCII_TOKEN_128_SCHEMA,
  endpoint: PluginWebhookClaimedEndpointV1Schema,
  target: PluginWebhookClaimTargetV1Schema,
  lease: PluginWebhookLeaseIdentityV1Schema,
})));

export const PluginWebhookClaimRequestV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  v: z.literal(1),
  policyVersion: z.literal(1),
  machine: PluginWebhookMachineInstallationV1Schema,
})));

export const PluginWebhookClaimResultV1Schema = lazyZodSchema(() => z.readonly(z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('none'),
    retryAfterMs: z.number().check(z.int(), z.minimum(1), z.maximum(60_000)),
  }),
  z.strictObject({
    kind: z.literal('delivery'),
    deliveryId: ASCII_TOKEN_128_SCHEMA,
    // Exact server-selected target plus frozen materialization/release/version
    // authority for this delivery; the daemon dispatches exactly what the
    // response carries.
    target: PluginWebhookClaimTargetV1Schema,
    pluginVersion: z.string().check(z.minLength(1), z.maxLength(256)),
    endpoint: PluginWebhookClaimedEndpointV1Schema,
    attempt: z.number().check(z.int(), z.minimum(1), z.maximum(12)),
    replay: z.number().check(z.int(), z.minimum(0), z.maximum(10)),
    receivedAtMs: z.number().check(z.int(), z.nonnegative(), z.int()),
    envelope: StoredPluginWebhookDeliveryContentV1Schema,
    lease: z.readonly(z.strictObject({
      ...PluginWebhookLeaseIdentityV1Shape,
      firstClaimAtMs: z.number().check(z.int(), z.nonnegative(), z.int()),
      expiresAtMs: z.number().check(z.int(), z.nonnegative(), z.int()),
      maxClaimUntilMs: z.number().check(z.int(), z.nonnegative(), z.int()),
    })),
  }),
])));

export const PluginWebhookRenewRequestV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  v: z.literal(1),
  target: PluginWebhookClaimTargetV1Schema,
  lease: PluginWebhookLeaseIdentityV1Schema,
  transition: z.enum(['renew', 'executionStarted']),
})));

export const PluginWebhookRenewResultV1Schema = lazyZodSchema(() => z.readonly(z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('renewed'),
    revision: z.number().check(z.int(), z.nonnegative(), z.int()),
    expiresAtMs: z.number().check(z.int(), z.nonnegative(), z.int()),
  }),
  z.strictObject({ kind: z.literal('leaseLost') }),
  z.strictObject({ kind: z.literal('unavailable'), code: DIAGNOSTIC_CODE_SCHEMA }),
])));

const PluginWebhookSettleBaseV1Shape = {
  v: z.literal(1),
  target: PluginWebhookClaimTargetV1Schema,
  lease: PluginWebhookLeaseIdentityV1Schema,
};

export const PluginWebhookCompleteRequestV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  ...PluginWebhookSettleBaseV1Shape,
  result: z.readonly(z.strictObject({
    kind: z.literal('settled'),
    disposition: z.enum(['accepted', 'ignored']),
  })),
})));

export const PluginWebhookFailRequestV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  ...PluginWebhookSettleBaseV1Shape,
  result: z.readonly(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('retry'), code: DIAGNOSTIC_CODE_SCHEMA }),
    z.strictObject({ kind: z.literal('deadLetter'), code: DIAGNOSTIC_CODE_SCHEMA }),
  ])),
  // Host-private daemon-to-server diagnostic carrier. Plugin-authored Action
  // results remain marker-only and cannot author this field.
  automationAdmissionUnresolved: z.optional(PluginWebhookAutomationAdmissionUnresolvedV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.automationAdmissionUnresolved !== undefined && value.result.kind !== 'retry') {
    context.addIssue({
      code: "custom",
      path: ['automationAdmissionUnresolved'],
      message: 'Unresolved Automation diagnostics are valid only for a retry failure',
    });
  }
}))));

export const PluginWebhookSettleResultV1Schema = lazyZodSchema(() => z.readonly(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('settled'), state: z.enum(['queued', 'succeeded', 'dead_letter']) }),
  z.strictObject({ kind: z.literal('leaseLost') }),
  z.strictObject({ kind: z.literal('unavailable'), code: DIAGNOSTIC_CODE_SCHEMA }),
])));

export type PluginWebhookDeliveryContentV1 = z.infer<typeof PluginWebhookDeliveryContentV1Schema>;
export type StoredPluginWebhookDeliveryContentV1 = z.infer<typeof StoredPluginWebhookDeliveryContentV1Schema>;
export type PluginWebhookActionInputV1 = z.infer<typeof PluginWebhookActionInputV1Schema>;
export type PluginWebhookActionResultV1 = z.infer<typeof PluginWebhookActionResultV1Schema>;
export type PluginWebhookClaimRequestV1 = z.infer<typeof PluginWebhookClaimRequestV1Schema>;
export type PluginWebhookClaimResultV1 = z.infer<typeof PluginWebhookClaimResultV1Schema>;
export type PluginWebhookMachineInstallationV1 = z.infer<typeof PluginWebhookMachineInstallationV1Schema>;
export type PluginWebhookInvocationReferenceV1 = z.infer<typeof PluginWebhookInvocationReferenceV1Schema>;
export type PluginWebhookRenewRequestV1 = z.infer<typeof PluginWebhookRenewRequestV1Schema>;
export type PluginWebhookRenewResultV1 = z.infer<typeof PluginWebhookRenewResultV1Schema>;
export type PluginWebhookCompleteRequestV1 = z.infer<typeof PluginWebhookCompleteRequestV1Schema>;
export type PluginWebhookFailRequestV1 = z.infer<typeof PluginWebhookFailRequestV1Schema>;
export type PluginWebhookSettleResultV1 = z.infer<typeof PluginWebhookSettleResultV1Schema>;

export function serializePluginWebhookDeliveryContentV1(value: unknown): Uint8Array {
  const parsed = PluginWebhookDeliveryContentV1Schema.parse(value);
  return new TextEncoder().encode(createCanonicalJsonSigningInput(parsed));
}

export function serializeStoredPluginWebhookDeliveryContentV1(value: unknown): Uint8Array {
  const parsed = StoredPluginWebhookDeliveryContentV1Schema.parse(value);
  return new TextEncoder().encode(createCanonicalJsonSigningInput(parsed));
}
