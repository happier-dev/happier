import type { SessionSummaryShardV1, SessionSynopsisV1 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { encryptSessionPayload, type SessionEncryptionContext } from '@/sessionControl/sessionEncryptionContext';
import { commitSessionEncryptedMessage } from '@/sessionControl/sessionsHttp';

import { buildSummaryShardLocalId, buildSynopsisLocalId } from '../artifacts/buildMemoryArtifactLocalId';

export type CommitMemoryHintArtifactsDeps = Readonly<{
  commitSessionEncryptedMessage: typeof commitSessionEncryptedMessage;
}>;

function buildStructuredMemoryArtifact(params: Readonly<{ kind: string; payload: unknown }>): unknown {
  return {
    role: 'agent',
    content: { type: 'text', text: '[memory]' },
    meta: {
      happier: {
        kind: params.kind,
        payload: params.payload,
      },
    },
  };
}

export async function commitMemoryHintArtifacts(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  ctx: SessionEncryptionContext;
  shard: Readonly<{ sessionId: string; payload: SessionSummaryShardV1 }>;
  synopsis: Readonly<{ sessionId: string; payload: SessionSynopsisV1 }> | null;
  deps?: Partial<CommitMemoryHintArtifactsDeps>;
}>): Promise<void> {
  const deps: CommitMemoryHintArtifactsDeps = {
    commitSessionEncryptedMessage,
    ...params.deps,
  };

  const shardLocalId = buildSummaryShardLocalId({ seqFrom: params.shard.payload.seqFrom, seqTo: params.shard.payload.seqTo });
  const shardCiphertext = encryptSessionPayload({
    ctx: params.ctx,
    payload: buildStructuredMemoryArtifact({ kind: 'session_summary_shard.v1', payload: params.shard.payload }),
  });
  await deps.commitSessionEncryptedMessage({
    token: params.credentials.token,
    sessionId: params.sessionId,
    ciphertext: shardCiphertext,
    localId: shardLocalId,
  });

  if (params.synopsis) {
    const synopsisLocalId = buildSynopsisLocalId({ seqTo: params.synopsis.payload.seqTo });
    const synopsisCiphertext = encryptSessionPayload({
      ctx: params.ctx,
      payload: buildStructuredMemoryArtifact({ kind: 'session_synopsis.v1', payload: params.synopsis.payload }),
    });
    await deps.commitSessionEncryptedMessage({
      token: params.credentials.token,
      sessionId: params.sessionId,
      ciphertext: synopsisCiphertext,
      localId: synopsisLocalId,
    });
  }
}

