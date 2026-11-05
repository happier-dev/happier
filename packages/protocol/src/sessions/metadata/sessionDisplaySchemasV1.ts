import { z } from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { getAccountScopedBlobKindByte, readAccountScopedCiphertextKindByte } from '../../crypto/accountScopedCipherEnvelope.js';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionWorkspaceLocationV1Schema } from './sessionWorkspaceLocationV1.js';
import { createSessionTerminalControlServiceabilityV1Schema } from './terminalMetadata.js';
import { ExternalSessionsAgentIdSchema } from '../external/sourceCatalog.js';
import { LinkedExternalSessionQualifiedIdentityV1Schema } from '../external/linkedSessionMetadata.js';
import { SessionUsageLimitRecoveryDisplayV1Schema } from '../state/valueSchemas/usageLimitRecovery.js';
export { SessionUsageLimitRecoveryDisplayV1Schema, type SessionUsageLimitRecoveryDisplayV1 } from '../state/valueSchemas/usageLimitRecovery.js';
import { SessionWorkDisplayV1Schema } from '../work/state/sessionWorkStatePrimary.js';
import { SessionAgentActivityEntryV1Schema } from '../work/agentActivity/agentActivityEntryV1.js';
import { SessionAgentActivityHeadlineV1Schema } from '../work/agentActivity/agentActivityHeadlineV1.js';
import { SessionWorkflowActivityHeadlineV1Schema, SessionWorkflowRunHeadlineV1Schema } from '../work/workflow/sessionWorkflowActivityHeadlineV1.js';
import { SessionSharedAgentPresentationV1Schema, SessionOwnerWorkspaceV1Schema, SessionOwnerCursorsV1Schema } from './sessionMetadataPresentationSchemasV1.js';
import { SessionBotV1Schema } from '../identity/sessionBotV1.js';
import { SessionBotFaceV1Schema } from '../identity/sessionBotFaceV1.js';
import { ExternalSessionOperationSharedPresentationV1Schema } from '../external/operationV1.js';
import { SessionGuardStateV1Schema } from '../../machines/guard/sessionGuardStateV1.js';
import { ExternalAgentObservationSnapshotV1Schema } from '../external/externalAgentObservationV1.js';

export const SESSION_OWNER_DISPLAY_ACCOUNT_SCOPED_KIND = 'session_owner_display' as const;
export const SESSION_SHARED_DISPLAY_PURPOSE_V1 = 'session_shared_display' as const;
export const SESSION_OWNER_DISPLAY_PURPOSE_V1 = 'session_owner_display' as const;

/** Closed recipient-safe display facts. Request ledgers and private metadata never enter this leaf. */
export const SessionSharedDisplayV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  summaryText: z.optional(z.string()),
  agentPresentation: z.optional(SessionSharedAgentPresentationV1Schema),
  bot: z.optional(SessionBotV1Schema),
  botFace: z.optional(SessionBotFaceV1Schema),
  externalSessionOperationPresentationV1: z.optional(ExternalSessionOperationSharedPresentationV1Schema),
  sessionGuardStateV1: z.optional(SessionGuardStateV1Schema),
}));
export type SessionSharedDisplayV1 = z.infer<typeof SessionSharedDisplayV1Schema>;

/** Identity is display-only: no link data, runtime descriptor, or follow/control policy. */
export const SessionExternalIdentityDisplayV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  agentId: ExternalSessionsAgentIdSchema,
  machineId: z.string().check(z.minLength(1)),
  remoteSessionId: z.string().check(z.minLength(1)),
  source: z.strictObject({ kind: z.string().check(z.minLength(1)) }),
  linkedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  qualifiedIdentity: z.optional(LinkedExternalSessionQualifiedIdentityV1Schema),
}));

