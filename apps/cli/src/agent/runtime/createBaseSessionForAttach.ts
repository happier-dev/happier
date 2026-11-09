import type { AgentState, Metadata, Session as ApiSession } from '@/api/types';
import { readSessionAttachFromEnv, readSessionAttachFromFile, type SessionAttachSecret } from '@/agent/runtime/sessionAttach';
import { SESSION_METADATA_LAYOUT_VERSION_V1, SessionSharedMetadataV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectCurrentAgentSessionView, resolveAgentExecutionTargetFromSessionMetadata, resolveAgentIdFromSessionMetadata, resolveSessionMetadataAgentIdentity } from '@happier-dev/agents';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import type { SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';

export async function createBaseSessionForAttach(opts: Readonly<{
  existingSessionId: string;
  metadata: Metadata;
  state: AgentState;
  sessionAttachFilePath?: string;
  /** Already-authenticated process-local custody; never persisted or read from Account state. */
  sessionAttachSecret?: SessionAttachSecret;
}>): Promise<ApiSession & Readonly<{ acceptedTeamCredentialBinding?: SessionTeamCredentialBindingIntentV1 | null }>> {
  const existingSessionId = opts.existingSessionId.trim();
  if (!existingSessionId) {
    throw new Error('Missing existingSessionId');
  }

  const attach = opts.sessionAttachSecret
    ?? (opts.sessionAttachFilePath
      ? await readSessionAttachFromFile(opts.sessionAttachFilePath)
      : await readSessionAttachFromEnv());
  if (!attach) {
    throw new Error(`Cannot resume session ${existingSessionId}: missing session attach secret`);
  }
  const lastObservedMessageSeq =
    typeof attach.lastObservedMessageSeq === 'number' && Number.isFinite(attach.lastObservedMessageSeq) && attach.lastObservedMessageSeq >= 0
      ? Math.trunc(attach.lastObservedMessageSeq)
      : undefined;
  const seq = lastObservedMessageSeq ?? 0;
  const initialTranscriptAfterSeq =
    typeof attach.initialTranscriptAfterSeq === 'number'
    && Number.isFinite(attach.initialTranscriptAfterSeq)
    && attach.initialTranscriptAfterSeq >= 0
      ? Math.trunc(attach.initialTranscriptAfterSeq)
      : lastObservedMessageSeq;
  const persistedMetadata = (() => {
    const snapshot = attach.snapshot;
    if (snapshot?.metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) {
      return snapshot?.metadata ?? opts.metadata;
    }
    if (!snapshot.ownerMetadata || !snapshot.ownerMetadataEnvelope) {
      throw new Error(
        `Cannot resume session ${existingSessionId}: missing owner metadata envelope`,
      );
    }
    const sharedMetadata = SessionSharedMetadataV1Schema.safeParse(snapshot.metadata);
    if (!sharedMetadata.success) {
      throw new Error(
        `Cannot resume session ${existingSessionId}: invalid shared metadata envelope`,
      );
    }
    return projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: sharedMetadata.data,
      ownerMetadata: snapshot.ownerMetadata,
    }) as Metadata;
  })();
  const identity = resolveSessionMetadataAgentIdentity(persistedMetadata);
  const correspondence = SessionCreationCorrespondenceV1ReadSchema.safeParse(persistedMetadata.sessionCreationCorrespondenceV1);
  const runnerAgentId = resolveAgentIdFromSessionMetadata(opts.metadata);
  const birthTarget = correspondence.success && runnerAgentId
    ? resolveAgentExecutionTargetFromSessionMetadata(persistedMetadata, runnerAgentId)
    : null;
  const runtimeDescriptor = readRuntimeDescriptorV1FromMetadata(opts.metadata);
  // A committed birth can precede the first runtime publication. The Session
  // client needs its admitted Agent before the ordinary startup merge runs.
  // Seed only this initial in-process view, after matching the runner to the
  // immutable birth target; never replace a published identity or resume key.
  const metadata = (identity.basis === 'none' || identity.basis === 'birth') && !identity.ambiguousVendorResumeKeys
    && !readAcpConfiguredBackendV1FromMetadata(persistedMetadata)
    && runnerAgentId && birthTarget
    && (!birthTarget.definitionId || runtimeDescriptor?.agent.definitionId === birthTarget.definitionId)
    ? projectCurrentAgentSessionView(persistedMetadata, {
      agentId: runnerAgentId,
      runtimeDescriptor,
      configuredBackend: readAcpConfiguredBackendV1FromMetadata(opts.metadata),
    })
    : persistedMetadata;
  const metadataVersion = attach.snapshot?.metadataVersion ?? -1;
  const agentState = attach.snapshot?.agentState ?? opts.state;
  const agentStateVersion = attach.snapshot?.agentStateVersion ?? -1;
  const organization = {
    ...(attach.snapshot?.acceptedTeamCredentialBinding !== undefined
      ? { acceptedTeamCredentialBinding: attach.snapshot.acceptedTeamCredentialBinding } : {}),
    ...(attach.snapshot?.manager ? { manager: attach.snapshot.manager } : {}),
    ...(attach.snapshot?.origin ? { origin: attach.snapshot.origin } : {}),
  };

  if (attach.encryptionMode === 'plain') {
    return {
      id: existingSessionId,
      ...organization,
      seq,
      ...(initialTranscriptAfterSeq !== undefined ? { initialTranscriptAfterSeq } : {}),
      encryptionMode: 'plain',
      metadata,
      ...(attach.snapshot?.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
        ? {
          metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
          ownerMetadata: attach.snapshot.ownerMetadata,
          ownerMetadataEnvelope: attach.snapshot.ownerMetadataEnvelope ?? null,
        }
        : {}),
      metadataVersion,
      agentState,
      agentStateVersion,
      ...(attach.snapshot?.pendingExecutionRunIds
        ? { pendingExecutionRunIds: attach.snapshot.pendingExecutionRunIds }
        : {}),
    };
  }

  return {
    id: existingSessionId,
    ...organization,
    seq,
    ...(initialTranscriptAfterSeq !== undefined ? { initialTranscriptAfterSeq } : {}),
    encryptionMode: 'e2ee',
    encryptionKey: attach.encryptionKey,
    encryptionVariant: attach.encryptionVariant,
    metadata,
    ...(attach.snapshot?.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
      ? {
        metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
        ownerMetadata: attach.snapshot.ownerMetadata,
        ownerMetadataEnvelope: attach.snapshot.ownerMetadataEnvelope ?? null,
      }
      : {}),
    metadataVersion,
    agentState,
    agentStateVersion,
    ...(attach.snapshot?.pendingExecutionRunIds
      ? { pendingExecutionRunIds: attach.snapshot.pendingExecutionRunIds }
      : {}),
  };
}
