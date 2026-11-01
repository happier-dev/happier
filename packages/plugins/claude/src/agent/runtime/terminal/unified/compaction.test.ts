import { describe, expect, it } from 'vitest';
import { createClaudeUnifiedCompactionProjection } from './compaction.js';

const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: 'native',
  compactMetadata: { trigger: 'auto', preTokens: 220_000, postTokens: 35_000 } };
const summary = { type: 'user', uuid: 'summary', isCompactSummary: true, message: { content: 'summary' } };
const ordinary = { type: 'assistant', uuid: 'next', message: { content: 'Next response' } };
const notice = (content: string) => ({ type: 'system', subtype: 'informational', level: 'notice', uuid: 'notice', content });

describe('Claude unified compaction publication', () => {
  it.each(['Compacted while idle, before the prompt cache expired', 'Compacted using a summary written while you were away'])(
    'holds a native auto boundary across its compact summary until idle meaning is known (%s)', text => {
      const project = createClaudeUnifiedCompactionProjection();
      expect(project.observe(boundary, 'native', 1)).toEqual([]);
      expect(project.observe(summary, 'native', 2)).toEqual([]);
      expect(project.observe(notice(text), 'native', 3)).toEqual([{ compactionId: 'claude:compact_boundary:native:boundary',
        phase: 'completed', trigger: 'idle', tokenCountBefore: 220_000, tokenCountAfter: 35_000, tokenCountSource: 'providerReported', emittedAtMs: 1 }]);
      expect(project.observe(ordinary, 'native', 4)).toEqual([]);
    },
  );
  it('annotates a notice-first boundary with the same canonical identity and measured counts', () => {
    const project = createClaudeUnifiedCompactionProjection();
    const initial = project.observe(notice('Compacted while idle, before the prompt cache expired'), 'native', 1);
    const measured = project.observe(boundary, 'native', 2);
    expect(initial).toMatchObject([{ trigger: 'idle' }]);
    expect(measured).toMatchObject([{ compactionId: initial[0]?.compactionId, trigger: 'idle', tokenCountBefore: 220_000, tokenCountAfter: 35_000, tokenCountSource: 'providerReported' }]);
  });
  it('preserves ordinary automatic and manual meaning and clears retired Session association', () => {
    const project = createClaudeUnifiedCompactionProjection();
    expect(project.observe(boundary, 'native', 1)).toEqual([]);
    expect(project.observe(summary, 'native', 2)).toEqual([]);
    expect(project.observe(ordinary, 'native', 3)).toMatchObject([{ trigger: 'automatic' }]);
    expect(project.observe({ ...boundary, compactMetadata: { trigger: 'manual', preTokens: 30 } }, 'native', 4))
      .toMatchObject([{ trigger: 'manual', tokenCountBefore: 30, tokenCountSource: 'providerReported' }]);
    project.observe(boundary, 'native', 5);
    expect(project.observe(ordinary, 'replacement', 6)).toEqual([]);
  });
});