// These incumbent headlines are already compact pointers, not task records. Close their
// envelopes and children so future raw extensions cannot silently enter this display contract.
const AgentActivityDisplayV1Schema = lazyZodSchema(() => z.strictObject({
  ...SessionAgentActivityHeadlineV1Schema.shape,
  activeEntries: z.array(z.strictObject(SessionAgentActivityEntryV1Schema.shape)),
  recentEntries: z.optional(z.array(z.strictObject(SessionAgentActivityEntryV1Schema.shape))),
}));
const WorkflowActivityDisplayV1Schema = lazyZodSchema(() => z.strictObject({
  ...SessionWorkflowActivityHeadlineV1Schema.shape,
  activeRuns: z.array(z.strictObject(SessionWorkflowRunHeadlineV1Schema.shape)),
  recentRuns: z.optional(z.array(z.strictObject(SessionWorkflowRunHeadlineV1Schema.shape))),
}));

/** A presentation leaf only. Opening it never establishes full owner-metadata readiness. */
export const SessionOwnerDisplayV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  name: SessionOwnerWorkspaceV1Schema.shape.name,
  path: SessionOwnerWorkspaceV1Schema.shape.path,
  homeDir: SessionOwnerWorkspaceV1Schema.shape.homeDir,
  host: SessionOwnerWorkspaceV1Schema.shape.host,
  machineId: SessionOwnerWorkspaceV1Schema.shape.machineId,
  flavor: SessionOwnerWorkspaceV1Schema.shape.flavor,
  projectId: SessionOwnerWorkspaceV1Schema.shape.projectId,
  workspaceId: SessionOwnerWorkspaceV1Schema.shape.workspaceId,
  branch: SessionOwnerWorkspaceV1Schema.shape.branch,
  sessionWorkspaceLocationV1: z.optional(z.strictObject(SessionWorkspaceLocationV1Schema.shape)),
  sessionDirectoryV1: z.optional(z.strictObject({ v: z.literal(1), kind: z.literal('managed') })),
  externalSessionV1: z.optional(SessionExternalIdentityDisplayV1Schema),
  externalAgentObservationV1: z.optional(ExternalAgentObservationSnapshotV1Schema),
  readStateV1: SessionOwnerCursorsV1Schema.shape.readStateV1,
  externalSessionAttentionV1: SessionOwnerCursorsV1Schema.shape.externalSessionAttentionV1,
  lifecycleState: z.optional(z.string().check(z.maxLength(2_000))),
  imageInputSupported: z.optional(z.boolean()),
  terminalControlServiceabilityV1: z.optional(z.strictObject({
    ...z.pick(createSessionTerminalControlServiceabilityV1Schema(z), { v: true, state: true, observedAt: true, reason: true }).shape,
  })),
  sessionUsageLimitRecoveryV1: z.optional(SessionUsageLimitRecoveryDisplayV1Schema),
  workDisplay: z.optional(SessionWorkDisplayV1Schema),
  work: z.optional(z.strictObject({ statusReason: z.optional(z.nullable(z.string())) })),
  sessionAgentActivityHeadlineV1: z.optional(AgentActivityDisplayV1Schema),
  sessionWorkflowActivityHeadlineV1: z.optional(WorkflowActivityDisplayV1Schema),
  forkV1: z.optional(z.strictObject({
    v: z.literal(1), parentSessionId: asProtocolZod(SessionIdSchema),
    parentCutoffSeqInclusive: z.number().check(z.int(), z.nonnegative()),
    createdAtMs: z.number().check(z.int(), z.nonnegative()), strategy: z.string(),
  })),
  hiddenSystemSession: z.optional(z.boolean()),
  systemSessionKind: z.optional(z.literal('voice_custody')),
}));
export type SessionOwnerDisplayV1 = z.infer<typeof SessionOwnerDisplayV1Schema>;

export type SessionSemanticDisplayV1 = Readonly<{ shared: SessionSharedDisplayV1; owner?: SessionOwnerDisplayV1 }>;

