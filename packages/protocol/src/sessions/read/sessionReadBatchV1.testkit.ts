import { V2SessionRecordSchema } from '../control/contract.js';
import { SessionReadBatchResponseV1Schema, type SessionReadBatchResponseV1 } from './sessionReadBatchV1.js';

/** Network-boundary fixture for exact, server-proved structural membership. */
export function createSessionMembershipReadFixture(sessionIds: readonly string[], availableIds: readonly string[] = sessionIds): SessionReadBatchResponseV1 {
  const available = new Set(availableIds);
  return SessionReadBatchResponseV1Schema.parse({ results: sessionIds.map(sessionId => ({ sessionId,
    detail: available.has(sessionId) ? { status: 200, body: { session: V2SessionRecordSchema.parse({
      id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      metadata: '{}', metadataVersion: 0, agentState: null, agentStateVersion: 0,
      encryptionMode: 'plain', dataEncryptionKey: null,
    }) } } : { status: 404, body: { error: 'not_found' } },
  })) });
}
