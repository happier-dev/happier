import { describe, expect, it } from 'vitest';

import { buildGrokHostQuestions, buildGrokQuestionResponse, parseGrokQuestionRequest } from './questions.js';

describe('Grok xAI question codec', () => {
  const request = parseGrokQuestionRequest({
    sessionId: 'provider-session', toolCallId: 'tool-1', mode: 'default',
    questions: [{ id: 'q1', question: 'Choose?', options: [
      { label: 'Fast', description: 'Lower latency', preview: 'fast preview' },
      { label: 'Other', description: 'A literal provider option' },
    ] }],
  }, 'provider-session');

  it('offers provider choices plus typed freeform Other and returns provider keys', () => {
    expect(buildGrokHostQuestions(request)).toEqual([{
      id: 'q1', prompt: 'Choose?', type: 'single', required: true, allowCustom: true,
      choices: [
        { id: 'Fast', label: 'Fast', description: 'Lower latency' },
        { id: 'Other', label: 'Other', description: 'A literal provider option' },
      ],
    }]);
    expect(buildGrokQuestionResponse(request, {
      status: 'answered', answers: { q1: { type: 'single', answer: { type: 'choice', choiceId: 'Fast' } } },
    })).toEqual({ outcome: 'accepted', answers: { 'Choose?': ['Fast'] }, annotations: { 'Choose?': { preview: 'fast preview' } } });
    expect(buildGrokQuestionResponse(request, {
      status: 'answered', answers: { q1: { type: 'single', answer: { type: 'custom', value: 'My answer' } } },
    })).toEqual({ outcome: 'accepted', answers: { 'Choose?': ['Other'] }, annotations: { 'Choose?': { notes: 'My answer' } } });
  });

  it('fails closed on mismatched sessions, duplicate labels, and ambiguous literal Other plus freeform', () => {
    expect(() => parseGrokQuestionRequest({
      sessionId: 'other', toolCallId: 'tool-1', mode: 'default', questions: [{ question: 'Q', options: [] }],
    }, 'provider-session')).toThrow('session');
    expect(() => parseGrokQuestionRequest({
      sessionId: 'provider-session', toolCallId: 'tool-1', mode: 'default', questions: [{ question: 'Q', options: [{ label: 'A' }, { label: 'A' }] }],
    }, 'provider-session')).toThrow('unique');
    expect(() => buildGrokQuestionResponse(request, {
      status: 'answered', answers: { q1: { type: 'multiple', answers: [
        { type: 'choice', choiceId: 'Other' }, { type: 'custom', value: 'freeform' },
      ] } },
    })).toThrow('ambiguous');
  });

  it('accepts a method-consistent wrapped alias and rejects mismatched or oversized payloads', () => {
    expect(parseGrokQuestionRequest({
      method: '_x.ai/ask_user_question',
      params: {
        sessionId: 'provider-session', toolCallId: 'tool-2', mode: 'plan',
        questions: [{ question: 'Continue?', options: [] }],
      },
    }, 'provider-session', '_x.ai/ask_user_question')).toMatchObject({ mode: 'plan', toolCallId: 'tool-2' });
    expect(() => parseGrokQuestionRequest({
      method: 'x.ai/ask_user_question',
      params: {
        sessionId: 'provider-session', toolCallId: 'tool-2', mode: 'plan',
        questions: [{ question: 'Continue?', options: [] }],
      },
    }, 'provider-session', '_x.ai/ask_user_question')).toThrow('does not match');
    expect(() => parseGrokQuestionRequest({
      sessionId: 'provider-session', toolCallId: 'tool-3', mode: 'default',
      questions: Array.from({ length: 5 }, (_, index) => ({
        question: `Q${index}${'x'.repeat(14_000)}`, options: [],
      })),
    }, 'provider-session')).toThrow('total string limit');
  });
});
