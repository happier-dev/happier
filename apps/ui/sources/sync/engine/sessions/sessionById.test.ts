import { describe, expect, it, vi } from 'vitest';
import {
  ExternalSessionOperationSharedPresentationV1Schema,
  createPlainSessionOwnerMetadataEnvelopeV1,
  projectSessionSharedMetadataV1,
  sealSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
  type AccountEncryptionCurrentnessResponse,
} from '@happier-dev/protocol';

import { encodeBase64 } from '@/encryption/base64';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
  fetchAndApplySessionById as fetchAndApplySessionByIdSource,
  type SessionByIdEncryption,
} from './sessionById';

const E2EE_ACCOUNT_CURRENTNESS = {
  mode: 'e2ee',
  version: 1,
  signingKeyFingerprint: 'signing-1',
  contentKeyFingerprint: 'content-1',
  updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;
const PLAIN_ACCOUNT_CURRENTNESS = {
  mode: 'plain',
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;

function fetchAndApplySessionById(
  params: Omit<
    Parameters<typeof fetchAndApplySessionByIdSource>[0],
    'accountCurrentness'
  > & Readonly<{
    accountCurrentness?: AccountEncryptionCurrentnessResponse;
  }>,
) {
  return fetchAndApplySessionByIdSource({
    ...params,
    accountCurrentness:
      params.accountCurrentness ?? E2EE_ACCOUNT_CURRENTNESS,
  });
}

const onAgentRequest = vi.fn();
const OWNER_METADATA_ENVELOPE = sealSessionOwnerMetadataEnvelopeV1({
  material: {
    type: 'dataKey',
    machineKey: new Uint8Array(32).fill(42),
  },
  ownerMetadata: SessionOwnerMetadataV1Schema.parse({
    v: 1,
    workspace: {
      path: '/private',
      host: 'owner-host',
    },
  }),
  randomBytes: (length) => new Uint8Array(length).fill(1),
});
const OWNER_TEST_CREDENTIALS = {
  token: 't',
  encryption: {
    publicKey: encodeBase64(new Uint8Array(32).fill(41), 'base64'),
    machineKey: encodeBase64(new Uint8Array(32).fill(42), 'base64'),
  },
} as const;

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
  it('hydrates owner shared metadata, owner metadata, and full agent state without merging envelopes', async () => {
    const privateLegacyMetadata = {
      path: '/private/worktree',
      machineId: 'machine-private',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-private',
        remoteSessionId: 'native-private',
        source: { kind: 'codexHome', home: 'local' },
        linkedAtMs: 1,
      },
    };
    const sharedMetadata = projectSessionSharedMetadataV1({
      metadata: {
        ...privateLegacyMetadata,
        summary: { text: 'Safe title', updatedAt: 10 },
      },
      agentState: {
        controlledByUser: false,
        requests: {
          privateRequest: { tool: 'dangerous-private-detail' },
        },
      },
    });
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: privateLegacyMetadata.path,
        machineId: privateLegacyMetadata.machineId,
      },
      nativeSession: {
        externalSessionV1: {
          ...privateLegacyMetadata.externalSessionV1,
          source: { kind: 'codexHome', home: 'user' },
        },
      },
    });
    const ownerMetadataEnvelope =
      createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata);
    const fullAgentState = {
      controlledByUser: false,
      requests: {
        privateRequest: { tool: 'dangerous-private-detail' },
      },
    };
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v1/sessions/s_owner/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      expect(path).toBe('/v2/sessions/s_owner');
      return new Response(JSON.stringify({
        session: {
          id: 's_owner',
          createdAt: 1,
          updatedAt: 2,
          seq: 3,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadataLayoutVersion: 1,
          metadataVersion: 4,
          metadata: JSON.stringify(sharedMetadata),
          ownerMetadata: ownerMetadataEnvelope,
          agentStateVersion: 5,
          agentState: JSON.stringify(fullAgentState),
          share: null,
        },
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_owner',
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      credentials: { token: 't' },
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
      includeMetadataTupleMutationSnapshot: true,
    });

    expect(result.ok).toBe(true);
    const hydrated = applySessions.mock.calls[0]?.[0]?.[0];
    expect(hydrated.metadata).toEqual(sharedMetadata);
    expect(hydrated).not.toHaveProperty('ownerMetadata');
    expect(hydrated.ownerMetadataView).toEqual(expect.objectContaining({
      path: '/private/worktree',
      machineId: 'machine-private',
    }));
    expect(hydrated.agentState).toEqual(fullAgentState);
    expect(hydrated.metadata).not.toHaveProperty('path');
    expect(hydrated.metadata).not.toHaveProperty('ownerMetadata');
    expect(result.session).not.toHaveProperty('ownerMetadata');
    expect(result.metadataTupleMutationSnapshot).toEqual({
      mode: 'owner',
      metadataLayoutVersion: 1,
      metadataVersion: 4,
      sharedMetadataCiphertext: JSON.stringify(sharedMetadata),
      ownerMetadataEnvelope,
      agentStateVersion: 5,
      agentStateCiphertext: JSON.stringify(fullAgentState),
      value: {
        metadata: expect.objectContaining({
          path: '/private/worktree',
          machineId: 'machine-private',
        }),
        sharedMetadata,
        ownerMetadata,
        agentState: fullAgentState,
      },
    });
    expect(JSON.stringify(hydrated.metadata)).not.toContain('/private/worktree');
  });

  it.each(['view', 'edit', 'admin'] as const)(
    'hydrates a layout-v1 %s recipient without inferring owner metadata or full Agent state',
    async (accessLevel) => {
    const sharedMetadata = projectSessionSharedMetadataV1({
      metadata: {
        summary: { text: 'Shared title', updatedAt: 10 },
      },
    });
    const decryptAgentState = vi.fn(async () => {
      throw new Error('shared recipients must not request full Agent state');
    });
    const fetchAccountCurrentness = vi.fn(async () => {
      throw new Error('shared recipients must not request Account currentness');
    });
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v1/sessions/s_shared/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({
        session: {
          id: 's_shared',
          createdAt: 1,
          updatedAt: 2,
          seq: 3,
          active: true,
          activeAt: 2,
          encryptionMode: 'e2ee',
          dataEncryptionKey: 'dek',
          metadataLayoutVersion: 1,
          metadataVersion: 4,
          metadata: 'encrypted-shared-metadata',
          agentStateVersion: 7,
          agentState: null,
          share: {
            accessLevel,
            canApprovePermissions: false,
          },
        },
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_shared',
      credentials: OWNER_TEST_CREDENTIALS as never,
      encryption: {
        decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({
          decryptMetadata: async () => null,
          decryptMetadataPayload: async () => sharedMetadata,
          decryptAgentState,
        }),
      },
      sessionDataKeys: new Map(),
      fetchAccountCurrentness,
      request,
      applySessions,
      log: { log: () => {} },
      includeMetadataTupleMutationSnapshot: true,
    });

    expect(result.ok).toBe(true);
    expect(fetchAccountCurrentness).not.toHaveBeenCalled();
    expect(decryptAgentState).not.toHaveBeenCalled();
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_shared',
        metadata: sharedMetadata,
        ownerMetadataView: null,
        agentState: null,
        agentStateVersion: 7,
      }),
    ]);
    expect(result.metadataTupleMutationSnapshot).toEqual({
      mode: 'shared_editor',
      metadataLayoutVersion: 1,
      metadataVersion: 4,
      sharedMetadataCiphertext: 'encrypted-shared-metadata',
      value: {
        metadata: sharedMetadata,
        sharedMetadata,
        ownerMetadata: null,
        agentState: null,
      },
    });
    },
  );

  it('fails closed when an encrypted owner envelope is present without real account material', async () => {
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata: {} });
    const applySessions = vi.fn();
    const decryptAgentState = vi.fn(async () => ({ controlledByUser: true }));
    const result = await fetchAndApplySessionById({
      sessionId: 's_encrypted_owner_without_material',
      credentials: { token: 'token-only' },
      encryption: {
        decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({
          decryptMetadata: async () => null,
          decryptMetadataPayload: async () => sharedMetadata,
          decryptAgentState,
        }),
      },
      sessionDataKeys: new Map(),
      request: vi.fn(async () => new Response(JSON.stringify({
        session: {
          id: 's_encrypted_owner_without_material',
          createdAt: 1,
          updatedAt: 2,
          seq: 3,
          active: true,
          activeAt: 2,
          encryptionMode: 'e2ee',
          dataEncryptionKey: 'dek',
          metadataLayoutVersion: 1,
          metadataVersion: 4,
          metadata: 'encrypted-shared-metadata',
          ownerMetadata: OWNER_METADATA_ENVELOPE,
          agentStateVersion: 7,
          agentState: 'encrypted-agent-state',
          share: null,
        },
      }), { status: 200 })),
      applySessions,
      log: { log: () => {} },
    });

    expect(result).toEqual({
      ok: false,
      session: null,
      errorCode: 'owner_metadata_unavailable',
    });
    expect(decryptAgentState).not.toHaveBeenCalled();
    expect(applySessions).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'keeps a linked External Session on the legacy owner while activation is frozen',
      expectedMode: 'legacy_owner' as const,
      metadata: {
        summary: { text: 'Legacy owner', updatedAt: 10 },
        externalSessionV1: {
          v: 1 as const,
          agentId: 'codex',
          machineId: 'machine-private-layout0',
          remoteSessionId: 'native-private-layout0',
          source: { kind: 'codexHome' as const, home: 'user' as const },
        },
      },
    },
    {
      name: 'keeps an ordinary Session on the legacy owner',
      expectedMode: 'legacy_owner' as const,
      metadata: {
        path: '/legacy',
        host: 'owner',
        summary: { text: 'Legacy owner', updatedAt: 10 },
      },
    },
  ])('$name from the exact E2EE layout-0 tuple', async ({
    expectedMode,
    metadata,
  }) => {
    const fullAgentState = {
      controlledByUser: true,
      privateAgentSentinel: 'agent-private-layout0',
    };
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_layout0_owner',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'dek',
        metadataLayoutVersion: 0,
        metadataVersion: 4,
        metadata: 'metadata-exact-layout0',
        agentStateVersion: 7,
        agentState: 'agent-exact-layout0',
        share: null,
      },
    }), { status: 200 }));

    const result = await fetchAndApplySessionById({
      sessionId: 's_layout0_owner',
      credentials: OWNER_TEST_CREDENTIALS as never,
      encryption: {
        decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({
          encryptRaw: async (payload) => JSON.stringify(payload),
          decryptMetadata: async () => metadata,
          decryptAgentState: async () => fullAgentState,
        }),
      },
      sessionDataKeys: new Map(),
      request,
      applySessions,
      log: { log: () => {} },
      includeTurnsProjection: false,
      includeMetadataTupleMutationSnapshot: true,
    });

    expect(result.ok).toBe(true);
    expect(result.metadataTupleMutationSnapshot).toEqual({
      mode: expectedMode,
      metadataLayoutVersion: 0,
      metadataVersion: 4,
      metadataCiphertext: 'metadata-exact-layout0',
      ownerMetadata: null,
      agentStateVersion: 7,
      agentStateCiphertext: 'agent-exact-layout0',
      value: {
        metadata: expect.objectContaining(metadata),
        agentState: fullAgentState,
      },
    });
    expect(JSON.stringify(result.session)).not.toContain(
      'metadata-exact-layout0',
    );
    expect(JSON.stringify(result.session)).not.toContain(
      'agent-exact-layout0',
    );
  });

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
      credentials: { token: 't' },
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
      credentials: { token: 't' },
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

  it('does not claim not_found when a current-text session-by-id 404 carries route metadata', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_current_text_extra_404') {
        return new Response(JSON.stringify({
          error: 'Session not found',
          path: '/v2/sessions/s_current_text_extra_404',
          method: 'GET',
        }), { status: 404 });
      }
      expect(path).toBe('/v2/sessions?limit=200');
      return new Response(JSON.stringify({
        sessions: [],
        nextCursor: null,
        hasNext: false,
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_current_text_extra_404',
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
      errorCode: 'invalid_response',
    });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/v2/sessions/s_current_text_extra_404',
      '/v2/sessions?limit=200',
    ]);
  });

  it.each([
    ['an empty body', () => new Response(null, { status: 404 })],
    ['a plain-text body', () => new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    })],
  ])('does not claim not_found for session-by-id 404 with %s', async (_label, createResponse) => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => createResponse());

    const result = await fetchAndApplySessionById({
      sessionId: 's_invalid_404',
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
      errorCode: 'invalid_response',
      httpStatus: 404,
    });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preserves compatibility fallback without claiming not_found when a missing v2 route has no matching list row', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_legacy_absent') {
        return new Response(JSON.stringify({
          error: 'Not found',
          path: '/v2/sessions/s_legacy_absent',
          method: 'GET',
        }), { status: 404 });
      }
      expect(path).toBe('/v2/sessions?limit=200');
      return new Response(JSON.stringify({
        sessions: [],
        nextCursor: null,
        hasNext: false,
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_legacy_absent',
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
      errorCode: 'invalid_response',
      httpStatus: 404,
    });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/v2/sessions/s_legacy_absent',
      '/v2/sessions?limit=200',
    ]);
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
    const externalSessionOperationPresentationV1 =
      ExternalSessionOperationSharedPresentationV1Schema.parse({
        v: 1,
        operationId: 'operation-public-safe-1',
        revision: 4,
        kind: 'materialize',
        status: 'running',
        phase: 'validating',
      });
    const decryptMetadataPayload = vi.fn(async () =>
      projectSessionSharedMetadataV1({
        metadata: { externalSessionOperationPresentationV1 },
      }));
    const decryptMetadata = vi.fn(async () => {
      throw new Error('layout-v1 metadata must bypass the legacy parser');
    });
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
        metadataLayoutVersion: 1,
        metadataVersion: 1,
        metadata: 'enc-meta',
        ownerMetadata: OWNER_METADATA_ENVELOPE,
        agentStateVersion: 1,
        agentState: 'enc-state',
        share: null,
      },
    }), { status: 200 }));

    const sessionDataKeys = new Map<string, Uint8Array>();

    await fetchAndApplySessionById({
      sessionId: 's1',
      credentials: OWNER_TEST_CREDENTIALS as any,
      encryption: {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption: () => ({
          decryptMetadata,
          decryptMetadataPayload,
          decryptAgentState,
        } as any),
      },
      sessionDataKeys,
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(decryptEncryptionKey).toHaveBeenCalledWith('dek');
    expect(initializeSessions).toHaveBeenCalledWith(
      new Map([['s1', new Uint8Array([1, 2, 3])]]),
      { shouldContinue: expect.any(Function) },
    );
    expect(sessionDataKeys.get('s1')).toEqual(new Uint8Array([1, 2, 3]));
    expect(decryptMetadataPayload).toHaveBeenCalledWith(1, 'enc-meta');
    expect(decryptMetadata).not.toHaveBeenCalled();
    expect(decryptAgentState).toHaveBeenCalledWith(1, 'enc-state');
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's1',
        metadata: expect.objectContaining({
          externalSessionOperationPresentationV1,
        }),
      }),
    ]);
    const hydratedMetadata = JSON.stringify(
      applySessions.mock.calls[0]?.[0]?.[0]?.metadata,
    );
    expect(hydratedMetadata).toContain('operation-public-safe-1');
    expect(hydratedMetadata).not.toContain('operationClaimId');
    expect(hydratedMetadata).not.toContain('canonicalOwnerEvidence');
    expect(hydratedMetadata).not.toContain('privateStagingId');
  });

  it('does not repopulate active account key or session state after authority changes during key initialization', async () => {
    let current = true;
    let releaseInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    const initializeSessions = vi.fn(async () => await initialization);
    const getSessionEncryption = vi.fn(() => null);
    const applySessions = vi.fn();
    const sessionDataKeys = new Map<string, Uint8Array>();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 'stale-account-session',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: false,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'account-a-envelope',
        metadataVersion: 1,
        metadata: 'encrypted-metadata',
        agentStateVersion: 1,
        agentState: 'encrypted-agent-state',
        share: null,
      },
    }), { status: 200 }));

    const hydration = fetchAndApplySessionById({
      sessionId: 'stale-account-session',
      credentials: { token: 'account-a-token', secret: 'account-a-secret' } as any,
      encryption: {
        decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
        initializeSessions,
        getSessionEncryption,
      },
      sessionDataKeys,
      request,
      applySessions,
      isCurrent: () => current,
      log: { log: () => {} },
    });
    await vi.waitFor(() => expect(initializeSessions).toHaveBeenCalledTimes(1));
    current = false;
    releaseInitialization();

    await expect(hydration).resolves.toMatchObject({
      ok: false,
      errorCode: 'stale_response',
    });
    expect(sessionDataKeys.has('stale-account-session')).toBe(false);
    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(applySessions).not.toHaveBeenCalled();
  });

  it('reuses a cached session data key when the encrypted envelope is unchanged', async () => {
    const applySessions = vi.fn();
    const decryptEncryptionKey = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const initializeSessions = vi.fn(async () => {});
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata: {} });
    const decryptMetadataPayload = vi.fn(async () => sharedMetadata);
    const decryptMetadata = vi.fn(async () => {
      throw new Error('layout-v1 metadata must bypass the legacy parser');
    });
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
        metadataLayoutVersion: 1,
        metadataVersion: 1,
        metadata: 'enc-meta',
        ownerMetadata: OWNER_METADATA_ENVELOPE,
        agentStateVersion: 1,
        agentState: 'enc-state',
        share: null,
      },
    }), { status: 200 }));

    const sessionDataKeys = new Map<string, Uint8Array>([['s_cached', cachedKey]]);
    const sessionDataKeyEnvelopes = new Map<string, string>([['s_cached', 'cached-envelope']]);

    await fetchAndApplySessionById({
      sessionId: 's_cached',
      credentials: OWNER_TEST_CREDENTIALS as any,
      encryption: {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption: () => ({
          decryptMetadata,
          decryptMetadataPayload,
          decryptAgentState,
        } as any),
      },
      sessionDataKeys,
      sessionDataKeyEnvelopes,
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(decryptEncryptionKey).not.toHaveBeenCalled();
    expect(initializeSessions).toHaveBeenCalledWith(
      new Map([['s_cached', cachedKey]]),
      { shouldContinue: expect.any(Function) },
    );
    expect(sessionDataKeys.get('s_cached')).toBe(cachedKey);
    expect(sessionDataKeyEnvelopes.get('s_cached')).toBe('cached-envelope');
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_cached',
        metadata: sharedMetadata,
        agentState: { controlledByUser: true },
      }),
    ]);
  });

  it('starts encrypted metadata and agent-state decrypts before awaiting either result', async () => {
    const applySessions = vi.fn();
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata: {} });
    const metadataDeferred = createDeferred<typeof sharedMetadata>();
    const agentStateDeferred = createDeferred<{ controlledByUser: true }>();
    const decryptMetadataPayload = vi.fn(async () => metadataDeferred.promise);
    const decryptMetadata = vi.fn(async () => {
      throw new Error('layout-v1 metadata must bypass the legacy parser');
    });
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
        metadataLayoutVersion: 1,
        metadataVersion: 1,
        metadata: 'enc-meta',
        ownerMetadata: OWNER_METADATA_ENVELOPE,
        agentStateVersion: 1,
        agentState: 'enc-state',
        share: null,
      },
    }), { status: 200 }));

    const fetchPromise = fetchAndApplySessionById({
      sessionId: 's_parallel',
      credentials: OWNER_TEST_CREDENTIALS as any,
      encryption: {
        decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({
          decryptMetadata,
          decryptMetadataPayload,
          decryptAgentState,
        } as any),
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    try {
      await expect.poll(() => ({
        metadata: decryptMetadataPayload.mock.calls.length,
        agentState: decryptAgentState.mock.calls.length,
      }), { timeout: 100 }).toEqual({ metadata: 1, agentState: 1 });
    } finally {
      metadataDeferred.resolve(sharedMetadata);
      agentStateDeferred.resolve({ controlledByUser: true });
      await fetchPromise;
    }

    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_parallel',
        metadata: sharedMetadata,
        agentState: { controlledByUser: true },
      }),
    ]);
    expect(decryptMetadata).not.toHaveBeenCalled();
  });

  it('does not let deferred owner tuple decryption overwrite a newer applied tuple', async () => {
    onAgentRequest.mockClear();
    const staleSharedMetadata = projectSessionSharedMetadataV1({
      metadata: {
        summary: { text: 'Stale', updatedAt: 1 },
      },
    });
    const newerSharedMetadata = projectSessionSharedMetadataV1({
      metadata: {
        summary: { text: 'Newer', updatedAt: 2 },
      },
    });
    const metadataDeferred =
      createDeferred<typeof staleSharedMetadata>();
    const decryptMetadataPayload = vi.fn(
      async () => metadataDeferred.promise,
    );
    const decryptAgentState = vi.fn(async () => ({
      requests: {
        staleRequest: {
          tool: 'stale-tool',
          arguments: {},
          createdAt: 1,
        },
      },
    }));
    const applySessions = vi.fn();
    let currentSession: Session | null = null;
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_stale_decrypt',
        createdAt: 1,
        updatedAt: 1,
        seq: 1,
        active: true,
        activeAt: 1,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'dek',
        metadataLayoutVersion: 1,
        metadataVersion: 1,
        metadata: 'enc-stale-metadata',
        ownerMetadata: OWNER_METADATA_ENVELOPE,
        agentStateVersion: 1,
        agentState: 'enc-stale-agent-state',
        share: null,
      },
    }), { status: 200 }));

    const fetchPromise = fetchAndApplySessionById({
      sessionId: 's_stale_decrypt',
      credentials: OWNER_TEST_CREDENTIALS as never,
      encryption: {
        decryptEncryptionKey: async () =>
          new Uint8Array([1, 2, 3]),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({
          decryptMetadata: async () => null,
          decryptMetadataPayload,
          decryptAgentState,
        }),
      },
      sessionDataKeys: new Map(),
      request,
      applySessions,
      getExistingSession: () => currentSession,
      log: { log: () => {} },
      includeTurnsProjection: false,
      includeMetadataTupleMutationSnapshot: true,
    });

    await expect.poll(
      () => decryptMetadataPayload.mock.calls.length,
      { timeout: 100 },
    ).toBe(1);
    currentSession = {
      id: 's_stale_decrypt',
      createdAt: 1,
      updatedAt: 2,
      seq: 2,
      active: true,
      activeAt: 2,
      encryptionMode: 'e2ee',
      metadataLayoutVersion: 1,
      metadataVersion: 2,
      metadata: newerSharedMetadata as unknown as Session['metadata'],
      ownerMetadataView: {
        path: '/newer/private',
        host: 'newer-host',
        summary: { text: 'Newer', updatedAt: 2 },
      },
      agentStateVersion: 2,
      agentState: {
        requests: {
          newerRequest: {
            tool: 'newer-tool',
            arguments: {},
            createdAt: 2,
          },
        },
      },
      thinking: false,
      thinkingAt: 0,
      presence: 'online',
    };
    metadataDeferred.resolve(staleSharedMetadata);

    await expect(fetchPromise).resolves.toMatchObject({
      ok: false,
      session: null,
      errorCode: 'stale_response',
    });
    expect(applySessions).not.toHaveBeenCalled();
    expect(onAgentRequest).not.toHaveBeenCalled();
    expect(currentSession.metadata).toEqual(newerSharedMetadata);
    expect(currentSession.ownerMetadataView).toMatchObject({
      path: '/newer/private',
    });
    expect(currentSession.agentStateVersion).toBe(2);
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
      requestAuthority: {},
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

  it('does not adopt an old in-flight detail response under a new request authority', async () => {
    const oldDetailGate = createDeferred<void>();
    let oldDetailRequests = 0;
    let newDetailRequests = 0;
    const buildResponse = (path: string) => new Response(JSON.stringify({
      session: {
        id: 's_authority_rotation',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ path }),
        agentStateVersion: 1,
        agentState: null,
        share: null,
      },
    }), { status: 200 });
    const oldRequest = vi.fn(async () => {
      oldDetailRequests += 1;
      await oldDetailGate.promise;
      return buildResponse('/old-authority');
    });
    const newRequest = vi.fn(async () => {
      newDetailRequests += 1;
      return buildResponse('/new-authority');
    });
    const encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      getSessionEncryption: () => null,
    } satisfies SessionByIdEncryption;
    const baseParams = {
      sessionId: 's_authority_rotation',
      serverId: 'server-a',
      credentials: { token: 't' },
      encryption,
      sessionDataKeys: new Map<string, Uint8Array>(),
      log: { log: () => {} },
      includeTurnsProjection: false,
    };
    const oldApplySessions = vi.fn();
    const newApplySessions = vi.fn();
    const oldRead = fetchAndApplySessionById({
      ...baseParams,
      request: oldRequest,
      requestAuthority: {},
      applySessions: oldApplySessions,
    });
    await expect.poll(() => oldDetailRequests).toBe(1);
    const newRead = fetchAndApplySessionById({
      ...baseParams,
      request: newRequest,
      requestAuthority: {},
      applySessions: newApplySessions,
    });
    await Promise.resolve();
    oldDetailGate.resolve();
    await Promise.all([oldRead, newRead]);

    expect(newDetailRequests).toBe(1);
    expect(newApplySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        metadata: expect.objectContaining({ path: '/new-authority' }),
      }),
    ]);
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
