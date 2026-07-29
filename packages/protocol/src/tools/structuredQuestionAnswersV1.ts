import { z } from 'zod';

const STRUCTURED_QUESTION_ANSWERS_V1_LIMITS = Object.freeze({
  maxQuestions: 16,
  maxAnswersPerQuestion: 32,
  maxStringLength: 16_384,
  maxTotalStringLength: 262_144,
});

export type StructuredQuestionAnswersV1 = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * Exact structured-question answer carrier. Each question owns an ordered array,
 * including text and single-choice questions whose arrays contain one value.
 */
export const StructuredQuestionAnswersV1Schema = z
  .unknown()
  .superRefine((input, ctx) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      ctx.addIssue({ code: 'custom', message: 'Structured answers must be an object' });
      return;
    }

    const entries = Object.entries(input);
    if (entries.length > STRUCTURED_QUESTION_ANSWERS_V1_LIMITS.maxQuestions) {
      ctx.addIssue({ code: 'custom', message: 'Too many structured questions' });
    }

    let totalLength = 0;
    for (const [question, values] of entries) {
      if (question.length === 0 || question.length > STRUCTURED_QUESTION_ANSWERS_V1_LIMITS.maxStringLength) {
        ctx.addIssue({ code: 'custom', path: [question], message: 'Invalid structured question key' });
      }
      totalLength += question.length;
      if (!Array.isArray(values) || values.length > STRUCTURED_QUESTION_ANSWERS_V1_LIMITS.maxAnswersPerQuestion) {
        ctx.addIssue({ code: 'custom', path: [question], message: 'Invalid structured answer list' });
        continue;
      }

      const seen = new Set<string>();
      for (const value of values) {
        if (typeof value !== 'string' || value.length > STRUCTURED_QUESTION_ANSWERS_V1_LIMITS.maxStringLength) {
          ctx.addIssue({ code: 'custom', path: [question], message: 'Invalid structured answer value' });
          continue;
        }
        totalLength += value.length;
        if (seen.has(value)) {
          ctx.addIssue({ code: 'custom', path: [question], message: 'Duplicate structured answer value' });
        }
        seen.add(value);
      }
    }

    if (totalLength > STRUCTURED_QUESTION_ANSWERS_V1_LIMITS.maxTotalStringLength) {
      ctx.addIssue({ code: 'custom', message: 'Structured answers exceed the total size limit' });
    }
  })
  .transform((input) => {
    const normalized = Object.create(null) as Record<string, readonly string[]>;
    for (const [question, values] of Object.entries(input as Record<string, unknown>)) {
      normalized[question] = Object.freeze([...(values as string[])]);
    }
    return Object.freeze(normalized) as StructuredQuestionAnswersV1;
  });
