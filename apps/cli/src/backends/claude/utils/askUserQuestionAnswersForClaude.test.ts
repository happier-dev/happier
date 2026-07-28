import { describe, expect, it } from 'vitest';
import { buildAskUserQuestionAnswersForClaude } from './askUserQuestionAnswersForClaude';

describe('buildAskUserQuestionAnswersForClaude', () => {
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
