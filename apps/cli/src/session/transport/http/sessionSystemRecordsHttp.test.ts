import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('sessionControl.sessionSystemRecordsHttp', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('upserts a system record through the dedicated session system-record route', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { upsertSessionSystemRecord } = await import('./sessionSystemRecordsHttp');

    const putSpy = vi.spyOn(axios, 'put').mockResolvedValueOnce({
      status: 200,
      data: {
        record: {
          id: 'rec-1',
          sessionId: 'sess/1',
          namespace: 'memory',
          kind: 'summary_shard.v1',
          localId: 'memory:summary_shard:v1:1-2',
          content: {
            t: 'plain',
            v: {
              v: 1,
              seqFrom: 1,
              seqTo: 2,
              createdAtFromMs: 1,
              createdAtToMs: 2,
              summary: 'S',
              keywords: [],
              entities: [],
              decisions: [],
            },
          },
          createdAt: '2026-05-19T00:00:00.000Z',
          updatedAt: '2026-05-19T00:00:00.000Z',
        },
      },
    } as never);

    await expect(
      upsertSessionSystemRecord({
        token: 'token-1',
        sessionId: 'sess/1',
        namespace: 'memory',
        kind: 'summary_shard.v1',
        localId: 'memory:summary_shard:v1:1-2',
        content: {
          t: 'plain',
          v: {
            v: 1,
            seqFrom: 1,
            seqTo: 2,
            createdAtFromMs: 1,
            createdAtToMs: 2,
            summary: 'S',
            keywords: [],
            entities: [],
            decisions: [],
          },
        },
      }),
    ).resolves.toMatchObject({
      sessionId: 'sess/1',
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:1-2',
    });

    expect(putSpy).toHaveBeenCalledWith(
      'http://server.example.test/v2/sessions/sess%2F1/system-records',
      expect.objectContaining({
        namespace: 'memory',
        kind: 'summary_shard.v1',
        localId: 'memory:summary_shard:v1:1-2',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'Idempotency-Key': 'memory:summary_shard:v1:1-2',
        }),
      }),
    );
  });

  it('fetches paginated, latest, and single memory system records with query params', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const {
      fetchLatestSessionSystemRecord,
      fetchSessionSystemRecord,
      fetchSessionSystemRecordsPage,
    } = await import('./sessionSystemRecordsHttp');

    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          records: [],
          nextCursor: 'cursor-2',
          hasNext: true,
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          record: {
            id: 'rec-latest',
            sessionId: 'sess-1',
            namespace: 'memory',
            kind: 'synopsis.v1',
            localId: 'memory:synopsis:v1:10',
            content: { t: 'plain', v: { v: 1, seqTo: 10, updatedAtMs: 99, synopsis: 'S' } },
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:01.000Z',
          },
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { record: null },
      } as never);

    await expect(fetchSessionSystemRecordsPage({
      token: 'token-1',
      sessionId: 'sess-1',
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:1-2',
      cursor: 'cursor-1',
      limit: 25,
    })).resolves.toMatchObject({ records: [], nextCursor: 'cursor-2', hasNext: true });

    await expect(fetchLatestSessionSystemRecord({
      token: 'token-1',
      sessionId: 'sess-1',
      namespace: 'memory',
      kind: 'synopsis.v1',
    })).resolves.toMatchObject({ localId: 'memory:synopsis:v1:10' });

    await expect(fetchSessionSystemRecord({
      token: 'token-1',
      sessionId: 'sess-1',
      namespace: 'memory',
      localId: 'memory:synopsis:v1:missing',
    })).resolves.toBeNull();

    expect(getSpy).toHaveBeenNthCalledWith(
      1,
      'http://server.example.test/v2/sessions/sess-1/system-records',
      expect.objectContaining({
        params: {
          namespace: 'memory',
          kind: 'summary_shard.v1',
          localId: 'memory:summary_shard:v1:1-2',
          cursor: 'cursor-1',
          limit: 25,
        },
      }),
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      2,
      'http://server.example.test/v2/sessions/sess-1/system-records/latest',
      expect.objectContaining({
        params: {
          namespace: 'memory',
          kind: 'synopsis.v1',
        },
      }),
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      3,
      'http://server.example.test/v2/sessions/sess-1/system-records/record',
      expect.objectContaining({
        params: {
          namespace: 'memory',
          localId: 'memory:synopsis:v1:missing',
        },
      }),
    );
  });
});
