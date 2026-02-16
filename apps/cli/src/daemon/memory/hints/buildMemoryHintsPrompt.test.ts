import { describe, expect, it } from 'vitest';

describe('buildMemoryHintsPrompt', () => {
  it('includes transcript window messages and strict JSON contract', async () => {
    const { buildMemoryHintsPrompt } = await import('./buildMemoryHintsPrompt');
    const prompt = buildMemoryHintsPrompt({
      sessionId: 'sess-1',
      seqFrom: 1,
      seqTo: 2,
      previousSynopsis: 'Earlier we discussed indexing.',
      messages: [
        { seq: 1, role: 'user', text: 'Do you remember OpenClaw?' },
        { seq: 2, role: 'assistant', text: 'Yes, we discussed memory indexing.' },
      ],
      budgets: {
        maxSummaryChars: 500,
        maxKeywords: 5,
        maxEntities: 3,
        maxDecisions: 2,
      },
    });

    expect(prompt).toContain('Return ONLY valid JSON');
    expect(prompt).toContain('sess-1');
    expect(prompt).toContain('seqFrom');
    expect(prompt).toContain('previousSynopsis');
    expect(prompt).toContain('Do you remember OpenClaw?');
  });
});

