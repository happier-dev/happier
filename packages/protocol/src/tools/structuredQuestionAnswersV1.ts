import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { MAX_INTERACTION_TRANSIENT_CHOICES_V1, MAX_INTERACTION_TRANSIENT_QUESTIONS_V1 } from '../plugins/interactions/transientV1Limits.js';

const STRUCTURED_QUESTION_ANSWERS_V1_LIMITS = Object.freeze({
  maxQuestions: MAX_INTERACTION_TRANSIENT_QUESTIONS_V1,
  maxAnswersPerQuestion: MAX_INTERACTION_TRANSIENT_CHOICES_V1,
  maxStringLength: 16_384,
  maxTotalStringLength: 262_144,
});

export type StructuredQuestionAnswersV1 = Readonly<Record<string, ReadonlyArray<string>>>;

/** Custom text and commentary retain their native meaning beside selected answers. */
export type StructuredQuestionAnswerDetailsV1 = Readonly<Record<string, Readonly<{
  freeText?: string;
  note?: string;
}>>>;

export const StructuredQuestionAnswerDetailsV1Schema = lazyZodSchema(() => z.record(
  z.string().check(z.minLength(1), z.maxLength(STRUCTURED_QUESTION_ANSWERS_V1_LIMITS.maxStringLength)),
  z.readonly(z.strictObject({
    freeText: z.optional(z.string().check(z.maxLength(STRUCTURED_QUESTION_ANSWERS_V1_LIMITS.maxStringLength))),
    note: z.optional(z.string().check(z.maxLength(STRUCTURED_QUESTION_ANSWERS_V1_LIMITS.maxStringLength))),
  })),
).check(z.superRefine((details, ctx) => {
  if (Object.keys(details).length > STRUCTURED_QUESTION_ANSWERS_V1_LIMITS.maxQuestions) {
    ctx.addIssue({ code: 'custom', message: 'Too many structured questions' });
  }
  const totalLength = Object.entries(details).reduce((total, [question, detail]) => (
    total + question.length + (detail.freeText?.length ?? 0) + (detail.note?.length ?? 0)
  ), 0);
  if (totalLength > STRUCTURED_QUESTION_ANSWERS_V1_LIMITS.maxTotalStringLength) {
    ctx.addIssue({ code: 'custom', message: 'Structured answer details exceed the total size limit' });
  }
})));

/** Bounds apply to selected options, independently of custom text and notes. */
export const StructuredQuestionSelectionConstraintsV1Schema = lazyZodSchema(() => z.strictObject({
  minSelections: z.optional(z.number().check(z.int(), z.gte(0))),
  maxSelections: z.optional(z.number().check(z.int(), z.gte(0))),
}).check(z.refine(value => value.minSelections === undefined || value.maxSelections === undefined
  || value.minSelections <= value.maxSelections, 'Selection minimum must not exceed maximum')));
export type StructuredQuestionSelectionConstraintsV1 = z.infer<typeof StructuredQuestionSelectionConstraintsV1Schema>;

export function isStructuredQuestionSelectionCountValid(
  constraints: StructuredQuestionSelectionConstraintsV1,
  count: number,
): boolean {
  return (constraints.minSelections === undefined || count >= constraints.minSelections)
    && (constraints.maxSelections === undefined || count <= constraints.maxSelections);
}

/**
 * Exact structured-question answer carrier. Each question owns an ordered array,
 * including text and single-choice questions whose arrays contain one value.
 */
export const StructuredQuestionAnswersV1Schema = lazyZodSchema(() => z.pipe(z
  .unknown().check(z.superRefine((input, ctx) => {
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
  })), z.transform((input) => {
    const normalized = Object.create(null) as Record<string, readonly string[]>;
    for (const [question, values] of Object.entries(input as Record<string, unknown>)) {
      normalized[question] = Object.freeze([...(values as string[])]);
    }
    return Object.freeze(normalized) as StructuredQuestionAnswersV1;
  })));

/**
 * Receiver-owned compatibility for ui-web-v0.2.17 (b8d1c449) and the moving
 * 0.2 predecessor. Retain while those clients can send their lossless carrier;
 * new writers use the canonical user-action answer RPC instead.
 */
export const StructuredQuestionResponseV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  structuredAnswersV1: StructuredQuestionAnswersV1Schema,
}));
export type StructuredQuestionResponseV1 = z.infer<typeof StructuredQuestionResponseV1Schema>;
