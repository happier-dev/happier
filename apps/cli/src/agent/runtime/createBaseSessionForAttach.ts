import type { AgentState, Metadata, Session as ApiSession } from '@/api/types';
import { readSessionAttachFromEnv } from '@/agent/runtime/sessionAttach';

export async function createBaseSessionForAttach(opts: Readonly<{
  existingSessionId: string;
  metadata: Metadata;
  state: AgentState;
}>): Promise<ApiSession> {
  const existingSessionId = opts.existingSessionId.trim();
  if (!existingSessionId) {
    throw new Error('Missing existingSessionId');
  }

  const attach = await readSessionAttachFromEnv();
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
  const metadata = attach.snapshot?.metadata ?? opts.metadata;
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
    metadataVersion,
    agentState,
    agentStateVersion,
  };
}
