import { describe, expect, it } from 'vitest';

import { normalizeStructuredQuestionAnswersV1 } from '@/agent/questions/normalizeStructuredQuestionAnswersV1';

import {
  AcpFormElicitationUnsupportedError,
  buildAcpFormElicitationContent,
  projectAcpFormElicitation,
} from './acpFormElicitation';

// Recorded from `agy acp` 1.5.18 for a two-question `ask_question` call (multi-select + single choice).
const AGY_TWO_QUESTIONS = {
  sessionId: 's1',
  toolCallId: 'call_7',
  mode: 'form',
  message: 'The agent has 2 questions.',
  requestedSchema: {
    type: 'object',
    properties: {
      q1: {
        type: 'array',
        title: 'Which fruits do you like?',
        items: { anyOf: [{ const: '1', title: '(Recommended) apple' }, { const: '2', title: 'banana' }, { const: '3', title: 'cherry' }] },
      },
      q1_other: { type: 'string', title: 'Other', description: 'Optional free-form answer to: Which fruits do you like?' },
      q2: { type: 'string', title: 'Pick a size', oneOf: [{ const: '1', title: '(Recommended) small' }, { const: '2', title: 'large' }] },
      q2_other: { type: 'string', title: 'Other', description: 'Optional free-form answer to: Pick a size' },
    },
  },
};

function answer(projection: ReturnType<typeof projectAcpFormElicitation>, raw: Record<string, string[]>) {
  // The canonical question owner validates the user's reply before the elicitation sees it.
  const questions = projection.askUserQuestionInput.questions;
  return buildAcpFormElicitationContent(projection, normalizeStructuredQuestionAnswersV1(raw, questions));
}

describe('projectAcpFormElicitation', () => {
  it('maps choices, multi-select and the free-form companion field back to schema values', () => {
    const projection = projectAcpFormElicitation(AGY_TWO_QUESTIONS, 's1');
    expect(projection.toolCallId).toBe('call_7');
    expect(projection.askUserQuestionInput.questions).toHaveLength(2);

    expect(answer(projection, { q1: ['banana', 'cherry'], q2: ['large'] }))
      .toEqual({ q1: ['2', '3'], q2: '2' });
    expect(answer(projection, { q1: ['(Recommended) apple', 'kiwi'], q2: ['medium'] }))
      .toEqual({ q1: ['1'], q1_other: 'kiwi', q2_other: 'medium' });
  });

  it('presents booleans and plain text, omitting an empty optional answer', () => {
    const projection = projectAcpFormElicitation({
      sessionId: 's1',
      mode: 'form',
      message: 'Confirm',
      requestedSchema: {
        type: 'object',
        properties: {
          proceed: { type: 'boolean', title: 'Proceed?' },
          note: { type: 'string', title: 'Note' },
        },
        required: ['proceed'],
      },
    }, 's1');
    expect(projection.toolCallId).toBeNull();
    expect(answer(projection, { proceed: ['No'], note: [''] })).toEqual({ proceed: false });
    expect(answer(projection, { proceed: ['Yes'], note: ['ship it'] })).toEqual({ proceed: true, note: 'ship it' });
  });

  it('refuses forms it cannot present or that belong to another session', () => {
    expect(() => projectAcpFormElicitation(AGY_TWO_QUESTIONS, 'other-session'))
      .toThrow(AcpFormElicitationUnsupportedError);
    expect(() => projectAcpFormElicitation({ ...AGY_TWO_QUESTIONS, mode: 'url', url: 'https://example.test' }, 's1'))
      .toThrow(AcpFormElicitationUnsupportedError);
    expect(() => projectAcpFormElicitation({
      sessionId: 's1',
      mode: 'form',
      message: 'n',
      requestedSchema: { type: 'object', properties: { count: { type: 'integer', title: 'How many?' } } },
    }, 's1')).toThrow(AcpFormElicitationUnsupportedError);
  });
});
