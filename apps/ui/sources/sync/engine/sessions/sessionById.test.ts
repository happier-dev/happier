import { describe, expect, it, vi } from 'vitest';

import { fetchAndApplySessionById } from './sessionById';

describe('fetchAndApplySessionById', () => {
  it('applies a plaintext session row by id', async () => {
    const applySessions = vi.fn();
    const decryptEncryptionKey = vi.fn(async () => null);
    const initializeSessions = vi.fn(async () => {});
    const getSessionEncryption = vi.fn(() => null);

    const responseJson = {
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 1,
        agentState: JSON.stringify({ controlledByUser: true }),
        share: null,
      },
    };

    const request = vi.fn(async () => new Response(JSON.stringify(responseJson), { status: 200 }));
    const sessionDataKeys = new Map<string, Uint8Array>();

    await fetchAndApplySessionById({
      sessionId: 's1',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption,
      },
      sessionDataKeys,
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(request).toHaveBeenCalledWith('/v2/sessions/s1', expect.any(Object));
    expect(initializeSessions).toHaveBeenCalledWith(new Map([['s1', null]]));
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's1',
        encryptionMode: 'plain',
        metadata: expect.any(Object),
        agentState: expect.any(Object),
      }),
    ]);
  });

  it('initializes session encryption when dataEncryptionKey is present', async () => {
    const applySessions = vi.fn();
    const decryptEncryptionKey = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const initializeSessions = vi.fn(async () => {});
    const decryptMetadata = vi.fn(async () => ({ readStateV1: null }));
    const decryptAgentState = vi.fn(async () => ({ controlledByUser: true }));

    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'dek',
        metadataVersion: 1,
        metadata: 'enc-meta',
        agentStateVersion: 1,
        agentState: 'enc-state',
        share: null,
      },
    }), { status: 200 }));

    const sessionDataKeys = new Map<string, Uint8Array>();

    await fetchAndApplySessionById({
      sessionId: 's1',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption: () => ({ decryptMetadata, decryptAgentState } as any),
      },
      sessionDataKeys,
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(decryptEncryptionKey).toHaveBeenCalledWith('dek');
    expect(initializeSessions).toHaveBeenCalledWith(new Map([['s1', new Uint8Array([1, 2, 3])]]));
    expect(sessionDataKeys.get('s1')).toEqual(new Uint8Array([1, 2, 3]));
    expect(decryptMetadata).toHaveBeenCalledWith(1, 'enc-meta');
    expect(decryptAgentState).toHaveBeenCalledWith(1, 'enc-state');
  });
});
