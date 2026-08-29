import { z } from 'zod';

import { encodeBase64 } from '../../crypto/base64.js';
import { PluginMachineMaterializationRefV1Schema } from '../availability/materializationRefV1.js';
import type { PluginJsonSchemaV2 } from '../contributions/publicTypes.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const PLUGIN_WEBHOOK_ENDPOINT_ID_V1_PREFIX = 'wh_ep_' as const;

const PLUGIN_WEBHOOK_ENDPOINT_ID_V1_JSON_SCHEMA_PATTERN = '^wh_ep_[A-Za-z0-9_-]{21}[AQgw]$';
const PLUGIN_WEBHOOK_ENDPOINT_ID_V1_PATTERN = new RegExp(
  PLUGIN_WEBHOOK_ENDPOINT_ID_V1_JSON_SCHEMA_PATTERN,
  'u',
);

export const PluginWebhookEndpointIdV1Schema = z.string().regex(PLUGIN_WEBHOOK_ENDPOINT_ID_V1_PATTERN);

export type PluginWebhookEndpointIdV1 = z.infer<typeof PluginWebhookEndpointIdV1Schema>;

/**
 * Exact public JSON-schema projection for the canonical 128-bit endpoint
 * identity. The final base64url character has only two payload bits, so the
 * pattern admits only its four canonical encodings.
 */
export const PluginWebhookEndpointIdV1JsonSchema = {
  type: 'string',
  minLength: 28,
  maxLength: 28,
  pattern: PLUGIN_WEBHOOK_ENDPOINT_ID_V1_JSON_SCHEMA_PATTERN,
} satisfies PluginJsonSchemaV2;

export function formatPluginWebhookEndpointIdV1(randomBytes: Uint8Array): PluginWebhookEndpointIdV1 {
  if (randomBytes.byteLength !== 16) {
    throw new TypeError('Webhook endpoint identity requires exactly 16 random bytes');
  }
  return PluginWebhookEndpointIdV1Schema.parse(
    `${PLUGIN_WEBHOOK_ENDPOINT_ID_V1_PREFIX}${encodeBase64(randomBytes, 'base64url')}`,
  );
}

const PluginWebhookSourceInstanceIdV1Schema = z.string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const PluginWebhookIdempotencyKeyV1Schema = z.string()
  .regex(/^[A-Za-z0-9._:-]{16,128}$/u);
const PluginWebhookRevisionV1Schema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const PluginWebhookTimestampMsV1Schema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const PluginWebhookPublicUrlV1Schema = z.string().url().max(2_048).refine((value) => {
  const url = new URL(value);
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const hostname = url.hostname.toLowerCase();
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '[::1]';
}, {
  message: 'Webhook public URLs require HTTPS except for an explicit loopback development URL',
});
const PluginWebhookCredentialVersionIdV1Schema = z.string().trim().min(1).max(128);

export const PluginWebhookEndpointReadinessV1Schema = z.enum([
  'ready',
  'providerConfirmationRequired',
  'credentialDisclosureLost',
  'targetUnavailable',
  'routeUnavailable',
]);

export const PluginWebhookEndpointSetupV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('accountEndpointV1'),
    credential: z.literal('serverGenerated'),
  }).strict(),
  z.object({
    kind: z.literal('githubSharedInstallationV1'),
    installationId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
    installationAuthorizationRef: z.string().trim().min(1).max(512),
  }).strict(),
]);

export const PluginWebhookEndpointEnsureInputV1Schema = z.object({
  webhookContribution: asProtocolZod(PluginContributionIdentityV1Schema),
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  sourceInstanceId: PluginWebhookSourceInstanceIdV1Schema,
  setup: PluginWebhookEndpointSetupV1Schema,
  idempotencyKey: PluginWebhookIdempotencyKeyV1Schema,
}).strict();

export const PluginWebhookEndpointEnsureResultV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: PluginWebhookRevisionV1Schema,
  publicUrl: PluginWebhookPublicUrlV1Schema,
  readiness: PluginWebhookEndpointReadinessV1Schema,
  oneTimeGeneratedSecret: z.string().min(1).max(512).optional(),
}).strict();

export const PluginWebhookEndpointReadInputV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
}).strict();

