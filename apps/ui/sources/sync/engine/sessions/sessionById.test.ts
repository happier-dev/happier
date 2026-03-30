import { describe, expect, it, vi } from 'vitest';

import { fetchAndApplySessionById } from './sessionById';

const onAgentRequest = vi.fn();

vi.mock('@/voice/context/voiceHooks', () => ({
  voiceHooks: {
    onAgentRequest: (...args: Parameters<typeof onAgentRequest>) => onAgentRequest(...args),
  },
}));

describe('fetchAndApplySessionById', () => {
  it('announces new fetched agent requests relative to existing session state', async () => {
    onAgentRequest.mockReset();
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
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
        agentStateVersion: 2,
        agentState: JSON.stringify({
          controlledByUser: true,
          requests: {
            req_1: {
              tool: 'AskUserQuestion',
              kind: 'user_action',
              arguments: { question: 'Pick a color' },
              createdAt: 1,
            },
          },
          completedRequests: {},
        }),
        share: null,
      },
    }), { status: 200 }));

    await fetchAndApplySessionById({
      sessionId: 's1',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      getExistingSession: () => ({
        id: 's1',
        agentState: {
          controlledByUser: true,
          requests: {},
          completedRequests: {},
        },
      } as any),
      log: { log: () => {} },
    });

    expect(onAgentRequest).toHaveBeenCalledWith(
      's1',
      'req_1',
      'user_action',
      'AskUserQuestion',
      { question: 'Pick a color' },
    );
  });

  it('captures the previous session before applySessions updates storage', async () => {
    onAgentRequest.mockReset();

    let storedSession = {
      id: 's1',
      agentState: {
        controlledByUser: true,
        requests: {},
        completedRequests: {},
      },
    } as any;

    const request = vi.fn(async () => new Response(JSON.stringify({
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
        agentStateVersion: 2,
        agentState: JSON.stringify({
          controlledByUser: true,
          requests: {
            req_1: {
              tool: 'AskUserQuestion',
              kind: 'user_action',
              arguments: { question: 'Pick a color' },
              createdAt: 1,
            },
          },
          completedRequests: {},
        }),
        share: null,
      },
    }), { status: 200 }));

    await fetchAndApplySessionById({
      sessionId: 's1',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions: ([nextSession]) => {
        storedSession = nextSession as any;
      },
      getExistingSession: () => storedSession,
      log: { log: () => {} },
    });

    expect(onAgentRequest).toHaveBeenCalledWith(
      's1',
      'req_1',
      'user_action',
      'AskUserQuestion',
      { question: 'Pick a color' },
    );
  });

  it('applies a plaintext session row by id', async () => {
    onAgentRequest.mockReset();
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
        lastViewedSessionSeq: 2,
        pendingPermissionRequestCount: 3,
        pendingUserActionRequestCount: 1,
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
        lastViewedSessionSeq: 2,
        pendingPermissionRequestCount: 3,
        pendingUserActionRequestCount: 1,
      }),
    ]);
  });

  it('stores the owning serverId on hydrated sessions when fetch scope is known', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
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
    }), { status: 200 }));

    await fetchAndApplySessionById({
      sessionId: 's1',
      serverId: 'server-owned',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's1',
        serverId: 'server-owned',
      }),
    ]);
  });

  it('initializes session encryption when dataEncryptionKey is present', async () => {
    onAgentRequest.mockReset();
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
