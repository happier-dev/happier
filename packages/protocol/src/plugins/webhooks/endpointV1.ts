import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { encodeBase64 } from '../../crypto/base64.js';
import { isLoopbackHostname } from '../../server/urls/loopbackHostname.js';
import { PluginMachineMaterializationRefV1Schema } from '../availability/materializationRefV1.js';
import type { PluginJsonSchemaV2 } from '../contributions/publicTypes.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const PLUGIN_WEBHOOK_ENDPOINT_ID_V1_PREFIX = 'wh_ep_' as const;

const PLUGIN_WEBHOOK_ENDPOINT_ID_V1_JSON_SCHEMA_PATTERN = '^wh_ep_[A-Za-z0-9_-]{21}[AQgw]$(?![\\s\\S])';
const PLUGIN_WEBHOOK_ENDPOINT_ID_V1_PATTERN = new RegExp(
  PLUGIN_WEBHOOK_ENDPOINT_ID_V1_JSON_SCHEMA_PATTERN,
  'u',
);

export const PluginWebhookEndpointIdV1Schema = lazyZodSchema(() => z.string().regex(PLUGIN_WEBHOOK_ENDPOINT_ID_V1_PATTERN));

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

const PluginWebhookSourceInstanceIdV1Schema = lazyZodSchema(() => z.string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/u));
const PluginWebhookIdempotencyKeyV1Schema = lazyZodSchema(() => z.string()
  .regex(/^[A-Za-z0-9._:-]{16,128}$/u));
const PluginWebhookRevisionV1Schema = lazyZodSchema(() => z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
/**
 * The controller-owned ordering of one endpoint's target intent.
 *
 * It is supplied by the feature owner that already holds a monotonic authority
 * for the source instance this endpoint is bound to — for Channels, the
 * connection replacement authority epoch. The webhook owner never mints it; it
 * only records the highest intent an authorized controller has converged, so a
 * late retry of a superseded intent cannot move delivery backwards.
 */
const PluginWebhookTargetIntentEpochV1Schema = lazyZodSchema(() => z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const PluginWebhookTimestampMsV1Schema = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const PluginWebhookPublicUrlV1Schema = lazyZodSchema(() => z.string().url().max(2_048).refine((value) => {
  const url = new URL(value);
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return isLoopbackHostname(url.hostname);
}, {
  message: 'Webhook public URLs require HTTPS except for an explicit loopback development URL',
}));
const PluginWebhookCredentialVersionIdV1Schema = lazyZodSchema(() => z.string().trim().min(1).max(128));

export const PluginWebhookEndpointReadinessV1Schema = lazyZodSchema(() => z.enum([
  'ready',
  'providerConfirmationRequired',
  'credentialDisclosureLost',
  'targetUnavailable',
  'routeUnavailable',
]));

export const PluginWebhookEndpointSetupV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('accountEndpointV1'),
    credential: z.literal('serverGenerated'),
  }).strict(),
  z.object({
    kind: z.literal('githubSharedInstallationV1'),
    installationId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
    installationAuthorizationRef: z.string().trim().min(1).max(512),
  }).strict(),
]));

export const PluginWebhookEndpointEnsureInputV1Schema = lazyZodSchema(() => z.object({
  webhookContribution: asProtocolZod(PluginContributionIdentityV1Schema),
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  sourceInstanceId: PluginWebhookSourceInstanceIdV1Schema,
  setup: PluginWebhookEndpointSetupV1Schema,
  idempotencyKey: PluginWebhookIdempotencyKeyV1Schema,
}).strict());

export const PluginWebhookEndpointEnsureResultV1Schema = lazyZodSchema(() => z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: PluginWebhookRevisionV1Schema,
  publicUrl: PluginWebhookPublicUrlV1Schema,
  readiness: PluginWebhookEndpointReadinessV1Schema,
  oneTimeGeneratedSecret: z.string().min(1).max(512).optional(),
}).strict());

export const PluginWebhookEndpointReadInputV1Schema = lazyZodSchema(() => z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
}).strict());

export const PluginWebhookEndpointReadResultV1Schema = lazyZodSchema(() => z.object({
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
}).strict());

export const PluginWebhookEndpointRevokeInputV1Schema = lazyZodSchema(() => z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  expectedRevision: PluginWebhookRevisionV1Schema,
  idempotencyKey: PluginWebhookIdempotencyKeyV1Schema,
}).strict());

export const PluginWebhookEndpointRevokeResultV1Schema = lazyZodSchema(() => z.object({
  kind: z.enum(['revoked', 'alreadyRevoked']),
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: PluginWebhookRevisionV1Schema,
}).strict());

export const PluginWebhookEndpointRetargetInputV1Schema = lazyZodSchema(() => z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  expectedRevision: PluginWebhookRevisionV1Schema,
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  idempotencyKey: PluginWebhookIdempotencyKeyV1Schema,
}).strict());

export const PluginWebhookEndpointRetargetResultV1Schema = lazyZodSchema(() => z.union([
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
]));

