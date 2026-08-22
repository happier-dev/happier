import { describe, expect, it, vi } from 'vitest';

import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

import { createSessionSystemRecordPayloadService } from './sessionSystemRecordPayloadService';

function synopsisPayload() {
  return {
    v: 1 as const,
    seqTo: 1,
    updatedAtMs: 1,
    synopsis: 'Private session summary',
  };
}

function createE2eeSession(
  overrides: Partial<SessionClientPort> = {},
): SessionClientPort {
  const session: SessionClientPort = {
    sessionId: 'session-1',
    rpcHandlerManager: {
      registerHandler: vi.fn(),
      invokeLocal: vi.fn(async () => undefined),
    },
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn(),
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => null,
    hasUserMessageLocalConsumption: () => false,
    waitForMetadataUpdate: async () => false,
    popPendingMessage: async () => false,
    shouldAttemptPendingMaterialization: () => false,
    peekPendingMessageQueueV2Count: async () => 0,
    discardPendingMessageQueueV2All: async () => 0,
    discardCommittedMessageLocalIds: async () => 0,
    flush: async () => undefined,
    close: async () => undefined,
    getStoredContentEncryptionContext: () => ({
      mode: 'e2ee' as const,
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'dataKey' as const,
      },
    }),
  };
  return Object.assign(session, overrides);
}

describe('sessionSystemRecordPayloadService', () => {
  it('fails closed when an E2EE Session receives a plaintext system-record envelope', async () => {
    const fetchSessionSystemRecord = vi.fn(async () => ({
      id: 'record-1',
      sessionId: 'session-1',
      namespace: 'memory' as const,
      kind: 'synopsis.v1' as const,
      localId: 'memory:synopsis:v1:1',
      content: { t: 'plain' as const, v: synopsisPayload() },
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    }));
    const service = createSessionSystemRecordPayloadService(createE2eeSession({
      fetchSessionSystemRecord,
    }));

    await expect(service.read({
      namespace: 'memory',
      localId: 'memory:synopsis:v1:1',
    })).rejects.toThrow('Session system record content did not match the Session encryption mode');
    expect(fetchSessionSystemRecord).toHaveBeenCalledWith({
      namespace: 'memory',
      localId: 'memory:synopsis:v1:1',
    });
  });

  it('opens an encrypted envelope with the fixed E2EE Session context', async () => {
    const context = {
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'dataKey' as const,
    };
    const payload = synopsisPayload();
    const service = createSessionSystemRecordPayloadService(createE2eeSession({
      getStoredContentEncryptionContext: () => ({ mode: 'e2ee', ctx: context }),
      fetchSessionSystemRecord: vi.fn(async () => ({
        id: 'record-1',
        sessionId: 'session-1',
        namespace: 'memory' as const,
        kind: 'synopsis.v1' as const,
        localId: 'memory:synopsis:v1:1',
        content: {
          t: 'encrypted' as const,
          c: encryptSessionPayload({ ctx: context, payload }),
        },
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      })),
    }));

    await expect(service.read({
      namespace: 'memory',
      localId: 'memory:synopsis:v1:1',
    })).resolves.toEqual({
      namespace: 'memory',
      kind: 'synopsis.v1',
      localId: 'memory:synopsis:v1:1',
      payload,
    });
  });
});
