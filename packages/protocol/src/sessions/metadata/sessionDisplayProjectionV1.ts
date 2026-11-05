import { SessionSharedMetadataV1Schema, type SessionSharedMetadataV1, type SessionOwnerMetadataV1 } from './sessionMetadataSchemasV1.js';
import { resolveLinkedExternalSessionMetadataV1 } from '../external/linkedSessionMetadata.js';
import { projectSessionWorkDisplayV1 } from '../work/state/sessionWorkStatePrimary.js';
import { projectSessionUsageLimitRecoveryDisplayV1 } from '../state/valueSchemas/usageLimitRecovery.js';
import { isVoiceConversationCustodySessionMetadata } from '../../voice/sessionBinding.js';
import { SessionAgentActivityHeadlineV1Schema } from '../work/agentActivity/agentActivityHeadlineV1.js';
import { SessionWorkflowActivityHeadlineV1Schema } from '../work/workflow/sessionWorkflowActivityHeadlineV1.js';
import { SessionSharedDisplayV1Schema, SessionOwnerDisplayV1Schema, type SessionOwnerDisplayV1, type SessionSemanticDisplayV1 } from './sessionDisplaySchemasV1.js';

export * from './sessionDisplaySchemasV1.js';

/** The single semantic selection owner used by tuple producers and full UI row projection. */
export function projectSessionDisplayV1(input: Readonly<{
  sharedMetadata: SessionSharedMetadataV1;
  ownerMetadata?: SessionOwnerMetadataV1;
}>): SessionSemanticDisplayV1 {
  // A merged compatibility view must fail here, not become a shared presentation source.
  const shared = SessionSharedMetadataV1Schema.parse(input.sharedMetadata);
  const sharedDisplay = SessionSharedDisplayV1Schema.parse({
    v: 1,
    ...(shared.summary ? { summaryText: shared.summary.text } : {}),
    ...(shared.agentPresentation ? { agentPresentation: shared.agentPresentation } : {}),
    ...(shared.bot ? { bot: shared.bot } : {}),
    ...(shared.botFace ? { botFace: shared.botFace } : {}),
    ...(shared.externalSessionOperationPresentationV1 ? { externalSessionOperationPresentationV1: shared.externalSessionOperationPresentationV1 } : {}),
    ...(shared.sessionGuardStateV1 ? { sessionGuardStateV1: shared.sessionGuardStateV1 } : {}),
  });
  const owner = input.ownerMetadata;
  return { shared: sharedDisplay, ...(owner ? { owner: projectSessionOwnerDisplayV1(owner) } : {}) };
}

/** Account-content transitions already open the full owner document, without a Session key. */
export function projectSessionOwnerDisplayV1(owner: SessionOwnerMetadataV1): SessionOwnerDisplayV1 {
  const workspace = owner.workspace;
  const runtime = owner.runtime;
  const terminal = runtime?.terminal?.controlServiceabilityV1;
  const recovery = runtime?.sessionUsageLimitRecoveryV1;
  const imageInputSupported = runtime?.agentRuntimeCapabilitiesV1?.backend?.session?.media?.acceptsImageInput?.supported;
  const linked = owner.nativeSession ? resolveLinkedExternalSessionMetadataV1(owner.nativeSession, 'stored') : null;
  const external = linked?.ok ? linked.linkedSession : null;
  const fork = owner.history?.forkV1;
  return SessionOwnerDisplayV1Schema.parse({
    v: 1,
    ...(workspace?.name !== undefined ? { name: workspace.name } : {}),
    ...(workspace?.path !== undefined ? { path: workspace.path } : {}),
    ...(workspace?.homeDir !== undefined ? { homeDir: workspace.homeDir } : {}),
    ...(workspace?.host !== undefined ? { host: workspace.host } : {}),
    ...(workspace?.machineId !== undefined ? { machineId: workspace.machineId } : {}),
    ...(workspace?.flavor !== undefined ? { flavor: workspace.flavor } : {}),
    ...(workspace?.projectId !== undefined ? { projectId: workspace.projectId } : {}),
    ...(workspace?.workspaceId !== undefined ? { workspaceId: workspace.workspaceId } : {}),
    ...(workspace?.branch !== undefined ? { branch: workspace.branch } : {}),
    ...(workspace?.sessionWorkspaceLocationV1 ? { sessionWorkspaceLocationV1: {
      v: 1, machineId: workspace.sessionWorkspaceLocationV1.machineId,
      agentPath: workspace.sessionWorkspaceLocationV1.agentPath, machinePath: workspace.sessionWorkspaceLocationV1.machinePath,
    } } : {}),
    ...(workspace?.sessionDirectoryV1?.kind === 'managed' ? { sessionDirectoryV1: { v: 1, kind: 'managed' } } : {}),
    ...(external ? { externalSessionV1: {
      v: 1, agentId: external.agentId, machineId: external.machineId,
      remoteSessionId: external.remoteSessionId, source: { kind: external.source.kind },
      ...(external.linkedAtMs !== undefined ? { linkedAtMs: external.linkedAtMs } : {}),
      ...(external.qualifiedIdentity ? { qualifiedIdentity: external.qualifiedIdentity } : {}),
    } } : {}),
    ...(runtime?.externalAgentObservationV1 ? { externalAgentObservationV1: runtime.externalAgentObservationV1 } : {}),
    ...(owner.cursors?.readStateV1 ? { readStateV1: owner.cursors.readStateV1 } : {}),
    ...(owner.cursors?.externalSessionAttentionV1 ? { externalSessionAttentionV1: owner.cursors.externalSessionAttentionV1 } : {}),
    ...(runtime?.lifecycleState !== undefined ? { lifecycleState: runtime.lifecycleState } : {}),
    ...(imageInputSupported !== undefined ? { imageInputSupported } : {}),
    ...(terminal ? { terminalControlServiceabilityV1: {
      v: 1, state: terminal.state, observedAt: terminal.observedAt,
      ...(terminal.reason !== undefined ? { reason: terminal.reason } : {}),
    } } : {}),
    ...(recovery ? { sessionUsageLimitRecoveryV1: projectSessionUsageLimitRecoveryDisplayV1(recovery) } : {}),
    ...(owner.work?.sessionWorkStateV1 ? { workDisplay: projectSessionWorkDisplayV1(owner.work.sessionWorkStateV1) } : {}),
    ...(owner.work?.statusReason !== undefined ? { work: { statusReason: owner.work.statusReason } } : {}),
    ...(owner.work?.sessionAgentActivityHeadlineV1 ? { sessionAgentActivityHeadlineV1: SessionAgentActivityHeadlineV1Schema.parse(owner.work.sessionAgentActivityHeadlineV1) } : {}),
    ...(owner.work?.sessionWorkflowActivityHeadlineV1 ? { sessionWorkflowActivityHeadlineV1: SessionWorkflowActivityHeadlineV1Schema.parse(owner.work.sessionWorkflowActivityHeadlineV1) } : {}),
    ...(fork ? { forkV1: { v: 1, parentSessionId: fork.parentSessionId,
      parentCutoffSeqInclusive: fork.parentCutoffSeqInclusive, createdAtMs: fork.createdAtMs, strategy: fork.strategy } } : {}),
    ...(owner.system?.systemSessionV1?.hidden !== undefined ? { hiddenSystemSession: owner.system.systemSessionV1.hidden } : {}),
    ...(isVoiceConversationCustodySessionMetadata(owner.system) ? { systemSessionKind: 'voice_custody' } : {}),
  });
}
