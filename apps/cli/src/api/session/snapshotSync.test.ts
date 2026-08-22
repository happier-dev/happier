import { describe, expect, it, vi } from 'vitest';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import type { Credentials, StoredCredentials } from '@/persistence';

vi.mock('@/configuration', () => ({
    configuration: { serverUrl: 'http://example.invalid', apiServerUrl: 'http://example.invalid' },
}));

import axios from 'axios';
import {
    fetchSessionSnapshotUpdateFromServer as fetchSessionSnapshotUpdateFromServerOwner,
} from './snapshotSync';
import { encodeBase64, encrypt } from '../encryption';

const ownerSecret = new Uint8Array(32).fill(7);
const ownerCredentials: Credentials = {
  token: 't',
  encryption: {
    type: 'legacy',
    secret: ownerSecret,
  },
};

const e2eeCurrentness = {
  mode: 'e2ee' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: 'content-fingerprint',
  updatedAt: 1,
};
const plainCurrentness = {
  mode: 'plain' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
};

type SnapshotUpdateParams = Parameters<
  typeof fetchSessionSnapshotUpdateFromServerOwner
>[0];
type SnapshotUpdateTestParams<T> = T extends SnapshotUpdateParams
  ? Omit<T, 'accountEncryptionCurrentness'> &
      Partial<Pick<T, 'accountEncryptionCurrentness'>>
  : never;

function fetchSessionSnapshotUpdateFromServer(
  params: SnapshotUpdateTestParams<SnapshotUpdateParams>,
) {
  return fetchSessionSnapshotUpdateFromServerOwner({
    ...params,
    accountEncryptionCurrentness:
      params.accountEncryptionCurrentness ?? e2eeCurrentness,
  });
}

