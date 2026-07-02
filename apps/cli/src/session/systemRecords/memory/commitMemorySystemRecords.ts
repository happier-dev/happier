import type { SessionSummaryShardV1, SessionSynopsisV1 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  upsertSessionSystemRecord,
} from '@/session/transport/http/sessionSystemRecordsHttp';

import {
  buildMemorySummaryShardSystemRecordLocalId,
  buildMemorySynopsisSystemRecordLocalId,
  MEMORY_SYSTEM_RECORD_KINDS,
  MEMORY_SYSTEM_RECORD_NAMESPACE,
  sealMemorySystemRecordPayload,
} from './memorySystemRecords';

export type CommitMemorySystemRecordsDeps = Readonly<{
  upsertSessionSystemRecord: typeof upsertSessionSystemRecord;
}>;

export async function commitMemorySystemRecords(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  mode: SessionStoredContentEncryptionMode;
  ctx?: SessionEncryptionContext;
  shard: Readonly<{ sessionId: string; payload: SessionSummaryShardV1 }>;
  synopsis: Readonly<{ sessionId: string; payload: SessionSynopsisV1 }> | null;
  deps?: Partial<CommitMemorySystemRecordsDeps>;
}>): Promise<void> {
  const deps: CommitMemorySystemRecordsDeps = {
    upsertSessionSystemRecord,
    ...params.deps,
  };

  const shardLocalId = buildMemorySummaryShardSystemRecordLocalId({
    seqFrom: params.shard.payload.seqFrom,
    seqTo: params.shard.payload.seqTo,
  });
  await deps.upsertSessionSystemRecord({
    token: params.credentials.token,
    sessionId: params.sessionId,
    namespace: MEMORY_SYSTEM_RECORD_NAMESPACE,
    kind: MEMORY_SYSTEM_RECORD_KINDS.summaryShard,
    localId: shardLocalId,
    content: sealMemorySystemRecordPayload({
      mode: params.mode,
      ctx: params.ctx,
      kind: MEMORY_SYSTEM_RECORD_KINDS.summaryShard,
      payload: params.shard.payload,
    }),
  });

  if (!params.synopsis) return;

  const synopsisLocalId = buildMemorySynopsisSystemRecordLocalId({ seqTo: params.synopsis.payload.seqTo });
  await deps.upsertSessionSystemRecord({
    token: params.credentials.token,
    sessionId: params.sessionId,
    namespace: MEMORY_SYSTEM_RECORD_NAMESPACE,
    kind: MEMORY_SYSTEM_RECORD_KINDS.synopsis,
    localId: synopsisLocalId,
    content: sealMemorySystemRecordPayload({
      mode: params.mode,
      ctx: params.ctx,
      kind: MEMORY_SYSTEM_RECORD_KINDS.synopsis,
      payload: params.synopsis.payload,
    }),
  });
}
