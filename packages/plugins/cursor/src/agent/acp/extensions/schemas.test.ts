import { describe, expect, it } from 'vitest';

import {
  cursorAskQuestionRequestSchema,
  cursorAskQuestionResponseSchema,
  cursorCreatePlanRequestSchema,
  cursorCreatePlanResponseSchema,
  cursorGenerateImageNotificationSchema,
} from './schemas.js';

describe('Cursor ACP extension schemas', () => {
  it('preserves opaque nonblank ids while stripping unknown fields', () => {
    expect(cursorAskQuestionRequestSchema.parse({
      toolCallId: ' exact\nopaque\0id ',
      questions: [{
        id: ' question\n ',
        prompt: 'Prompt',
        options: [{ id: ' option, id ', label: 'Option', secret: 'strip' }],
      }],
      secret: 'strip',
    })).toEqual({
      toolCallId: ' exact\nopaque\0id ',
      questions: [{
        id: ' question\n ',
        prompt: 'Prompt',
        options: [{ id: ' option, id ', label: 'Option' }],
      }],
    });
  });

  it('rejects blank ids and bounded-array overflow', () => {
    expect(cursorAskQuestionRequestSchema.safeParse({
      questions: [{ id: '   ', prompt: 'Prompt' }],
    }).success).toBe(false);
    expect(cursorAskQuestionRequestSchema.safeParse({
      questions: Array.from({ length: 257 }, (_, index) => ({ id: `q-${index}`, prompt: 'Prompt' })),
    }).success).toBe(false);
    expect(cursorCreatePlanRequestSchema.safeParse({
      phases: Array.from({ length: 256 }, (_, phaseIndex) => ({
        name: `phase-${phaseIndex}`,
        todos: Array.from({ length: 8 }, (_, todoIndex) => ({
          id: `${phaseIndex}-${todoIndex}`,
          content: 'Todo',
        })),
      })),
    }).success).toBe(false);
  });

  it('accepts only exact nested question and plan outcome envelopes', () => {
    expect(cursorAskQuestionResponseSchema.safeParse({ answers: {} }).success).toBe(false);
    expect(cursorAskQuestionResponseSchema.safeParse({
      outcome: { outcome: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['a'] }] },
    }).success).toBe(true);
    expect(cursorCreatePlanResponseSchema.safeParse({ accepted: true }).success).toBe(false);
    expect(cursorCreatePlanResponseSchema.safeParse({ outcome: { outcome: 'accepted' } }).success).toBe(true);
  });

  it('bounds generated-media metadata and strips provider extras', () => {
    expect(cursorGenerateImageNotificationSchema.parse({
      toolCallId: 'media',
      filePath: '/tmp/image.png',
      referenceImagePaths: ['/tmp/reference.png'],
      prompt: 'not part of the source contract',
    })).toEqual({
      toolCallId: 'media',
      filePath: '/tmp/image.png',
      referenceImagePaths: ['/tmp/reference.png'],
    });
  });
});
