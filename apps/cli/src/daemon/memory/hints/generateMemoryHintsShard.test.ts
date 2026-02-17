import { describe, expect, it } from 'vitest';

import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';

describe('generateMemoryHintsShard', () => {
  it('generates a validated summary shard from recent transcript rows', async () => {
    const { generateMemoryHintsShard } = await import('./generateMemoryHintsShard');

    const rows: DecryptedTranscriptRow[] = [
      { seq: 1, createdAtMs: 1000, role: 'user', content: { type: 'text', text: 'Do you remember OpenClaw?' } },
      { seq: 2, createdAtMs: 2000, role: 'agent', content: { type: 'text', text: 'Yes, memory search hints.' } },
    ];

    const out = await generateMemoryHintsShard({
      sessionId: 'sess-1',
      rows,
      previousSynopsis: null,
      hintSettings: {
        maxSummaryChars: 500,
        maxKeywords: 5,
        maxEntities: 5,
        maxDecisions: 5,
      },
      budgets: {
        maxShardChars: 12_000,
        windowSizeMessages: 40,
      },
      run: async () =>
        JSON.stringify({
          shard: {
            v: 1,
            seqFrom: 1,
            seqTo: 2,
            createdAtFromMs: 1000,
            createdAtToMs: 2000,
            summary: 'Discussed OpenClaw memory hints.',
            keywords: ['openclaw'],
            entities: [],
            decisions: [],
          },
          synopsis: null,
        }),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.shard.sessionId).toBe('sess-1');
    expect(out.shard.payload.seqFrom).toBe(1);
    expect(out.shard.payload.summary).toContain('OpenClaw');
  });

  it('enforces maxShardChars by truncating the input message texts passed to the model', async () => {
    const { generateMemoryHintsShard } = await import('./generateMemoryHintsShard');

    const longText = 'x'.repeat(600);
    const rows: DecryptedTranscriptRow[] = [
      { seq: 1, createdAtMs: 1000, role: 'user', content: { type: 'text', text: longText } },
      { seq: 2, createdAtMs: 2000, role: 'agent', content: { type: 'text', text: longText } },
    ];

    const out = await generateMemoryHintsShard({
      sessionId: 'sess-1',
      rows,
      previousSynopsis: null,
      hintSettings: {
        maxSummaryChars: 500,
        maxKeywords: 5,
        maxEntities: 5,
        maxDecisions: 5,
      },
      budgets: {
        maxShardChars: 500,
        windowSizeMessages: 40,
      },
      run: async (prompt) => {
        const marker = 'Input window JSON:\n';
        const idx = prompt.indexOf(marker);
        expect(idx).toBeGreaterThanOrEqual(0);
        const jsonText = prompt.slice(idx + marker.length);
        const window = JSON.parse(jsonText) as any;
        const messages = Array.isArray(window?.messages) ? window.messages : [];
        const totalChars = messages.reduce((sum: number, m: any) => sum + String(m?.text ?? '').length, 0);
        expect(totalChars).toBeLessThanOrEqual(500);

        return JSON.stringify({
          shard: {
            v: 1,
            seqFrom: 1,
            seqTo: 2,
            createdAtFromMs: 1000,
            createdAtToMs: 2000,
            summary: 'Truncated shard.',
            keywords: [],
            entities: [],
            decisions: [],
          },
          synopsis: null,
        });
      },
    });

    expect(out.ok).toBe(true);
  });
});
