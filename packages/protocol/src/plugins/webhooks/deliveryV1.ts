import { z } from 'zod';

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

const ASCII_TOKEN_128_SCHEMA = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const GITHUB_EVENT_SCHEMA = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u);
const CONTENT_TYPE_SCHEMA = z.string()
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/u);
const DIAGNOSTIC_CODE_SCHEMA = z.string().regex(/^[a-z0-9._-]{1,64}$/u);
const ENDPOINT_REVISION_SCHEMA = z.number().int().positive().safe();

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

const PluginWebhookSelectedHeaderV1Schema = z.object({
  name: z.literal('x-github-event'),
  value: GITHUB_EVENT_SCHEMA,
}).strict().readonly();

const PluginWebhookVerifiedContentV1Schema = z.object({
  verifier: z.literal('github_hmac_sha256_v1'),
  providerDeliveryId: ASCII_TOKEN_128_SCHEMA,
  eventType: GITHUB_EVENT_SCHEMA.optional(),
  credentialVersionId: ASCII_TOKEN_128_SCHEMA,
}).strict().readonly();

export const PluginWebhookDeliveryContentV1Schema = z.object({
  v: z.literal(1),
  receivedAtMs: z.number().int().nonnegative().safe(),
  contentType: CONTENT_TYPE_SCHEMA.nullable(),
  headers: z.array(PluginWebhookSelectedHeaderV1Schema).max(1).readonly(),
  rawBodyBytes: z.number().int().min(0).max(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1),
  rawBodyBase64: z.string().max(PLUGIN_WEBHOOK_MAX_ENCODED_RAW_BODY_CHARS_V1),
  verified: PluginWebhookVerifiedContentV1Schema,
}).strict().superRefine((value, context) => {
  if (!isCanonicalPaddedBase64(value.rawBodyBase64, value.rawBodyBytes)) {
    context.addIssue({ code: 'custom', path: ['rawBodyBase64'], message: 'Raw body must be canonical padded base64 with the declared decoded length' });
  }
  const eventHeader = value.headers[0]?.value;
  if (eventHeader !== value.verified.eventType) {
    context.addIssue({ code: 'custom', path: ['verified', 'eventType'], message: 'Verified event type must match the selected GitHub event header' });
  }
}).readonly();

const PluginWebhookEncryptedContentV1Schema = z.object({
  t: z.literal('encrypted'),
  c: z.string().max(48_933_644),
}).strict().superRefine((value, context) => {
  const decodedLength = readCanonicalPaddedBase64DecodedLength(value.c);
  if (!isCanonicalPaddedBase64(value.c) || decodedLength === null || decodedLength > PLUGIN_WEBHOOK_MAX_ENCRYPTED_BUNDLE_BYTES_V1) {
    context.addIssue({ code: 'custom', path: ['c'], message: 'Encrypted content must be a bounded canonical padded base64 bundle' });
  }
});

export const StoredPluginWebhookDeliveryContentV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: PluginWebhookDeliveryContentV1Schema }).strict(),
  PluginWebhookEncryptedContentV1Schema,
]).readonly();

const QualifiedWebhookContributionRefV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  localId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();

export const PluginWebhookActionInputV1Schema = z.object({
  v: z.literal(1),
  endpoint: z.object({
    webhookContribution: QualifiedWebhookContributionRefV1Schema,
    sourceInstanceId: ASCII_TOKEN_128_SCHEMA,
  }).strict(),
  delivery: z.object({
    deliveryId: ASCII_TOKEN_128_SCHEMA,
    attempt: z.number().int().min(1).max(12),
    replay: z.number().int().min(0).max(10),
    receivedAtMs: z.number().int().nonnegative().safe(),
    providerDeliveryId: ASCII_TOKEN_128_SCHEMA,
  }).strict(),
  request: z.object({
    contentType: CONTENT_TYPE_SCHEMA.nullable(),
    headers: z.array(PluginWebhookSelectedHeaderV1Schema).max(1).readonly(),
    rawBodyBytes: z.number().int().min(0).max(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1),
    rawBodyBase64: z.string().max(PLUGIN_WEBHOOK_MAX_ENCODED_RAW_BODY_CHARS_V1),
  }).strict(),
  verified: z.object({
    verifier: z.literal('github_hmac_sha256_v1'),
    eventType: GITHUB_EVENT_SCHEMA.optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (!isCanonicalPaddedBase64(value.request.rawBodyBase64, value.request.rawBodyBytes)) {
    context.addIssue({ code: 'custom', path: ['request', 'rawBodyBase64'], message: 'Raw body must be canonical padded base64 with the declared decoded length' });
  }
  if (value.request.headers[0]?.value !== value.verified.eventType) {
    context.addIssue({ code: 'custom', path: ['verified', 'eventType'], message: 'Verified event type must match the selected GitHub event header' });
  }
}).readonly();

export const PluginWebhookActionResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('settled'), disposition: z.enum(['accepted', 'ignored']) }).strict(),
  z.object({ kind: z.literal('retry'), code: DIAGNOSTIC_CODE_SCHEMA }).strict(),
  z.object({ kind: z.literal('deadLetter'), code: DIAGNOSTIC_CODE_SCHEMA }).strict(),
]).readonly();

const PluginWebhookClaimTargetV1Schema = z.object({
  materialization: PluginMachineMaterializationRefV1Schema,
  machineInstallationId: z.string().min(1).max(256).refine((value) => value === value.trim()),
}).strict().readonly();

