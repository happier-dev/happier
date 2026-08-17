import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { AgentPermissionIntentV1Schema } from '../../runtime/permissionIntentV1.js';
import { SessionIdSchema, TurnIdSchema } from '../idsV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

const UTF8_ENCODER = new TextEncoder();

function boundedNfcIdentifier(maxBytes: number, label: string) {
  return z.string()
    .refine((value) => value === value.normalize('NFC'), `${label} must be NFC-normalized`)
    .refine((value) => value === value.trim() && value.length > 0, `${label} must be trimmed and nonempty`)
    .refine((value) => UTF8_ENCODER.encode(value).byteLength <= maxBytes, `${label} exceeds its UTF-8 byte limit`);
}

export const SessionPermissionRequestIdV1Schema = boundedNfcIdentifier(256, 'Permission request ids');
export const SessionPermissionSettlementIdV1Schema = boundedNfcIdentifier(256, 'Permission settlement ids');
export const SessionPermissionGrantIdV1Schema = boundedNfcIdentifier(256, 'Permission grant ids');
export const SessionPermissionSourceRefV1Schema = boundedNfcIdentifier(256, 'Permission source references');
export const SessionPermissionSourceRevisionOrEpochV1Schema = boundedNfcIdentifier(128, 'Permission source revisions');
export const SessionPermissionIdempotencyKeyV1Schema = boundedNfcIdentifier(256, 'Permission idempotency keys');
export const SessionPermissionExternalPrincipalNamespaceV1Schema = boundedNfcIdentifier(64, 'External principal namespaces');
export const SessionPermissionExternalPrincipalIdV1Schema = boundedNfcIdentifier(256, 'External principal ids');

export const SessionPermissionAccountIdV1Schema = boundedNfcIdentifier(191, 'Account ids');
const SessionPermissionCursorV1Schema = boundedNfcIdentifier(1_024, 'Permission cursors');

export const SessionPermissionAccountUserDecisionActorV1Schema = z.object({
  kind: z.literal('accountUser'),
  accountId: SessionPermissionAccountIdV1Schema,
  relationship: z.enum(['owner', 'sharedApprover']),
}).strict();
export type SessionPermissionAccountUserDecisionActorV1 = z.infer<
  typeof SessionPermissionAccountUserDecisionActorV1Schema
>;

export const SessionPermissionExternalHumanDecisionActorV1Schema = z.object({
  kind: z.literal('externalHuman'),
  assurance: z.literal('pluginAsserted'),
  namespace: SessionPermissionExternalPrincipalNamespaceV1Schema,
  principalId: SessionPermissionExternalPrincipalIdV1Schema,
  assertedBy: z.object({
    pluginId: asProtocolZod(PluginIdSchema),
    contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict(),
}).strict();
export type SessionPermissionExternalHumanDecisionActorV1 = z.infer<
  typeof SessionPermissionExternalHumanDecisionActorV1Schema
>;

export const SessionPermissionDecisionActorV1Schema = z.discriminatedUnion('kind', [
  SessionPermissionAccountUserDecisionActorV1Schema,
  SessionPermissionExternalHumanDecisionActorV1Schema,
]);
export type SessionPermissionDecisionActorV1 = z.infer<typeof SessionPermissionDecisionActorV1Schema>;

export const SessionPermissionRemoteActorInputV1Schema = z.object({
  namespace: SessionPermissionExternalPrincipalNamespaceV1Schema,
  principalId: SessionPermissionExternalPrincipalIdV1Schema,
}).strict();
export type SessionPermissionRemoteActorInputV1 = z.infer<typeof SessionPermissionRemoteActorInputV1Schema>;

const SessionPermissionRemoteAllowedScopesV1Schema = z.union([
  z.tuple([z.literal('request')]),
  z.tuple([z.literal('request'), z.literal('session')]),
]);

export const SessionPermissionRemotePendingListInputV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  sourceRef: SessionPermissionSourceRefV1Schema,
  sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
}).strict();
export type SessionPermissionRemotePendingListInputV1 = z.infer<typeof SessionPermissionRemotePendingListInputV1Schema>;

export const SessionPermissionRemotePendingListOutputV1Schema = z.object({
  requests: z.array(z.object({
    requestId: SessionPermissionRequestIdV1Schema,
    /**
     * Host-stamped turn custody. Remote mediators correlate a pending
     * permission by (sessionId, turnId, requestId), never by requestId alone.
     */
    turnId: TurnIdSchema,
    createdAtMs: z.number().int().nonnegative(),
    allowedScopes: SessionPermissionRemoteAllowedScopesV1Schema,
  }).strict()).max(32),
  /**
   * `true` means this bounded projection is not exhaustive. Callers must not
   * infer that a missing request is absent: the host can withhold a durable
   * source-matched request until its live permission waiter has reattached.
   */
  truncated: z.boolean(),
}).strict();
export type SessionPermissionRemotePendingListOutputV1 = z.infer<typeof SessionPermissionRemotePendingListOutputV1Schema>;

