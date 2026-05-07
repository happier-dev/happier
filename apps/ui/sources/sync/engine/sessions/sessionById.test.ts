import { describe, expect, it, vi } from 'vitest';

import { fetchAndApplySessionById, type SessionByIdEncryption } from './sessionById';

const onAgentRequest = vi.fn();

vi.mock('@/voice/context/voiceHooks', () => ({
  voiceHooks: {
    onAgentRequest: (...args: Parameters<typeof onAgentRequest>) => onAgentRequest(...args),
  },
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('fetchAndApplySessionById', () => {
  it('accepts legacy-compatible single-session payloads when newer fields are omitted', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_legacy_payload',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 1,
        agentState: JSON.stringify({ controlledByUser: true }),
        accessLevel: 'admin',
        canApprovePermissions: true,
      },
    }), { status: 200 }));

    const getSessionEncryption = vi.fn(() => null);
    const result = await fetchAndApplySessionById({
      sessionId: 's_legacy_payload',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result.ok).toBe(true);
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_legacy_payload',
        accessLevel: 'admin',
        canApprovePermissions: true,
      }),
    ]);
    expect(getSessionEncryption).not.toHaveBeenCalled();
  });

  it('falls back to scanning /v2/sessions when the single-session route is missing', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_legacy') {
        return new Response(JSON.stringify({
          error: 'Not found',
          path: '/v2/sessions/s_legacy',
          method: 'GET',
        }), { status: 404 });
      }

      expect(path).toBe('/v2/sessions?limit=200');
      return new Response(JSON.stringify({
        sessions: [
          {
            id: 's_legacy',
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
        ],
        nextCursor: null,
        hasNext: false,
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_legacy',
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

    expect(result.ok).toBe(true);
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_legacy',
        encryptionMode: 'plain',
      }),
    ]);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/v2/sessions/s_legacy',
      '/v2/sessions?limit=200',
    ]);
  });

  it('returns not_found for the current-server session-by-id 404 contract without compat scanning', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (_path: string) => new Response(JSON.stringify({
      error: 'Session not found',
    }), { status: 404 }));

    const result = await fetchAndApplySessionById({
      sessionId: 's_missing',
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

    expect(result).toEqual({
      ok: false,
      session: null,
      errorCode: 'not_found',
      httpStatus: 404,
    });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/v2/sessions/s_missing',
    ]);
  });

  it.each([401, 403] as const)('throws terminal auth for session-by-id status %s', async (status) => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'auth failed' }), { status }));

    await expect(fetchAndApplySessionById({
      sessionId: 's_auth_failed',
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
    })).rejects.toMatchObject({
      name: 'HappyError',
      kind: 'auth',
      code: 'not_authenticated',
    });

    expect(applySessions).not.toHaveBeenCalled();
  });

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
        dataEncryptionKey: 'unused-plain-key',
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
    expect(decryptEncryptionKey).not.toHaveBeenCalled();
    expect(initializeSessions).not.toHaveBeenCalled();
    expect(getSessionEncryption).not.toHaveBeenCalled();
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
      credentials: { token: 't', secret: 's' },
      encryption: {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption: () => ({ decryptMetadata, decryptAgentState }),
      } satisfies SessionByIdEncryption,
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

  it('reuses a cached session data key when the encrypted envelope is unchanged', async () => {
    const applySessions = vi.fn();
    const decryptEncryptionKey = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const initializeSessions = vi.fn(async () => {});
    const decryptMetadata = vi.fn(async () => ({ readStateV1: null }));
    const decryptAgentState = vi.fn(async () => ({ controlledByUser: true }));
    const cachedKey = new Uint8Array([7, 7, 7]);

    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_cached',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'cached-envelope',
        metadataVersion: 1,
        metadata: 'enc-meta',
        agentStateVersion: 1,
        agentState: 'enc-state',
        share: null,
      },
    }), { status: 200 }));

    const sessionDataKeys = new Map<string, Uint8Array>([['s_cached', cachedKey]]);
    const sessionDataKeyEnvelopes = new Map<string, string>([['s_cached', 'cached-envelope']]);

    await fetchAndApplySessionById({
      sessionId: 's_cached',
      credentials: { token: 't', secret: 's' },
      encryption: {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption: () => ({ decryptMetadata, decryptAgentState }),
      } satisfies SessionByIdEncryption,
      sessionDataKeys,
      sessionDataKeyEnvelopes,
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(decryptEncryptionKey).not.toHaveBeenCalled();
    expect(initializeSessions).toHaveBeenCalledWith(new Map([['s_cached', cachedKey]]));
    expect(sessionDataKeys.get('s_cached')).toBe(cachedKey);
    expect(sessionDataKeyEnvelopes.get('s_cached')).toBe('cached-envelope');
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_cached',
        metadata: { readStateV1: null },
        agentState: { controlledByUser: true },
      }),
    ]);
  });

  it('starts encrypted metadata and agent-state decrypts before awaiting either result', async () => {
    const applySessions = vi.fn();
    const metadataDeferred = createDeferred<{ readStateV1: null }>();
    const agentStateDeferred = createDeferred<{ controlledByUser: true }>();
    const decryptMetadata = vi.fn(async () => metadataDeferred.promise);
    const decryptAgentState = vi.fn(async () => agentStateDeferred.promise);

    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_parallel',
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

    const fetchPromise = fetchAndApplySessionById({
      sessionId: 's_parallel',
      credentials: { token: 't', secret: 's' },
      encryption: {
        decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({ decryptMetadata, decryptAgentState }),
      } satisfies SessionByIdEncryption,
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    try {
      await expect.poll(() => ({
        metadata: decryptMetadata.mock.calls.length,
        agentState: decryptAgentState.mock.calls.length,
      }), { timeout: 100 }).toEqual({ metadata: 1, agentState: 1 });
    } finally {
      metadataDeferred.resolve({ readStateV1: null });
      agentStateDeferred.resolve({ controlledByUser: true });
      await fetchPromise;
    }

    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_parallel',
        metadata: { readStateV1: null },
        agentState: { controlledByUser: true },
      }),
    ]);
  });
});
