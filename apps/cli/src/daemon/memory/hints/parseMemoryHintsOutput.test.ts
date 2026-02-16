import { describe, expect, it } from 'vitest';

describe('parseMemoryHintsOutput', () => {
  it('parses a strict trailing JSON object containing shard and synopsis', async () => {
    const { parseMemoryHintsOutput } = await import('./parseMemoryHintsOutput');
    const result = parseMemoryHintsOutput({
      rawText: [
        'Here you go.',
        '',
        JSON.stringify({
          shard: {
            v: 1,
            seqFrom: 10,
            seqTo: 20,
            createdAtFromMs: 1000,
            createdAtToMs: 2000,
            summary: 'We discussed integrating OpenClaw memory hints.',
            keywords: ['openclaw', 'memory'],
            entities: ['Happier'],
            decisions: ['Use execution runs for hint generation'],
          },
          synopsis: {
            v: 1,
            seqTo: 20,
            updatedAtMs: 2000,
            synopsis: 'Working on memory search hints and indexing.',
          },
        }),
      ].join('\n'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shard.seqFrom).toBe(10);
    expect(result.synopsis?.seqTo).toBe(20);
  });

  it('returns a stable error when no JSON can be parsed', async () => {
    const { parseMemoryHintsOutput } = await import('./parseMemoryHintsOutput');
    const result = parseMemoryHintsOutput({ rawText: 'not json' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('invalid_model_output');
  });
});
