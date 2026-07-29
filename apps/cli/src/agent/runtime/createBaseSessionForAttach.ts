import type { AgentState, Metadata, Session as ApiSession } from '@/api/types';
import { readSessionAttachFromEnv, readSessionAttachFromFile } from '@/agent/runtime/sessionAttach';
import {
  SESSION_METADATA_LAYOUT_VERSION_V1,
  SessionSharedMetadataV1Schema,
  projectSessionOwnerCompatibilityViewV1,
} from '@happier-dev/protocol';

export async function createBaseSessionForAttach(opts: Readonly<{
  existingSessionId: string;
  metadata: Metadata;
  state: AgentState;
  sessionAttachFilePath?: string;
}>): Promise<ApiSession> {
  const existingSessionId = opts.existingSessionId.trim();
  if (!existingSessionId) {
    throw new Error('Missing existingSessionId');
  }

  const attach = opts.sessionAttachFilePath
    ? await readSessionAttachFromFile(opts.sessionAttachFilePath)
    : await readSessionAttachFromEnv();
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
  const metadata = (() => {
    const snapshot = attach.snapshot;
    if (snapshot?.metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) {
      return snapshot?.metadata ?? opts.metadata;
    }
    if (!snapshot.ownerMetadata) {
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
  const metadataVersion = attach.snapshot?.metadataVersion ?? -1;
  const agentState = attach.snapshot?.agentState ?? opts.state;
  const agentStateVersion = attach.snapshot?.agentStateVersion ?? -1;

  if (attach.encryptionMode === 'plain') {
    return {
      id: existingSessionId,
      seq,
      ...(initialTranscriptAfterSeq !== undefined ? { initialTranscriptAfterSeq } : {}),
      encryptionMode: 'plain',
      metadata,
      ...(attach.snapshot?.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
        ? {
          metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
          ownerMetadata: attach.snapshot.ownerMetadata,
          ownerMetadataCiphertext: attach.snapshot.ownerMetadataCiphertext ?? null,
        }
        : {}),
      metadataVersion,
      agentState,
      agentStateVersion,
    };
  }

  return {
    id: existingSessionId,
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
        ownerMetadataCiphertext: attach.snapshot.ownerMetadataCiphertext ?? null,
      }
      : {}),
    metadataVersion,
    agentState,
    agentStateVersion,
  };
}
