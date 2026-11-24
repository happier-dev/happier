import { expect, it } from 'vitest';

import { getActionSpec } from '../../actionSpecs.js';

it('rejects caller-supplied actor metadata while accepting an authored scalar answer', () => {
  const schema = getActionSpec('session.user_action.answer').inputSchema;
  const answer = {
    sessionId: 'session-a',
    requestId: 'question-a',
    answers: [{ question: 'Continue?', answer: 'Yes' }],
  };
  expect(schema.safeParse(answer).success).toBe(true);
  expect(schema.safeParse({ ...answer, answeredBy: { kind: 'session', sessionId: 'session-b' } }).success).toBe(false);
});

it('accepts the turn stamped by Activity question answers', () => {
  const input = { sessionId: 'session-a', requestId: 'question-a', turnId: 'turn-a', answers: [{ question: 'Continue?', values: ['Yes'] }] };
  expect(getActionSpec('session.user_action.answer').inputSchema.safeParse(input).success).toBe(true);
});

it('accepts the existing permission fields through the public answer schema', () => {
  const input = { sessionId: 'session-a', requestId: 'permission-a', decision: 'approve', allowedTools: ['Read'] };
  expect(getActionSpec('session.user_action.answer').inputSchema.parse(input)).toEqual(input);
});
