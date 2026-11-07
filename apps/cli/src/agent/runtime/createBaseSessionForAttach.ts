import type { AgentState, Metadata, Session as ApiSession } from '@/api/types';
import { readSessionAttachFromEnv } from '@/agent/runtime/sessionAttach';
import { enrichSessionMetadataWithRepository } from './enrichSessionMetadataWithRepository';

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
  await enrichSessionMetadataWithRepository(opts.metadata);
  const seq =
    typeof attach.lastObservedMessageSeq === 'number' && Number.isFinite(attach.lastObservedMessageSeq) && attach.lastObservedMessageSeq >= 0
      ? Math.trunc(attach.lastObservedMessageSeq)
      : 0;
  const initialTranscriptAfterSeq =
    typeof attach.initialTranscriptAfterSeq === 'number'
    && Number.isFinite(attach.initialTranscriptAfterSeq)
    && attach.initialTranscriptAfterSeq >= 0
      ? Math.trunc(attach.initialTranscriptAfterSeq)
      : undefined;
  const legacyAttachAfterSeq =
    initialTranscriptAfterSeq === undefined
    && typeof attach.lastObservedMessageSeq === 'number'
    && Number.isFinite(attach.lastObservedMessageSeq)
    && attach.lastObservedMessageSeq >= 0
      ? Math.trunc(attach.lastObservedMessageSeq)
      : undefined;
  const wakeDeliveryAfterSeq = initialTranscriptAfterSeq ?? legacyAttachAfterSeq;
  if (attach.encryptionMode === 'plain') {
    return {
      id: existingSessionId,
      seq,
      ...(wakeDeliveryAfterSeq !== undefined ? { initialTranscriptAfterSeq: wakeDeliveryAfterSeq } : {}),
      encryptionMode: 'plain',
      metadata: opts.metadata,
      metadataVersion: -1,
      agentState: opts.state,
      agentStateVersion: -1,
    };
  }

  return {
    id: existingSessionId,
    seq,
    ...(wakeDeliveryAfterSeq !== undefined ? { initialTranscriptAfterSeq: wakeDeliveryAfterSeq } : {}),
    encryptionMode: 'e2ee',
    encryptionKey: attach.encryptionKey,
    encryptionVariant: attach.encryptionVariant,
    metadata: opts.metadata,
    metadataVersion: -1,
    agentState: opts.state,
    agentStateVersion: -1,
  };
}
