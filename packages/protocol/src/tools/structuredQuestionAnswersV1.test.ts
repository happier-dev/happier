import { describe, expect, it } from 'vitest';

import { StructuredQuestionAnswersV1Schema } from './structuredQuestionAnswersV1.js';
import { AskUserQuestionResultV2Schema } from './v2/schemas.js';

describe('StructuredQuestionAnswersV1Schema', () => {
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
