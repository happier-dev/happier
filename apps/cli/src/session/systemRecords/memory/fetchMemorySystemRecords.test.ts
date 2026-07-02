import { describe, expect, it } from 'vitest';

describe('fetchMemorySystemRecords', () => {
  it('reads summary shard pages through session system records and opens payloads', async () => {
    const { fetchMemorySummaryShardSystemRecords } = await import('./fetchMemorySystemRecords');

    const payload = {
      v: 1,
      seqFrom: 10,
      seqTo: 12,
      createdAtFromMs: 1000,
      createdAtToMs: 2000,
      summary: 'OpenClaw memory search was discussed.',
      keywords: ['openclaw'],
      entities: [],
      decisions: [],
    };

    const pagesRequested: Array<{ cursor?: string }> = [];
    const out = await fetchMemorySummaryShardSystemRecords({
      token: 'token-1',
      sessionId: 'sess-1',
      mode: 'plain',
      fetchSessionSystemRecordsPage: async (args) => {
        pagesRequested.push({ cursor: args.cursor });
        return pagesRequested.length === 1
          ? {
              records: [{
                id: 'rec-1',
                sessionId: 'sess-1',
                namespace: 'memory',
                kind: 'summary_shard.v1',
                localId: 'memory:summary_shard:v1:10-12',
                content: { t: 'plain', v: payload },
                createdAt: '2026-05-19T00:00:00.000Z',
                updatedAt: '2026-05-19T00:00:00.000Z',
              }],
              nextCursor: 'cursor-2',
              hasNext: true,
            }
          : {
              records: [],
              nextCursor: null,
              hasNext: false,
            };
      },
    });

    expect(out).toEqual([payload]);
    expect(pagesRequested).toEqual([{ cursor: undefined }, { cursor: 'cursor-2' }]);
  });

  it('reads the latest synopsis through session system records', async () => {
    const { fetchLatestMemorySynopsisSystemRecord } = await import('./fetchMemorySystemRecords');

    await expect(fetchLatestMemorySynopsisSystemRecord({
      token: 'token-1',
      sessionId: 'sess-1',
      mode: 'plain',
      fetchLatestSessionSystemRecord: async () => ({
        id: 'rec-1',
        sessionId: 'sess-1',
        namespace: 'memory',
        kind: 'synopsis.v1',
        localId: 'memory:synopsis:v1:9',
        content: {
          t: 'plain',
          v: { v: 1, seqTo: 9, updatedAtMs: 99, synopsis: 'Latest memory synopsis.' },
        },
        createdAt: '2026-05-19T00:00:00.000Z',
        updatedAt: '2026-05-19T00:00:00.000Z',
      }),
    })).resolves.toMatchObject({
      v: 1,
      seqTo: 9,
      synopsis: 'Latest memory synopsis.',
    });
  });
});