export const PluginWebhookEndpointReadResultV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: PluginWebhookRevisionV1Schema,
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  sourceInstanceId: PluginWebhookSourceInstanceIdV1Schema,
  routing: z.enum(['accountEndpoint', 'providerInstallation']),
  readiness: PluginWebhookEndpointReadinessV1Schema,
  publicUrl: PluginWebhookPublicUrlV1Schema,
  createdAt: PluginWebhookTimestampMsV1Schema,
  revokedAt: PluginWebhookTimestampMsV1Schema.optional(),
}).strict();

export const PluginWebhookEndpointRevokeInputV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  expectedRevision: PluginWebhookRevisionV1Schema,
  idempotencyKey: PluginWebhookIdempotencyKeyV1Schema,
}).strict();

export const PluginWebhookEndpointRevokeResultV1Schema = z.object({
  kind: z.enum(['revoked', 'alreadyRevoked']),
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: PluginWebhookRevisionV1Schema,
}).strict();

export const PluginWebhookEndpointRetargetInputV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  expectedRevision: PluginWebhookRevisionV1Schema,
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  idempotencyKey: PluginWebhookIdempotencyKeyV1Schema,
}).strict();

export const PluginWebhookEndpointRetargetResultV1Schema = z.union([
  z.object({
    kind: z.enum(['retargeted', 'alreadyRetargeted']),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    revision: PluginWebhookRevisionV1Schema,
    previousTargetMaterialization: PluginMachineMaterializationRefV1Schema,
    targetMaterialization: PluginMachineMaterializationRefV1Schema,
  }).strict(),
  z.object({
    kind: z.enum(['revisionConflict', 'targetUnavailable', 'incompatible']),
    currentRevision: PluginWebhookRevisionV1Schema.optional(),
  }).strict(),
]);

export const PluginWebhookEndpointCheckCorrespondenceInputV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  webhookContribution: asProtocolZod(PluginContributionIdentityV1Schema),
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  sourceInstanceId: PluginWebhookSourceInstanceIdV1Schema,
  setup: PluginWebhookEndpointSetupV1Schema,
}).strict();

export const PluginWebhookEndpointCheckCorrespondenceResultV1Schema = z.union([
  z.object({
    kind: z.literal('ready'),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    revision: PluginWebhookRevisionV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('unavailable'),
    code: z.string().regex(/^[a-z0-9._-]{1,64}$/u),
  }).strict(),
]);

export const PluginWebhookDeliveryMovePendingInputV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  endpointRevision: PluginWebhookRevisionV1Schema,
  previousTargetMaterialization: PluginMachineMaterializationRefV1Schema,
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  cursor: z.string().min(1).max(512).optional(),
  pageSize: z.number().int().min(1).max(500).default(500),
}).strict();

export const PluginWebhookDeliveryMovePendingResultV1Schema = z.union([
  z.object({
    moved: z.number().int().nonnegative().max(500),
    skippedClaimed: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).max(512).nullable(),
    done: z.boolean(),
  }).strict(),
  z.object({
    kind: z.enum(['revisionConflict', 'targetMismatch', 'incompatible', 'unavailable']),
  }).strict(),
]);

export const PluginWebhookEndpointCredentialConfigureInputV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  expectedRevision: PluginWebhookRevisionV1Schema,
}).strict();

export const PluginWebhookEndpointCredentialConfigureResultV1Schema = z.object({
  kind: z.enum(['configured', 'alreadyConfigured']),
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: PluginWebhookRevisionV1Schema,
  credentialVersionId: PluginWebhookCredentialVersionIdV1Schema,
  oneTimeGeneratedSecret: z.string().min(1).max(512).optional(),
}).strict();

export const PluginWebhookEndpointCredentialRotateInputV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  expectedRevision: PluginWebhookRevisionV1Schema,
}).strict();

export const PluginWebhookEndpointCredentialRotateResultV1Schema = z.object({
  kind: z.enum(['rotated', 'alreadyRotated']),
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: PluginWebhookRevisionV1Schema,
  credentialVersionId: PluginWebhookCredentialVersionIdV1Schema,
  previousCredentialVersionId: PluginWebhookCredentialVersionIdV1Schema,
  previousAcceptUntilMs: PluginWebhookTimestampMsV1Schema,
  oneTimeGeneratedSecret: z.string().min(1).max(512).optional(),
}).strict();

