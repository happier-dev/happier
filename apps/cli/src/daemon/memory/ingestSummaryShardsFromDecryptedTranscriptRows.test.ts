import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openSummaryShardIndexDb } from './summaryShardIndexDb';
import { ingestSummaryShardsFromDecryptedTranscriptRows } from './ingestSummaryShardsFromDecryptedTranscriptRows';

describe('ingestSummaryShardsFromDecryptedTranscriptRows', () => {
  it('advances the hinted cursor when ingesting a shard artifact', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-ingest-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openSummaryShardIndexDb({ dbPath });
      db.init();

      ingestSummaryShardsFromDecryptedTranscriptRows({
        sessionId: 'sess-1',
        tier1: db,
        rows: [
          {
            seq: 99,
            createdAtMs: 1234,
            role: 'agent' as const,
            content: { type: 'text', text: '[memory]' },
            meta: {
              happier: {
                kind: 'session_summary_shard.v1',
                payload: {
                  v: 1,
                  seqFrom: 10,
                  seqTo: 12,
                  createdAtFromMs: 1000,
                  createdAtToMs: 2000,
                  summary: 'Openclaw',
                  keywords: ['openclaw'],
                  entities: [],
                  decisions: [],
                },
              },
            },
          } as any,
        ],
      });

      const cursors = db.getSessionCursors({ sessionId: 'sess-1', nowMs: 2000 });
      expect(cursors.lastHintedSeq).toBe(12);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