const PluginWebhookLeaseIdentityV1Shape = {
  leaseId: ASCII_TOKEN_128_SCHEMA,
  revision: z.number().int().nonnegative().safe(),
};

const PluginWebhookLeaseIdentityV1Schema = z.object(PluginWebhookLeaseIdentityV1Shape).strict().readonly();

const PluginWebhookClaimedEndpointV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: ENDPOINT_REVISION_SCHEMA,
  webhookContribution: QualifiedWebhookContributionRefV1Schema,
  handlerActionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  sourceInstanceId: ASCII_TOKEN_128_SCHEMA,
}).strict().readonly();

/**
 * Host-only proof that an Event operation originates inside the currently
 * claimed Webhook Action. This is never exposed through plugin Action input.
 */
export const PluginWebhookInvocationReferenceV1Schema = z.object({
  v: z.literal(1),
  deliveryId: ASCII_TOKEN_128_SCHEMA,
  endpoint: PluginWebhookClaimedEndpointV1Schema,
  target: PluginWebhookClaimTargetV1Schema,
  lease: PluginWebhookLeaseIdentityV1Schema,
}).strict().readonly();

export const PluginWebhookClaimRequestV1Schema = z.object({
  v: z.literal(1),
  policyVersion: z.literal(1),
  target: PluginWebhookClaimTargetV1Schema,
}).strict().readonly();

export const PluginWebhookClaimResultV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('none'),
    retryAfterMs: z.number().int().min(1).max(60_000),
  }).strict(),
  z.object({
    kind: z.literal('delivery'),
    deliveryId: ASCII_TOKEN_128_SCHEMA,
    endpoint: PluginWebhookClaimedEndpointV1Schema,
    attempt: z.number().int().min(1).max(12),
    replay: z.number().int().min(0).max(10),
    receivedAtMs: z.number().int().nonnegative().safe(),
    envelope: StoredPluginWebhookDeliveryContentV1Schema,
    lease: z.object({
      ...PluginWebhookLeaseIdentityV1Shape,
      firstClaimAtMs: z.number().int().nonnegative().safe(),
      expiresAtMs: z.number().int().nonnegative().safe(),
      maxClaimUntilMs: z.number().int().nonnegative().safe(),
    }).strict().readonly(),
  }).strict(),
]).readonly();

export const PluginWebhookRenewRequestV1Schema = z.object({
  v: z.literal(1),
  target: PluginWebhookClaimTargetV1Schema,
  lease: PluginWebhookLeaseIdentityV1Schema,
  transition: z.enum(['renew', 'executionStarted']),
}).strict().readonly();

export const PluginWebhookRenewResultV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('renewed'),
    revision: z.number().int().nonnegative().safe(),
    expiresAtMs: z.number().int().nonnegative().safe(),
  }).strict(),
  z.object({ kind: z.literal('leaseLost') }).strict(),
  z.object({ kind: z.literal('unavailable'), code: DIAGNOSTIC_CODE_SCHEMA }).strict(),
]).readonly();

const PluginWebhookSettleBaseV1Shape = {
  v: z.literal(1),
  target: PluginWebhookClaimTargetV1Schema,
  lease: PluginWebhookLeaseIdentityV1Schema,
};

export const PluginWebhookCompleteRequestV1Schema = z.object({
  ...PluginWebhookSettleBaseV1Shape,
  result: z.object({
    kind: z.literal('settled'),
    disposition: z.enum(['accepted', 'ignored']),
  }).strict().readonly(),
}).strict().readonly();

export const PluginWebhookFailRequestV1Schema = z.object({
  ...PluginWebhookSettleBaseV1Shape,
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('retry'), code: DIAGNOSTIC_CODE_SCHEMA }).strict(),
    z.object({ kind: z.literal('deadLetter'), code: DIAGNOSTIC_CODE_SCHEMA }).strict(),
  ]).readonly(),
  // Host-private daemon-to-server diagnostic carrier. Plugin-authored Action
  // results remain marker-only and cannot author this field.
  automationAdmissionUnresolved: PluginWebhookAutomationAdmissionUnresolvedV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.automationAdmissionUnresolved !== undefined && value.result.kind !== 'retry') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['automationAdmissionUnresolved'],
      message: 'Unresolved Automation diagnostics are valid only for a retry failure',
    });
  }
}).readonly();

export const PluginWebhookSettleResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('settled'), state: z.enum(['queued', 'succeeded', 'dead_letter']) }).strict(),
  z.object({ kind: z.literal('leaseLost') }).strict(),
  z.object({ kind: z.literal('unavailable'), code: DIAGNOSTIC_CODE_SCHEMA }).strict(),
]).readonly();

export type PluginWebhookDeliveryContentV1 = z.infer<typeof PluginWebhookDeliveryContentV1Schema>;
export type StoredPluginWebhookDeliveryContentV1 = z.infer<typeof StoredPluginWebhookDeliveryContentV1Schema>;
export type PluginWebhookActionInputV1 = z.infer<typeof PluginWebhookActionInputV1Schema>;
export type PluginWebhookActionResultV1 = z.infer<typeof PluginWebhookActionResultV1Schema>;
export type PluginWebhookClaimRequestV1 = z.infer<typeof PluginWebhookClaimRequestV1Schema>;
export type PluginWebhookClaimResultV1 = z.infer<typeof PluginWebhookClaimResultV1Schema>;
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