export const PluginWebhookEndpointCredentialFinishRotationInputV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  expectedRevision: PluginWebhookRevisionV1Schema,
  expectedPreviousCredentialVersionId: PluginWebhookCredentialVersionIdV1Schema,
}).strict();

export const PluginWebhookEndpointCredentialFinishRotationResultV1Schema = z.union([
  z.object({
    kind: z.enum(['retired', 'alreadyRetired']),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    revision: PluginWebhookRevisionV1Schema,
  }).strict(),
  z.object({
    kind: z.enum(['credentialChanged', 'revisionConflict', 'unavailable']),
    currentRevision: PluginWebhookRevisionV1Schema.optional(),
  }).strict(),
]);

export const PLUGIN_WEBHOOK_ACTION_IDS_V1 = Object.freeze([
  'plugin.webhook.endpoint.ensure',
  'plugin.webhook.endpoint.read',
  'plugin.webhook.endpoint.revoke',
  'plugin.webhook.endpoint.retarget',
  'plugin.webhook.endpoint.checkCorrespondence',
  'plugin.webhook.delivery.movePending',
  'plugin.webhook.endpoint.credential.configure',
  'plugin.webhook.endpoint.credential.rotate',
  'plugin.webhook.endpoint.credential.finishRotation',
] as const);
export const PluginWebhookActionIdV1Schema = z.enum(PLUGIN_WEBHOOK_ACTION_IDS_V1);
export type PluginWebhookActionIdV1 = z.infer<typeof PluginWebhookActionIdV1Schema>;
export type PluginWebhookPresentUserActionIdV1 = Exclude<
  PluginWebhookActionIdV1,
  'plugin.webhook.endpoint.checkCorrespondence'
>;

export const PluginWebhookActionHttpPathsV1 = Object.freeze({
  'plugin.webhook.endpoint.ensure': '/v1/plugins/webhooks/endpoints/ensure',
  'plugin.webhook.endpoint.read': '/v1/plugins/webhooks/endpoints/read',
  'plugin.webhook.endpoint.revoke': '/v1/plugins/webhooks/endpoints/revoke',
  'plugin.webhook.endpoint.retarget': '/v1/plugins/webhooks/endpoints/retarget',
  'plugin.webhook.delivery.movePending': '/v1/plugins/webhooks/deliveries/move-pending',
  'plugin.webhook.endpoint.credential.configure': '/v1/plugins/webhooks/endpoints/credentials/configure',
  'plugin.webhook.endpoint.credential.rotate': '/v1/plugins/webhooks/endpoints/credentials/rotate',
  'plugin.webhook.endpoint.credential.finishRotation': '/v1/plugins/webhooks/endpoints/credentials/finish-rotation',
} as const satisfies Readonly<Record<PluginWebhookPresentUserActionIdV1, string>>);

export const PluginWebhookActionInputSchemasV1 = Object.freeze({
  'plugin.webhook.endpoint.ensure': PluginWebhookEndpointEnsureInputV1Schema,
  'plugin.webhook.endpoint.read': PluginWebhookEndpointReadInputV1Schema,
  'plugin.webhook.endpoint.revoke': PluginWebhookEndpointRevokeInputV1Schema,
  'plugin.webhook.endpoint.retarget': PluginWebhookEndpointRetargetInputV1Schema,
  'plugin.webhook.endpoint.checkCorrespondence': PluginWebhookEndpointCheckCorrespondenceInputV1Schema,
  'plugin.webhook.delivery.movePending': PluginWebhookDeliveryMovePendingInputV1Schema,
  'plugin.webhook.endpoint.credential.configure': PluginWebhookEndpointCredentialConfigureInputV1Schema,
  'plugin.webhook.endpoint.credential.rotate': PluginWebhookEndpointCredentialRotateInputV1Schema,
  'plugin.webhook.endpoint.credential.finishRotation': PluginWebhookEndpointCredentialFinishRotationInputV1Schema,
} as const satisfies Readonly<Record<PluginWebhookActionIdV1, z.ZodTypeAny>>);

