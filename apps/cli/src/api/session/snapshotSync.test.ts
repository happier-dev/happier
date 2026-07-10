import { describe, expect, it, vi } from 'vitest';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

vi.mock('@/configuration', () => ({
    configuration: { serverUrl: 'http://example.invalid', apiServerUrl: 'http://example.invalid' },
}));

import axios from 'axios';
import { fetchSessionSnapshotUpdateFromServer } from './snapshotSync';
import { encodeBase64, encrypt } from '../encryption';

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
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
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
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
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
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      currentMetadataVersion: 1,
      currentAgentStateVersion: 0,
    });

    expect(res.metadata).toBeUndefined();
    expect(res.agentState).toBeUndefined();
    expect(res.pendingQueueState).toEqual({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 });
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
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
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
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
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
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      currentMetadataVersion: 1,
      currentAgentStateVersion: 0,
    });
    const second = fetchSessionSnapshotUpdateFromServer({
      token: 't',
      sessionId: 's1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
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
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
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
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
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
      encryptionKey,
      encryptionVariant: 'legacy',
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
