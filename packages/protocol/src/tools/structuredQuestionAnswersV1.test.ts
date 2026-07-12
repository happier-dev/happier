import { describe, expect, it } from 'vitest';

import {
  StructuredQuestionAnswersV1Schema,
  buildLegacyStructuredQuestionAnswers,
  isAskUserQuestionToolName,
  resolveStructuredQuestionOptionAnswerValue,
} from './structuredQuestionAnswersV1.js';

describe('StructuredQuestionAnswersV1', () => {
  it('recognizes exactly the two canonical AskUserQuestion aliases', () => {
    expect(isAskUserQuestionToolName('AskUserQuestion')).toBe(true);
    expect(isAskUserQuestionToolName('ask_user_question')).toBe(true);
    expect(isAskUserQuestionToolName('ExitPlanMode')).toBe(false);
    expect(isAskUserQuestionToolName('user_action')).toBe(false);
  });

  it('resolves the canonical wire answer without replacing its exact bytes', () => {
    expect(resolveStructuredQuestionOptionAnswerValue('  string option  ')).toBe('  string option  ');
    expect(resolveStructuredQuestionOptionAnswerValue({
      value: '  wire,value  ',
      choice: 'choice-id',
      label: 'Human label',
    })).toBe('  wire,value  ');
    expect(resolveStructuredQuestionOptionAnswerValue({ value: '   ', choice: 'choice-id', label: 'Human label' }))
      .toBe('choice-id');
    expect(resolveStructuredQuestionOptionAnswerValue({ value: '', choice: ' ', label: '  Human label  ' }))
      .toBe('  Human label  ');
    expect(resolveStructuredQuestionOptionAnswerValue({ value: '', choice: ' ', label: '   ' })).toBeNull();
    expect(resolveStructuredQuestionOptionAnswerValue(null)).toBeNull();
  });
  it('preserves ordered values, commas, newlines, and reserved object keys', () => {
    const input = JSON.parse('{"__proto__":["A, B","line 1\\nline 2"],"constructor":["value"]}');
    const parsed = StructuredQuestionAnswersV1Schema.parse(input);

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.keys(parsed)).toEqual(['__proto__', 'constructor']);
    expect(parsed.__proto__).toEqual(['A, B', 'line 1\nline 2']);
    expect(parsed.constructor).toEqual(['value']);
  });

  it('rejects duplicate values and oversized data instead of silently changing it', () => {
    expect(() => StructuredQuestionAnswersV1Schema.parse({ q: ['same', 'same'] })).toThrow();
    expect(() => StructuredQuestionAnswersV1Schema.parse({ q: ['x'.repeat(16_385)] })).toThrow();
    expect(() => StructuredQuestionAnswersV1Schema.parse({ q: Array.from({ length: 33 }, (_, index) => String(index)) })).toThrow();
  });

  it('allows explicit empty arrays only on the modern schema', () => {
    const parsed = StructuredQuestionAnswersV1Schema.parse({ q: [] });
    expect(parsed.q).toEqual([]);
    expect(buildLegacyStructuredQuestionAnswers(parsed)).toBeNull();
  });

  it('builds legacy answers only when the historical parser round-trips exactly', () => {
    expect(buildLegacyStructuredQuestionAnswers(StructuredQuestionAnswersV1Schema.parse({ q: ['A', 'B'] }))).toEqual({ q: 'A, B' });
    expect(buildLegacyStructuredQuestionAnswers(StructuredQuestionAnswersV1Schema.parse({ q: ['A, B', 'C'] }))).toBeNull();
    expect(buildLegacyStructuredQuestionAnswers(StructuredQuestionAnswersV1Schema.parse({ q: [' A'] }))).toBeNull();
    expect(buildLegacyStructuredQuestionAnswers(StructuredQuestionAnswersV1Schema.parse({ q: [''] }))).toBeNull();
  });
});