export const PluginWebhookActionOutputSchemasV1 = Object.freeze({
  'plugin.webhook.endpoint.ensure': PluginWebhookEndpointEnsureResultV1Schema,
  'plugin.webhook.endpoint.read': PluginWebhookEndpointReadResultV1Schema,
  'plugin.webhook.endpoint.revoke': PluginWebhookEndpointRevokeResultV1Schema,
  'plugin.webhook.endpoint.retarget': PluginWebhookEndpointRetargetResultV1Schema,
  'plugin.webhook.endpoint.checkCorrespondence': PluginWebhookEndpointCheckCorrespondenceResultV1Schema,
  'plugin.webhook.delivery.movePending': PluginWebhookDeliveryMovePendingResultV1Schema,
  'plugin.webhook.endpoint.credential.configure': PluginWebhookEndpointCredentialConfigureResultV1Schema,
  'plugin.webhook.endpoint.credential.rotate': PluginWebhookEndpointCredentialRotateResultV1Schema,
  'plugin.webhook.endpoint.credential.finishRotation': PluginWebhookEndpointCredentialFinishRotationResultV1Schema,
} as const satisfies Readonly<Record<PluginWebhookActionIdV1, z.ZodTypeAny>>);

export type PluginWebhookEndpointReadinessV1 = z.infer<typeof PluginWebhookEndpointReadinessV1Schema>;
export type PluginWebhookEndpointSetupV1 = z.infer<typeof PluginWebhookEndpointSetupV1Schema>;
export type PluginWebhookEndpointEnsureInputV1 = z.infer<typeof PluginWebhookEndpointEnsureInputV1Schema>;
export type PluginWebhookEndpointEnsureResultV1 = z.infer<typeof PluginWebhookEndpointEnsureResultV1Schema>;
export type PluginWebhookEndpointReadInputV1 = z.infer<typeof PluginWebhookEndpointReadInputV1Schema>;
export type PluginWebhookEndpointReadResultV1 = z.infer<typeof PluginWebhookEndpointReadResultV1Schema>;
export type PluginWebhookEndpointRevokeInputV1 = z.infer<typeof PluginWebhookEndpointRevokeInputV1Schema>;
export type PluginWebhookEndpointRevokeResultV1 = z.infer<typeof PluginWebhookEndpointRevokeResultV1Schema>;
export type PluginWebhookEndpointRetargetInputV1 = z.infer<typeof PluginWebhookEndpointRetargetInputV1Schema>;
export type PluginWebhookEndpointRetargetResultV1 = z.infer<typeof PluginWebhookEndpointRetargetResultV1Schema>;
export type PluginWebhookEndpointCheckCorrespondenceInputV1 = z.infer<typeof PluginWebhookEndpointCheckCorrespondenceInputV1Schema>;
export type PluginWebhookEndpointCheckCorrespondenceResultV1 = z.infer<typeof PluginWebhookEndpointCheckCorrespondenceResultV1Schema>;
export type PluginWebhookDeliveryMovePendingInputV1 = z.infer<typeof PluginWebhookDeliveryMovePendingInputV1Schema>;
export type PluginWebhookDeliveryMovePendingResultV1 = z.infer<typeof PluginWebhookDeliveryMovePendingResultV1Schema>;
export type PluginWebhookEndpointCredentialConfigureInputV1 = z.infer<typeof PluginWebhookEndpointCredentialConfigureInputV1Schema>;
export type PluginWebhookEndpointCredentialConfigureResultV1 = z.infer<typeof PluginWebhookEndpointCredentialConfigureResultV1Schema>;
export type PluginWebhookEndpointCredentialRotateInputV1 = z.infer<typeof PluginWebhookEndpointCredentialRotateInputV1Schema>;
export type PluginWebhookEndpointCredentialRotateResultV1 = z.infer<typeof PluginWebhookEndpointCredentialRotateResultV1Schema>;
export type PluginWebhookEndpointCredentialFinishRotationInputV1 = z.infer<typeof PluginWebhookEndpointCredentialFinishRotationInputV1Schema>;
export type PluginWebhookEndpointCredentialFinishRotationResultV1 = z.infer<typeof PluginWebhookEndpointCredentialFinishRotationResultV1Schema>;
