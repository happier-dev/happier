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
    const request = vi.fn(async (path: string, _init: RequestInit) => {
      if (path === '/v2/sessions/s_legacy') {
        return new Response(JSON.stringify({
          error: 'Not found',
          path: '/v2/sessions/s_legacy',
          method: 'GET',
        }), { status: 404 });
      }

      if (path === '/v1/sessions/s_legacy/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
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
      '/v1/sessions/s_legacy/turns',
    ]);
  });

  it('hydrates session turn projection for rollback read models', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s1') {
        return new Response(JSON.stringify({
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
        }), { status: 200 });
      }

      expect(path).toBe('/v1/sessions/s1/turns');
      return new Response(JSON.stringify({
        v: 1,
        sessionId: 's1',
        latestTurnId: 'turn-1',
        updatedAt: 4,
        turns: [
          {
            turnId: 'turn-1',
            status: 'completed',
            startedAt: 1,
            updatedAt: 4,
            terminalAt: 4,
            transcriptAnchors: {
              startUserMessageSeq: 1,
              userMessageSeqs: [1, 3],
              startSeqInclusive: 1,
              endSeqInclusive: 4,
            },
            rollback: { state: 'eligible', updatedAt: 4 },
          },
        ],
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
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
      log: { log: () => {} },
    });

    expect(result.ok).toBe(true);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/v2/sessions/s1',
      '/v1/sessions/s1/turns',
    ]);
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's1',
        sessionTurns: expect.objectContaining({
          latestTurnId: 'turn-1',
          turns: [expect.objectContaining({ turnId: 'turn-1' })],
        }),
        rollbackEligibleTurnStarts: [1],
      }),
    ]);
  });

  it('hydrates from /v1/sessions when older servers are missing both /v2 session routes', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_legacy_v1') {
        return new Response(JSON.stringify({
          error: 'Not found',
          path: '/v2/sessions/s_legacy_v1',
          method: 'GET',
        }), { status: 404 });
      }

      if (path === '/v2/sessions?limit=200') {
        return new Response(JSON.stringify({
          error: 'Not found',
          path: '/v2/sessions',
          method: 'GET',
        }), { status: 404 });
      }

      if (path === '/v1/sessions/s_legacy_v1/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }

      expect(path).toBe('/v1/sessions');
      return new Response(JSON.stringify({
        sessions: [
          {
            id: 's_legacy_v1',
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
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_legacy_v1',
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
        id: 's_legacy_v1',
        encryptionMode: 'plain',
      }),
    ]);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/v2/sessions/s_legacy_v1',
      '/v2/sessions?limit=200',
      '/v1/sessions',
      '/v1/sessions/s_legacy_v1/turns',
    ]);
  });

  it('returns not_found for the current-server session-by-id 404 contract without compat scanning', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
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
  });

  it.each([401, 403] as const)('throws terminal auth for session-by-id status %s', async (status) => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'auth failed' }), { status }));

    await expect(fetchAndApplySessionById({
      sessionId: 's_auth_failed',
      credentials: { token: 't', secret: 's' },
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
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption: () => ({ decryptMetadata, decryptAgentState } as any),
      },
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
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({ decryptMetadata, decryptAgentState } as any),
      },
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
        metadata: expect.objectContaining({ readStateV1: null }),
        agentState: { controlledByUser: true },
      }),
    ]);
  });

  it('coalesces concurrent session detail HTTP reads for the same request transport', async () => {
    const detailGate = createDeferred<void>();
    let detailRequests = 0;
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_coalesced') {
        detailRequests += 1;
        await detailGate.promise;
        return new Response(JSON.stringify({
          session: {
            id: 's_coalesced',
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
        }), { status: 200 });
      }

      if (path === '/v1/sessions/s_coalesced/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }

      throw new Error(`unexpected path ${path}`);
    });

    const encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      getSessionEncryption: () => null,
    } satisfies SessionByIdEncryption;
    const baseParams = {
      sessionId: 's_coalesced',
      credentials: { token: 't' } as any,
      encryption,
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      log: { log: () => {} },
    };

    const firstApplySessions = vi.fn();
    const secondApplySessions = vi.fn();
    const first = fetchAndApplySessionById({ ...baseParams, applySessions: firstApplySessions });
    const second = fetchAndApplySessionById({ ...baseParams, applySessions: secondApplySessions });

    await expect.poll(() => detailRequests, { timeout: 100 }).toBe(1);
    detailGate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(request.mock.calls.filter((call) => call[0] === '/v2/sessions/s_coalesced')).toHaveLength(1);
    expect(firstApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_coalesced' })]);
    expect(secondApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_coalesced' })]);
  });

  it('coalesces concurrent scoped session detail HTTP reads across request wrappers', async () => {
    const detailGate = createDeferred<void>();
    let detailRequests = 0;
    const createRequest = () => vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_scoped_coalesced') {
        detailRequests += 1;
        await detailGate.promise;
        return new Response(JSON.stringify({
          session: {
            id: 's_scoped_coalesced',
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
        }), { status: 200 });
      }

      if (path === '/v1/sessions/s_scoped_coalesced/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }

      throw new Error(`unexpected path ${path}`);
    });

    const encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      getSessionEncryption: () => null,
    } satisfies SessionByIdEncryption;
    const baseParams = {
      sessionId: 's_scoped_coalesced',
      serverId: 'server-a',
      credentials: { token: 't' } as any,
      encryption,
      sessionDataKeys: new Map<string, Uint8Array>(),
      log: { log: () => {} },
    };

    const firstApplySessions = vi.fn();
    const secondApplySessions = vi.fn();
    const first = fetchAndApplySessionById({
      ...baseParams,
      request: createRequest(),
      applySessions: firstApplySessions,
    });
    const second = fetchAndApplySessionById({
      ...baseParams,
      request: createRequest(),
      applySessions: secondApplySessions,
    });

    await expect.poll(() => detailRequests, { timeout: 100 }).toBe(1);
    detailGate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(detailRequests).toBe(1);
    expect(firstApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_scoped_coalesced' })]);
    expect(secondApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_scoped_coalesced' })]);
  });

  it('can hydrate the session shell without fetching the turns projection', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_shell_only') {
        return new Response(JSON.stringify({
          session: {
            id: 's_shell_only',
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
        }), { status: 200 });
      }

      if (path === '/v1/sessions/s_shell_only/turns') {
        throw new Error('turns projection should not be fetched for shell-only hydration');
      }

      throw new Error(`unexpected path ${path}`);
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_shell_only',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions: vi.fn(),
      log: { log: () => {} },
      includeTurnsProjection: false,
    });

    expect(result.ok).toBe(true);
    expect(request.mock.calls.map((call) => call[0])).toEqual(['/v2/sessions/s_shell_only']);
  });

  it('uses browser-CORS-safe headers for targeted session detail reads', async () => {
    const request = vi.fn(async (path: string, _init: RequestInit) => {
      if (path === '/v2/sessions/s_purpose') {
        return new Response(JSON.stringify({
          session: {
            id: 's_purpose',
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
        }), { status: 200 });
      }

      throw new Error(`unexpected path ${path}`);
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_purpose',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions: vi.fn(),
      log: { log: () => {} },
      includeTurnsProjection: false,
    });

    expect(result.ok).toBe(true);
    const headers = request.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer t',
      'Content-Type': 'application/json',
    }));
    expect(headers).not.toHaveProperty('X-Happier-Request-Purpose');
  });
});
