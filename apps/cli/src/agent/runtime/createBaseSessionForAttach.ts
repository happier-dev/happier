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

  if (attach.encryptionMode === 'plain') {
    return {
      id: existingSessionId,
      seq: 0,
      encryptionMode: 'plain',
      // Plaintext sessions should not require encryption materials. Keep dummy values to satisfy
      // the legacy Session shape; downstream code must branch on encryptionMode.
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      metadata: opts.metadata,
      metadataVersion: -1,
      agentState: opts.state,
      agentStateVersion: -1,
    };
  }

  return {
    id: existingSessionId,
    seq: 0,
    encryptionMode: 'e2ee',
    encryptionKey: attach.encryptionKey,
    encryptionVariant: attach.encryptionVariant,
    metadata: opts.metadata,
    metadataVersion: -1,
    agentState: opts.state,
    agentStateVersion: -1,
  };
}