describe('snapshotSync.fetchSessionSnapshotUpdateFromServer', () => {
    it('preserves unexpected non-auth HTTP statuses as HttpStatusError carriers', async () => {
        const getSpy = vi.spyOn(axios, 'get');
        getSpy.mockResolvedValueOnce({
            status: 503,
            data: { error: 'server busy' },
        } as any);

        await expect(fetchSessionSnapshotUpdateFromServer({
            token: 't',
            sessionId: 's1',
            mode: 'e2ee',

            ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
            currentMetadataVersion: 0,
            currentAgentStateVersion: 0,
        })).rejects.toMatchObject({
            name: 'HttpStatusError',
            response: { status: 503 },
        });
    });

    it('parses plaintext metadata/agentState when session encryptionMode is plain', async () => {
        const getSpy = vi.spyOn(axios, 'get');
        getSpy.mockResolvedValueOnce({
            status: 200,
            data: {
                session: createSessionRecordFixture({
                    id: 's1',
                    encryptionMode: 'plain' as any,
                    metadataVersion: 2,
                    metadata: JSON.stringify({ path: '/tmp', host: 'localhost' }),
                    agentStateVersion: 1,
                    agentState: JSON.stringify({ controlledByUser: false }),
                }),
            },
        } as any);

        const res = await fetchSessionSnapshotUpdateFromServer({
            token: 't',
            sessionId: 's1',
            mode: 'e2ee',

            ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
            currentMetadataVersion: 1,
            currentAgentStateVersion: 0,
        });

        expect(res.metadata).toEqual({
            metadata: { path: '/tmp', host: 'localhost' },
            metadataVersion: 2,
        });
    expect(res.agentState).toEqual({
      agentState: { controlledByUser: false },
      agentStateVersion: 1,
    });
  });

  it('does not throw when plaintext metadata/agentState are invalid JSON', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 's1',
          encryptionMode: 'plain' as any,
          metadataVersion: 2,
          metadata: '{ not json',
          agentStateVersion: 1,
          agentState: '{ not json',
        }),
      },
    } as any);

    const res = await fetchSessionSnapshotUpdateFromServer({
      token: 't',
      sessionId: 's1',
      mode: 'e2ee',

      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
      currentMetadataVersion: 1,
      currentAgentStateVersion: 0,
    });

    expect(res.metadata).toBeUndefined();
    expect(res.agentState).toBeUndefined();
    expect(res.pendingQueueState).toEqual({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 });
  });

  it('atomically reprojects the exact owner tuple when a remote layout-v1 write arrives', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    const authoritativeMetadata = {
      path: '/private/remote-owner',
      host: 'private-host',
      flavor: 'claude',
      summary: { text: 'Safe title', updatedAt: 10 },
    };
    const authoritativeAgentState = {
      requests: {
        privateRequest: {
          tool: 'private-tool',
          arguments: { value: 'private-tool-arguments' },
          createdAt: 1,
        },
      },
    };
    const tuple = buildSessionMetadataEnvelopeFields({
      credentials: ownerCredentials,
      accountEncryptionMode: 'e2ee',
      metadata: authoritativeMetadata,
      agentState: authoritativeAgentState,
      storedContentMode: 'e2ee',
      encryptionKey: ownerSecret,
      encryptionVariant: 'legacy',
    });
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 's-layout-contract',
          encryptionMode: 'e2ee',
          metadataLayoutVersion: 1,
          metadataVersion: 1,
          metadata: tuple.sharedMetadata.ciphertext,
          ownerMetadata: tuple.ownerMetadata,
          agentStateVersion: 1,
          agentState: tuple.agentState,
        }),
      },
    });

    const res = await fetchSessionSnapshotUpdateFromServer({
      token: 't',
      sessionId: 's-layout-contract',
      credentials: ownerCredentials,
      mode: 'e2ee',

      ctx: { encryptionKey: ownerSecret, encryptionVariant: 'legacy' },
      currentMetadataLayoutVersion: 0,
      currentMetadataVersion: 9,
      currentAgentStateVersion: 8,
      currentMetadata: {
        path: '/private/worktree',
        host: 'private-host',
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'private-machine',
          remoteSessionId: 'private-native-id',
          source: { kind: 'codexHome', home: 'local' },
          linkedAtMs: 1,
        },
      } as any,
      currentAgentState: {
        requests: {
          privateRequest: {
            tool: 'private-tool',
            arguments: { value: 'private-tool-arguments' },
            createdAt: 1,
          },
        },
      },
    });

    expect(res).toMatchObject({
      metadataLayoutVersion: 1,
      metadataTuple: {
        metadataVersion: 1,
        ownerMetadataEnvelope: tuple.ownerMetadata,
        agentStateVersion: 1,
        value: {
          metadata: authoritativeMetadata,
          agentState: authoritativeAgentState,
        },
      },
    });
    expect(res).not.toHaveProperty('metadata');
    expect(res).not.toHaveProperty('agentState');
  });

  it('opens a plaintext layout-v1 owner tuple with token-only credentials', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    const tokenOnlyCredentials = {
      token: 'plain-token',
      encryption: null,
    } satisfies StoredCredentials;
    const authoritativeMetadata = {
      path: '/private/plain-owner',
      host: 'plain-host',
      flavor: 'codex',
      summary: { text: 'Safe plaintext title', updatedAt: 10 },
    };
    const authoritativeAgentState = { controlledByUser: false };
    const tuple = buildSessionMetadataEnvelopeFields({
      credentials: tokenOnlyCredentials,
      accountEncryptionMode: 'plain',
      metadata: authoritativeMetadata,
      agentState: authoritativeAgentState,
      storedContentMode: 'plain',
    });
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 's-layout-plain-token-only',
          encryptionMode: 'plain',
          metadataLayoutVersion: 1,
          metadataVersion: 1,
          metadata: tuple.sharedMetadata.ciphertext,
          ownerMetadata: tuple.ownerMetadata,
          agentStateVersion: 1,
          agentState: tuple.agentState,
        }),
      },
    });

    const res = await fetchSessionSnapshotUpdateFromServer({
      token: tokenOnlyCredentials.token,
      sessionId: 's-layout-plain-token-only',
      credentials: tokenOnlyCredentials,
      accountEncryptionCurrentness: plainCurrentness,
      mode: 'plain',
      ctx: null,
      currentMetadataLayoutVersion: 0,
      currentMetadataVersion: 0,
      currentAgentStateVersion: 0,
    });

    expect(res).toMatchObject({
      metadataLayoutVersion: 1,
      metadataTuple: {
        metadataVersion: 1,
        ownerMetadataEnvelope: tuple.ownerMetadata,
        agentStateVersion: 1,
        value: {
          metadata: authoritativeMetadata,
          agentState: authoritativeAgentState,
        },
      },
    });
  });

  it('strictly rejects private fields in layout-v1 shared metadata instead of partially hydrating the owner tuple', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    const ownerTuple = buildSessionMetadataEnvelopeFields({
      credentials: ownerCredentials,
      accountEncryptionMode: 'e2ee',
      metadata: createTestMetadata({ path: '/owner-path' }),
      agentState: { controlledByUser: false },
      storedContentMode: 'plain',
    });
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 's-layout-strict',
          encryptionMode: 'plain',
          metadataLayoutVersion: 1,
          metadataVersion: 1,
          metadata: JSON.stringify({
            v: 1,
            summary: { text: 'Safe title', updatedAt: 10 },
            path: '/must-not-cross-the-shared-envelope',
          }),
          ownerMetadata: ownerTuple.ownerMetadata,
          agentStateVersion: 1,
          agentState: JSON.stringify({ controlledByUser: false }),
        }),
      },
    });

    await expect(fetchSessionSnapshotUpdateFromServer({
      token: 't',
      sessionId: 's-layout-strict',
      credentials: ownerCredentials,
      mode: 'e2ee',

      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
      currentMetadataLayoutVersion: 0,
      currentMetadataVersion: 9,
      currentAgentStateVersion: 8,
      currentMetadata: createTestMetadata({ path: '/cached-private-path' }),
      currentAgentState: { controlledByUser: true },
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });
  });

  it('fails closed for unsupported future metadata layouts', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 's-layout-future',
          encryptionMode: 'plain',
          metadataLayoutVersion: 2,
          metadataVersion: 100,
          metadata: JSON.stringify({ path: '/future-private-shape' }),
          agentStateVersion: 100,
          agentState: JSON.stringify({ requests: { private: { tool: 'secret' } } }),
        }),
      },
    });

    await expect(fetchSessionSnapshotUpdateFromServer({
      token: 't',
      sessionId: 's-layout-future',
      mode: 'e2ee',

      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
      currentMetadataLayoutVersion: 1,
      currentMetadataVersion: 1,
      currentAgentStateVersion: 1,
      currentMetadata: createTestMetadata(),
      currentAgentState: null,
    })).rejects.toThrow('Unexpected /v2/sessions response shape');
  });

  it('does not let a higher legacy version downgrade an established layout-v1 snapshot', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 's-layout-downgrade',
          encryptionMode: 'plain',
          metadataLayoutVersion: 0,
          metadataVersion: 100,
          metadata: JSON.stringify({ path: '/stale-legacy-private-path' }),
          agentStateVersion: 100,
          agentState: JSON.stringify({ controlledByUser: true }),
        }),
      },
    });

    const res = await fetchSessionSnapshotUpdateFromServer({
      token: 't',
      sessionId: 's-layout-downgrade',
      mode: 'e2ee',

      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
      currentMetadataLayoutVersion: 1,
      currentMetadataVersion: 1,
      currentAgentStateVersion: 1,
      currentMetadata: createTestMetadata({ path: '' }),
      currentAgentState: null,
    });

    expect(res).not.toHaveProperty('metadataLayoutVersion');
    expect(res).not.toHaveProperty('metadata');
    expect(res).not.toHaveProperty('agentState');
    expect(JSON.stringify(res)).not.toContain('stale-legacy-private-path');
  });

  it('returns pending queue state from the authoritative session snapshot', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 's1',
          pendingCount: 0,
          pendingVersion: 9,
        }),
      },
    } as any);

    const res = await fetchSessionSnapshotUpdateFromServer({
      token: 't',
      sessionId: 's1',
      mode: 'e2ee',

      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
      currentMetadataVersion: 999,
      currentAgentStateVersion: 999,
    });

    expect(res.pendingQueueState).toEqual({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 9 });
  });

  it('returns the authoritative turn status observation time with the status', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 's1',
          latestTurnStatus: 'completed',
          latestTurnStatusObservedAt: 1234,
        }),
      },
    } as any);

    const res = await fetchSessionSnapshotUpdateFromServer({
      token: 't',
      sessionId: 's1',
      mode: 'e2ee',

      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
      currentMetadataVersion: 999,
      currentAgentStateVersion: 999,
    });

    expect(res).toMatchObject({
      latestTurnStatus: 'completed',
      latestTurnStatusObservedAt: 1234,
    });
  });

  it('coalesces concurrent reads of the same raw session snapshot', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    const serverMetadata = createTestMetadata({ path: '/tmp/server', host: 'localhost' });
    let resolveResponse!: (value: unknown) => void;
    const pendingResponse = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    getSpy.mockReturnValue(pendingResponse as ReturnType<typeof axios.get>);

    const first = fetchSessionSnapshotUpdateFromServer({
      token: 't',
      sessionId: 's1',
      mode: 'e2ee',

      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
      currentMetadataVersion: 1,
      currentAgentStateVersion: 0,
    });
    const second = fetchSessionSnapshotUpdateFromServer({
      token: 't',
      sessionId: 's1',
      mode: 'e2ee',

      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
      currentMetadataVersion: 2,
      currentAgentStateVersion: 0,
      currentMetadata: serverMetadata,
      currentAgentState: null,
    });

    expect(getSpy).toHaveBeenCalledTimes(1);

    resolveResponse({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 's1',
          encryptionMode: 'plain' as any,
          metadataVersion: 2,
          metadata: JSON.stringify(serverMetadata),
          agentStateVersion: 0,
          agentState: null,
        }),
      },
    });

    await expect(first).resolves.toMatchObject({
      metadata: { metadata: serverMetadata, metadataVersion: 2 },
    });
    await expect(second).resolves.not.toHaveProperty('metadata');
  });

  it('falls back to scanning /v2/sessions when the single-session route is missing (404 Not found)', async () => {
    const getSpy = vi.spyOn(axios, 'get');
        getSpy
            .mockResolvedValueOnce({
                status: 404,
                data: { error: 'Not found', path: '/v2/sessions/s1', method: 'GET' },
            } as any)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    sessions: [createSessionRecordFixture({ id: 's1', metadataVersion: 0, agentStateVersion: 0 })],
                    hasNext: false,
                    nextCursor: null,
                },
            } as any);

        const res = await fetchSessionSnapshotUpdateFromServer({
            token: 't',
            sessionId: 's1',
            mode: 'e2ee',

            ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
            currentMetadataVersion: 999,
            currentAgentStateVersion: 999,
        });

        expect(res.metadata).toBeUndefined();
        expect(res.agentState).toBeUndefined();
        expect(res.pendingQueueState).toEqual({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 });
        expect(getSpy).toHaveBeenCalledTimes(2);
        expect(String(getSpy.mock.calls[0]?.[0])).toContain('/v2/sessions/s1');
        expect(String(getSpy.mock.calls[1]?.[0])).toContain('/v2/sessions');
    });

    it('does not scan /v2/sessions when the session is missing (404 Session not found)', async () => {
        const getSpy = vi.spyOn(axios, 'get');
        getSpy.mockResolvedValueOnce({
            status: 404,
            data: { error: 'Session not found' },
        } as any);

        const res = await fetchSessionSnapshotUpdateFromServer({
            token: 't',
            sessionId: 's1',
            mode: 'e2ee',

            ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
            currentMetadataVersion: 999,
            currentAgentStateVersion: 999,
        });

    expect(res).toEqual({});
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(String(getSpy.mock.calls[0]?.[0])).toContain('/v2/sessions/s1');
  });

  it('repairs same-version metadata divergence from the authoritative server snapshot', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    const encryptionKey = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
    const serverMetadata = { path: '/tmp/server', host: 'localhost', acpSessionModeOverrideV1: { v: 1, updatedAt: 2000, modeId: 'plan' } };
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 's1',
          metadataVersion: 4,
          metadata: encodeBase64(encrypt(encryptionKey, 'legacy', serverMetadata)),
          agentStateVersion: 0,
          agentState: null,
        }),
      },
    } as any);

    const res = await fetchSessionSnapshotUpdateFromServer({
      token: 't',
      sessionId: 's1',
      mode: 'e2ee',
      ctx: { encryptionKey, encryptionVariant: 'legacy' },
      currentMetadataVersion: 4,
      currentAgentStateVersion: 0,
      currentMetadata: { path: '/tmp/local', host: 'localhost' } as any,
      currentAgentState: null,
    });

    expect(res.metadata).toEqual({
      metadata: serverMetadata,
      metadataVersion: 4,
    });
  });
});
