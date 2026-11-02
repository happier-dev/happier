import { describe, expect, it } from 'vitest';
import { buildAskUserQuestionAnswersForClaude, buildNativeAskUserQuestionAnswersForClaude } from './askUserQuestionAnswersForClaude';

describe('buildAskUserQuestionAnswersForClaude', () => {
  it('projects native id aliases and checkbox order without losing commas or freeform newlines', () => {
    const result = buildNativeAskUserQuestionAnswersForClaude([
      { id: 'colors', question: 'Which colors?', multiSelect: true, options: [{ label: 'Amber, gold' }, { label: 'Say "hello"' }, { label: 'Red,blue' }], freeform: {} },
      { id: 'single', question: 'Which single?', options: [{ label: 'Amber, gold' }], freeform: {} },
      { id: 'note', question: 'Which note?', options: [{ label: 'None' }], freeform: {} },
    ], { colors: ['Red,blue', 'Say "hello"', 'Amber, gold'], single: ['Amber, gold'], note: ['first\nsecond — 雪'] });
    // Claude Code 2.1.316 native review and tool result use JSON quoting per checkbox value.
    expect(result).toEqual({ 'Which colors?': '"Amber, gold", "Say \\"hello\\"", Red,blue', 'Which single?': 'Amber, gold', 'Which note?': 'first\nsecond — 雪' });
  });
  it('projects exact canonical arrays to Claude scalar strings in a null-prototype record', () => {
    const result = buildAskUserQuestionAnswersForClaude({
      single: ['A, B'],
      multi: ['A', 'B, C'],
      freeform: ['line one\nline two'],
      empty: [],
      ['__proto__']: ['reserved'],
    });

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.keys(result)).toEqual(['single', 'multi', 'freeform', 'empty', '__proto__']);
    expect(result.single).toBe('A, B');
    expect(result.multi).toBe('A, B, C');
    expect(result.freeform).toBe('line one\nline two');
    expect(result.empty).toBe('');
    expect(result.__proto__).toBe('reserved');
  });
});