export const PluginWebhookEndpointCheckCorrespondenceInputV1Schema = lazyZodSchema(() => z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  webhookContribution: asProtocolZod(PluginContributionIdentityV1Schema),
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  sourceInstanceId: PluginWebhookSourceInstanceIdV1Schema,
  setup: PluginWebhookEndpointSetupV1Schema,
}).strict());

export const PluginWebhookEndpointCheckCorrespondenceResultV1Schema = lazyZodSchema(() => z.union([
  z.object({
    kind: z.literal('ready'),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    revision: PluginWebhookRevisionV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('unavailable'),
    code: z.string().regex(/^[a-z0-9._-]{1,64}$/u),
  }).strict(),
]));

/**
 * The one plugin-surface endpoint-target mutation.
 *
 * `checkCorrespondence` answers "is this endpoint still mine?" and cannot move
 * anything; present-user `retarget` moves an endpoint to any compatible target
 * under revision CAS and remains the authoritative administration operation.
 * Neither can serve a feature owner that must converge an endpoint it already
 * owns onto the target its own committed intent names, because a daemon-side
 * feature caller is never a present user and a read → retarget chain conflicts
 * whenever an unrelated operation moved the endpoint revision.
 *
 * This operation closes exactly that gap: the caller names the endpoint
 * correspondence facts it can already prove, the target it desires, and the
 * ordering epoch of the intent that desires it. No expected revision is
 * accepted, because the endpoint revision is not this caller's authority.
 */
export const PluginWebhookEndpointConvergeTargetInputV1Schema = lazyZodSchema(() => z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  webhookContribution: asProtocolZod(PluginContributionIdentityV1Schema),
  sourceInstanceId: PluginWebhookSourceInstanceIdV1Schema,
  setup: PluginWebhookEndpointSetupV1Schema,
  desiredTargetMaterialization: PluginMachineMaterializationRefV1Schema,
  targetIntentEpoch: PluginWebhookTargetIntentEpochV1Schema,
}).strict());

export const PluginWebhookEndpointConvergeTargetResultV1Schema = lazyZodSchema(() => z.union([
  z.object({
    kind: z.literal('converged'),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    revision: PluginWebhookRevisionV1Schema,
    targetMaterialization: PluginMachineMaterializationRefV1Schema,
    targetIntentEpoch: PluginWebhookTargetIntentEpochV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('superseded'),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    currentTargetIntentEpoch: PluginWebhookTargetIntentEpochV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('unavailable'),
    code: z.string().regex(/^[a-z0-9._-]{1,64}$/u),
  }).strict(),
]));

/**
 * `targetMaterialization` is the endpoint's current target at
 * `endpointRevision`; every movable row frozen anywhere else moves to it. The
 * operation names no predecessor: an endpoint that moved A -> B -> C still owns
 * rows frozen to A, and naming one predecessor would strand them.
 */
export const PluginWebhookDeliveryMovePendingInputV1Schema = lazyZodSchema(() => z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  endpointRevision: PluginWebhookRevisionV1Schema,
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  cursor: z.string().min(1).max(512).optional(),
  pageSize: z.number().int().min(1).max(500).default(500),
}).strict());

export const PluginWebhookDeliveryMovePendingResultV1Schema = lazyZodSchema(() => z.union([
  z.object({
    moved: z.number().int().nonnegative().max(500),
    skippedClaimed: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).max(512).nullable(),
    done: z.boolean(),
  }).strict(),
  z.object({
    kind: z.enum(['revisionConflict', 'targetMismatch', 'incompatible', 'unavailable']),
  }).strict(),
]));

export const PluginWebhookEndpointCredentialConfigureInputV1Schema = lazyZodSchema(() => z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  expectedRevision: PluginWebhookRevisionV1Schema,
}).strict());

export const PluginWebhookEndpointCredentialConfigureResultV1Schema = lazyZodSchema(() => z.object({
  kind: z.enum(['configured', 'alreadyConfigured']),
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: PluginWebhookRevisionV1Schema,
  credentialVersionId: PluginWebhookCredentialVersionIdV1Schema,
  oneTimeGeneratedSecret: z.string().min(1).max(512).optional(),
}).strict());

export const PluginWebhookEndpointCredentialRotateInputV1Schema = lazyZodSchema(() => z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  expectedRevision: PluginWebhookRevisionV1Schema,
}).strict());

export const PluginWebhookEndpointCredentialRotateResultV1Schema = lazyZodSchema(() => z.object({
  kind: z.enum(['rotated', 'alreadyRotated']),
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: PluginWebhookRevisionV1Schema,
  credentialVersionId: PluginWebhookCredentialVersionIdV1Schema,
  previousCredentialVersionId: PluginWebhookCredentialVersionIdV1Schema,
  previousAcceptUntilMs: PluginWebhookTimestampMsV1Schema,
  oneTimeGeneratedSecret: z.string().min(1).max(512).optional(),
}).strict());

export const PluginWebhookEndpointCredentialFinishRotationInputV1Schema = lazyZodSchema(() => z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  expectedRevision: PluginWebhookRevisionV1Schema,
  expectedPreviousCredentialVersionId: PluginWebhookCredentialVersionIdV1Schema,
}).strict());

