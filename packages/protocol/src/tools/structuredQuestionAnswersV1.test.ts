import { describe, expect, it } from 'vitest';

import { StructuredQuestionAnswerDetailsV1Schema, StructuredQuestionAnswersV1Schema, StructuredQuestionResponseV1Schema } from './structuredQuestionAnswersV1.js';
import { AskUserQuestionResultV2Schema } from './v2/schemas.js';
import { buildSessionUserActionAnswerDetails, buildSessionUserActionAnswerItems, buildSessionUserActionAnswerMap, SessionUserActionAnswerRpcParamsV1Schema } from '../sessions/permissions/respondRpcParamsV1.js';
import { SessionUserActionAnswerInputSchema } from '../actions/specs/session/interaction.js';

describe('StructuredQuestionAnswersV1Schema', () => {
  it('preserves an empty selected set and separate commentary through the public Action and RPC', () => {
    const items = buildSessionUserActionAnswerItems({ optional: [], components: ['api', 'ui'] }, {
      components: { freeText: 'Custom, other', note: 'Keep separate' },
    });
    const admitted = SessionUserActionAnswerInputSchema.parse({ requestId: 'r', answers: items });
    const rpc = SessionUserActionAnswerRpcParamsV1Schema.parse({
      id: 'r', approved: true,
      answers: buildSessionUserActionAnswerMap(admitted.answers),
      answerDetails: buildSessionUserActionAnswerDetails(admitted.answers),
    });
    expect(rpc.answers).toEqual({ optional: [], components: ['api', 'ui'] });
    expect(rpc.answerDetails).toEqual({ components: { freeText: 'Custom, other', note: 'Keep separate' } });
  });
  it('keeps custom text and a separate note under the exact question id without changing selected answer arrays', () => {
    const details = StructuredQuestionAnswerDetailsV1Schema.parse({
      'components, one': { freeText: 'Custom, other', note: 'Keep this note separate' },
    });
    expect(details).toEqual({ 'components, one': { freeText: 'Custom, other', note: 'Keep this note separate' } });
    expect(StructuredQuestionAnswersV1Schema.parse({ 'components, one': ['api', 'ui'] }))
      .toEqual({ 'components, one': ['api', 'ui'] });
    expect(StructuredQuestionAnswerDetailsV1Schema.safeParse({ q: { selected: ['api'] } }).success).toBe(false);
  });
  it('reads the strict 0.2 lossless response wrapper without permission metadata', () => {
    // ui-web-v0.2.17 b8d1c449, sessions.ts sessionAllowWithAnswers producer.
    const response = { id: 'question-one', structuredAnswersV1: { Branch: ['Alpha, Beta', 'Gamma'] } };
    expect(StructuredQuestionResponseV1Schema.parse(response)).toEqual(response);
    for (const extra of [{ approved: true }, { decision: 'approved' }, { answers: { Branch: ['Other'] } },
      { updatedPermissions: {} }, { disposition: 'pass_up' }]) {
      expect(StructuredQuestionResponseV1Schema.safeParse({ ...response, ...extra }).success).toBe(false);
    }
  });
  it('accepts complete answers at the canonical author form bounds without truncation', () => {
    const answers = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`q${index}`, ['value']]));
    answers.q0 = Array.from({ length: 64 }, (_, index) => `choice-${index}`);
    expect(StructuredQuestionAnswersV1Schema.parse(answers)).toEqual(answers);
    expect(StructuredQuestionAnswersV1Schema.safeParse({ ...answers, extra: ['value'] }).success).toBe(false);
    expect(StructuredQuestionAnswersV1Schema.safeParse({ q: [...answers.q0!, 'extra'] }).success).toBe(false);
  });
  it('preserves exact ordered answer arrays including commas', () => {
    expect(StructuredQuestionAnswersV1Schema.parse({
      components: ['Alpha, Beta', 'Gamma', 'Custom, other'],
    })).toEqual({
      components: ['Alpha, Beta', 'Gamma', 'Custom, other'],
    });

    expect(AskUserQuestionResultV2Schema.parse({
      answers: {
        components: ['Alpha, Beta', 'Gamma', 'Custom, other'],
      },
    }).answers).toEqual({
      components: ['Alpha, Beta', 'Gamma', 'Custom, other'],
    });
  });

  it('rejects legacy scalar and mixed answer records', () => {
    expect(StructuredQuestionAnswersV1Schema.safeParse({ component: 'Alpha, Beta' }).success).toBe(false);
    expect(StructuredQuestionAnswersV1Schema.safeParse({
      component: ['Alpha, Beta'],
      notes: 'Gamma',
    }).success).toBe(false);
  });

  it('rejects duplicate values within one answer array', () => {
    expect(StructuredQuestionAnswersV1Schema.safeParse({
      component: ['Alpha, Beta', 'Alpha, Beta'],
    }).success).toBe(false);
  });
});