export const SessionPermissionRemoteRespondInputV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  turnId: TurnIdSchema,
  requestId: SessionPermissionRequestIdV1Schema,
  sourceRef: SessionPermissionSourceRefV1Schema,
  sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
  idempotencyKey: SessionPermissionIdempotencyKeyV1Schema,
  actor: SessionPermissionRemoteActorInputV1Schema,
  decision: z.enum(['allow', 'deny']),
  scope: z.enum(['request', 'session']),
}).strict();
export type SessionPermissionRemoteRespondInputV1 = z.infer<typeof SessionPermissionRemoteRespondInputV1Schema>;

const SessionPermissionRemoteRespondSuccessV1Schema = z.discriminatedUnion('decision', [
  z.object({
    status: z.enum(['applied', 'alreadyApplied']),
    settlementId: SessionPermissionSettlementIdV1Schema,
    requestId: SessionPermissionRequestIdV1Schema,
    decision: z.literal('allow'),
    effect: z.union([
      z.object({ kind: z.literal('allowOnce') }).strict(),
      z.object({
        kind: z.literal('sessionGrant'),
        grantId: SessionPermissionGrantIdV1Schema,
        sourceRef: SessionPermissionSourceRefV1Schema,
        sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
        admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    status: z.enum(['applied', 'alreadyApplied']),
    settlementId: SessionPermissionSettlementIdV1Schema,
    requestId: SessionPermissionRequestIdV1Schema,
    decision: z.literal('deny'),
    effect: z.object({ kind: z.literal('deny') }).strict(),
  }).strict(),
]);

export const SessionPermissionRemoteRespondOutputV1Schema = z.union([
  SessionPermissionRemoteRespondSuccessV1Schema,
  z.object({
    status: z.literal('rejected'),
    code: z.enum([
      'requestNotFound',
      'requestNotPending',
      'decisionConflict',
      'remoteApprovalDisabled',
      'scopeExceedsPolicy',
      'sessionScopeUnsupported',
      'sessionGrantCapacityExceeded',
      'permissionCeilingExceeded',
      'actorUnattributable',
      'mediationStateUnavailable',
      'sessionUnavailable',
      'ownerMachineUnavailable',
      'canceled',
    ]),
  }).strict(),
]);
export type SessionPermissionRemoteRespondOutputV1 = z.infer<typeof SessionPermissionRemoteRespondOutputV1Schema>;

export const SessionPermissionRemoteGrantsListInputV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: SessionPermissionCursorV1Schema.nullable().optional(),
}).strict();
export type SessionPermissionRemoteGrantsListInputV1 = z.infer<typeof SessionPermissionRemoteGrantsListInputV1Schema>;

const SessionPermissionRemoteGrantProjectionV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mediator') }).strict(),
  z.object({
    kind: z.literal('owner'),
    rule: z.object({
      kind: z.literal('exactTool'),
      identifier: boundedNfcIdentifier(1_024, 'Permission tool identifiers'),
    }).strict(),
    revocationActor: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('accountUser'), accountId: SessionPermissionAccountIdV1Schema }).strict(),
      z.object({ kind: z.literal('mediatorPlugin'), pluginId: asProtocolZod(PluginIdSchema) }).strict(),
    ]).optional(),
  }).strict(),
]);

export const SessionPermissionRemoteGrantSummaryV1Schema = z.object({
  turnId: TurnIdSchema,
  requestId: SessionPermissionRequestIdV1Schema,
  settlementId: SessionPermissionSettlementIdV1Schema,
  grantId: SessionPermissionGrantIdV1Schema,
  sourceRef: SessionPermissionSourceRefV1Schema,
  sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  actor: SessionPermissionRemoteActorInputV1Schema,
  createdAtMs: z.number().int().nonnegative(),
  revokedAtMs: z.number().int().nonnegative().optional(),
  projection: SessionPermissionRemoteGrantProjectionV1Schema,
}).strict();
export type SessionPermissionRemoteGrantSummaryV1 = z.infer<typeof SessionPermissionRemoteGrantSummaryV1Schema>;

export const SessionPermissionRemoteGrantsListOutputV1Schema = z.object({
  grants: z.array(SessionPermissionRemoteGrantSummaryV1Schema).max(200),
  nextCursor: SessionPermissionCursorV1Schema.nullable(),
}).strict();
export type SessionPermissionRemoteGrantsListOutputV1 = z.infer<typeof SessionPermissionRemoteGrantsListOutputV1Schema>;

export const SessionPermissionRemoteGrantRevokeInputV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  turnId: TurnIdSchema,
  requestId: SessionPermissionRequestIdV1Schema,
  grantId: SessionPermissionGrantIdV1Schema,
}).strict();
export type SessionPermissionRemoteGrantRevokeInputV1 = z.infer<typeof SessionPermissionRemoteGrantRevokeInputV1Schema>;

export const SessionPermissionRemoteGrantRevokeOutputV1Schema = z.union([
  z.object({ status: z.enum(['revoked', 'alreadyRevoked']), grantId: SessionPermissionGrantIdV1Schema }).strict(),
  z.object({
    status: z.literal('rejected'),
    code: z.enum(['notFound', 'sessionUnavailable', 'ownerMachineUnavailable', 'mediationStateUnavailable', 'canceled']),
  }).strict(),
]);
export type SessionPermissionRemoteGrantRevokeOutputV1 = z.infer<typeof SessionPermissionRemoteGrantRevokeOutputV1Schema>;