export const PluginWebhookEndpointCredentialFinishRotationResultV1Schema = lazyZodSchema(() => z.union([
  z.object({
    kind: z.enum(['retired', 'alreadyRetired']),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    revision: PluginWebhookRevisionV1Schema,
  }).strict(),
  z.object({
    kind: z.enum(['credentialChanged', 'revisionConflict', 'unavailable']),
    currentRevision: PluginWebhookRevisionV1Schema.optional(),
  }).strict(),
]));

export const PLUGIN_WEBHOOK_ACTION_IDS_V1 = Object.freeze([
  'plugin.webhook.endpoint.ensure',
  'plugin.webhook.endpoint.read',
  'plugin.webhook.endpoint.revoke',
  'plugin.webhook.endpoint.retarget',
  'plugin.webhook.endpoint.checkCorrespondence',
  'plugin.webhook.endpoint.convergeTarget',
  'plugin.webhook.delivery.movePending',
  'plugin.webhook.endpoint.credential.configure',
  'plugin.webhook.endpoint.credential.rotate',
  'plugin.webhook.endpoint.credential.finishRotation',
] as const);
export const PluginWebhookActionIdV1Schema = lazyZodSchema(() => z.enum(PLUGIN_WEBHOOK_ACTION_IDS_V1));
export type PluginWebhookActionIdV1 = z.infer<typeof PluginWebhookActionIdV1Schema>;

/**
 * The closed set of endpoint operations a host-stamped plugin caller may run.
 * Every other endpoint operation stays present-user, and this one list is what
 * the Action registry, the CLI caller-surface guard, and the server plugin
 * route family all derive from.
 */
export const PLUGIN_WEBHOOK_PLUGIN_SURFACE_ACTION_IDS_V1 = Object.freeze([
  'plugin.webhook.endpoint.checkCorrespondence',
  'plugin.webhook.endpoint.convergeTarget',
] as const);
export type PluginWebhookPluginSurfaceActionIdV1 =
  (typeof PLUGIN_WEBHOOK_PLUGIN_SURFACE_ACTION_IDS_V1)[number];
const PLUGIN_WEBHOOK_PLUGIN_SURFACE_ACTION_ID_SET_V1: ReadonlySet<string> = new Set(
  PLUGIN_WEBHOOK_PLUGIN_SURFACE_ACTION_IDS_V1,
);
export function isPluginWebhookPluginSurfaceActionIdV1(
  actionId: PluginWebhookActionIdV1,
): actionId is PluginWebhookPluginSurfaceActionIdV1 {
  return PLUGIN_WEBHOOK_PLUGIN_SURFACE_ACTION_ID_SET_V1.has(actionId);
}

export type PluginWebhookPresentUserActionIdV1 = Exclude<
  PluginWebhookActionIdV1,
  PluginWebhookPluginSurfaceActionIdV1
>;

export const PluginWebhookPluginSurfaceActionHttpPathsV1 = Object.freeze({
  'plugin.webhook.endpoint.checkCorrespondence': '/v1/plugins/webhooks/endpoints/check-correspondence',
  'plugin.webhook.endpoint.convergeTarget': '/v1/plugins/webhooks/endpoints/converge-target',
} as const satisfies Readonly<Record<PluginWebhookPluginSurfaceActionIdV1, string>>);

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
  'plugin.webhook.endpoint.convergeTarget': PluginWebhookEndpointConvergeTargetInputV1Schema,
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
  'plugin.webhook.endpoint.convergeTarget': PluginWebhookEndpointConvergeTargetResultV1Schema,
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
export type PluginWebhookEndpointConvergeTargetInputV1 = z.infer<typeof PluginWebhookEndpointConvergeTargetInputV1Schema>;
export type PluginWebhookEndpointConvergeTargetResultV1 = z.infer<typeof PluginWebhookEndpointConvergeTargetResultV1Schema>;
export type PluginWebhookDeliveryMovePendingInputV1 = z.infer<typeof PluginWebhookDeliveryMovePendingInputV1Schema>;
export type PluginWebhookDeliveryMovePendingResultV1 = z.infer<typeof PluginWebhookDeliveryMovePendingResultV1Schema>;
export type PluginWebhookEndpointCredentialConfigureInputV1 = z.infer<typeof PluginWebhookEndpointCredentialConfigureInputV1Schema>;
export type PluginWebhookEndpointCredentialConfigureResultV1 = z.infer<typeof PluginWebhookEndpointCredentialConfigureResultV1Schema>;
export type PluginWebhookEndpointCredentialRotateInputV1 = z.infer<typeof PluginWebhookEndpointCredentialRotateInputV1Schema>;
export type PluginWebhookEndpointCredentialRotateResultV1 = z.infer<typeof PluginWebhookEndpointCredentialRotateResultV1Schema>;
export type PluginWebhookEndpointCredentialFinishRotationInputV1 = z.infer<typeof PluginWebhookEndpointCredentialFinishRotationInputV1Schema>;
export type PluginWebhookEndpointCredentialFinishRotationResultV1 = z.infer<typeof PluginWebhookEndpointCredentialFinishRotationResultV1Schema>;