export const SessionSharedDisplayPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), audience: z.literal('shared'),
  purpose: z.literal(SESSION_SHARED_DISPLAY_PURPOSE_V1), display: SessionSharedDisplayV1Schema,
}));
export const SessionOwnerDisplayPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), audience: z.literal('owner'),
  purpose: z.literal(SESSION_OWNER_DISPLAY_PURPOSE_V1), display: SessionOwnerDisplayV1Schema,
}));
export type SessionSharedDisplayPayloadV1 = z.infer<typeof SessionSharedDisplayPayloadV1Schema>;
export type SessionOwnerDisplayPayloadV1 = z.infer<typeof SessionOwnerDisplayPayloadV1Schema>;

export const SessionSharedDisplayEnvelopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: SessionSharedDisplayPayloadV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1), z.refine(
    c => readAccountScopedCiphertextKindByte(c, 'canonical') === null,
    { message: 'Expected Session-mode ciphertext, not an Account content domain' },
  )) }),
]));
export const SessionOwnerDisplayEnvelopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: SessionOwnerDisplayPayloadV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1), z.refine(
    c => readAccountScopedCiphertextKindByte(c, 'canonical') === getAccountScopedBlobKindByte(SESSION_OWNER_DISPLAY_ACCOUNT_SCOPED_KIND),
    { message: 'Expected canonical Session owner-display ciphertext' },
  )) }),
]));
export type SessionSharedDisplayEnvelopeV1 = z.infer<typeof SessionSharedDisplayEnvelopeV1Schema>;
export type SessionOwnerDisplayEnvelopeV1 = z.infer<typeof SessionOwnerDisplayEnvelopeV1Schema>;

export const SessionDisplayProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sourceMetadataVersion: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  metadataLayoutVersion: z.literal(1),
  shared: SessionSharedDisplayEnvelopeV1Schema,
  owner: z.optional(SessionOwnerDisplayEnvelopeV1Schema),
}));
export type SessionDisplayProjectionV1 = z.infer<typeof SessionDisplayProjectionV1Schema>;

export type SessionDisplayFailureReasonV1 = 'invalid_envelope' | 'session_mode_mismatch' | 'account_mode_mismatch'
  | 'material_unavailable' | 'crypto_unavailable' | 'invalid_ciphertext' | 'stale_source';
export type SessionDisplayFailureV1 = Readonly<{ ok: false; reason: SessionDisplayFailureReasonV1 }>;

export function validateSessionOwnerDisplayEnvelopeForAccountModeV1(params: Readonly<{
  envelope: unknown; accountMode: 'plain' | 'e2ee';
}>): Readonly<{ ok: true; envelope: SessionOwnerDisplayEnvelopeV1 }> | SessionDisplayFailureV1 {
  const parsed = SessionOwnerDisplayEnvelopeV1Schema.safeParse(params.envelope);
  if (!parsed.success) return { ok: false, reason: 'invalid_envelope' };
  if (parsed.data.t !== (params.accountMode === 'plain' ? 'plain' : 'encrypted')) {
    return { ok: false, reason: 'account_mode_mismatch' };
  }
  return { ok: true, envelope: parsed.data };
}

export function validateSessionDisplayProjectionV1(params: Readonly<{
  projection: unknown; sessionMode: 'plain' | 'e2ee'; accountMode?: 'plain' | 'e2ee';
  metadataVersion: number; metadataLayoutVersion: number;
}>): Readonly<{ ok: true; projection: SessionDisplayProjectionV1 }> | SessionDisplayFailureV1 {
  const parsed = SessionDisplayProjectionV1Schema.safeParse(params.projection);
  if (!parsed.success) return { ok: false, reason: 'invalid_envelope' };
  const projection = parsed.data;
  if (projection.sourceMetadataVersion !== params.metadataVersion || projection.metadataLayoutVersion !== params.metadataLayoutVersion) {
    return { ok: false, reason: 'stale_source' };
  }
  if (projection.shared.t !== (params.sessionMode === 'plain' ? 'plain' : 'encrypted')) return { ok: false, reason: 'session_mode_mismatch' };
  if (projection.owner && params.accountMode) {
    const owner = validateSessionOwnerDisplayEnvelopeForAccountModeV1({ envelope: projection.owner, accountMode: params.accountMode });
    if (!owner.ok) return owner;
  }
  return { ok: true, projection };
}
