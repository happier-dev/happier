import { z } from 'zod/mini';

const OPAQUE_ID_MAX = 512;
const SHORT_TEXT_MAX = 16 * 1024;
const TASK_PROMPT_MAX = 64 * 1024;
const LONG_TEXT_MAX = 1024 * 1024;
const TODO_LIMIT = 2_000;
const QUESTION_LIMIT = 256;

export const cursorOpaqueIdSchema = z.lazy(() => z.string().check(z.minLength(1), z.maxLength(OPAQUE_ID_MAX), z.refine((value) => value.trim().length > 0, 'Opaque id must not be blank')));

const shortTextSchema = z.lazy(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SHORT_TEXT_MAX)));
const optionalShortTextSchema = z.lazy(() => z.optional(z.string().check(z.trim(), z.maxLength(SHORT_TEXT_MAX))));
const optionalExactShortTextSchema = z.lazy(() => z.optional(z.string().check(z.maxLength(SHORT_TEXT_MAX), z.refine((value) => value.trim().length > 0, 'Text must not be blank'))));

export const cursorTodoSchema = z.lazy(() => z.object({
  id: z.optional(cursorOpaqueIdSchema),
  content: z.optional(shortTextSchema),
  title: z.optional(shortTextSchema),
  status: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(64))),
}).check(z.refine((value) => value.content !== undefined || value.title !== undefined, 'Todo must include content or title')));

export const cursorUpdateTodosRequestSchema = z.lazy(() => z.object({
  toolCallId: z.optional(cursorOpaqueIdSchema),
  merge: z.optional(z.boolean()),
  todos: z.array(cursorTodoSchema).check(z.maxLength(TODO_LIMIT)),
}));

const cursorQuestionOptionSchema = z.lazy(() => z.object({
  id: cursorOpaqueIdSchema,
  label: shortTextSchema,
}));

const cursorQuestionSchema = z.lazy(() => z.object({
  id: cursorOpaqueIdSchema,
  prompt: shortTextSchema,
  options: z.optional(z.array(cursorQuestionOptionSchema).check(z.maxLength(QUESTION_LIMIT))),
  allowMultiple: z.optional(z.boolean()),
}));

export const cursorAskQuestionRequestSchema = z.lazy(() => z.object({
  toolCallId: z.optional(cursorOpaqueIdSchema),
  title: optionalShortTextSchema,
  questions: z.array(cursorQuestionSchema).check(z.minLength(1), z.maxLength(QUESTION_LIMIT)),
}));

const cursorQuestionAnswerSchema = z.lazy(() => z.object({
  questionId: cursorOpaqueIdSchema,
  selectedOptionIds: z.array(z.string().check(z.minLength(1), z.maxLength(SHORT_TEXT_MAX), z.refine((value) => value.trim().length > 0, 'Answer value must not be blank'))).check(z.maxLength(QUESTION_LIMIT)),
}));

export const cursorAskQuestionResponseSchema = z.lazy(() => z.object({
  outcome: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('answered'),
      answers: z.array(cursorQuestionAnswerSchema).check(z.maxLength(QUESTION_LIMIT)),
    }),
    z.object({
      outcome: z.literal('skipped'),
      reason: z.optional(z.string().check(z.trim(), z.maxLength(SHORT_TEXT_MAX))),
    }),
    z.object({ outcome: z.literal('cancelled') }),
  ]),
}));

const cursorPlanPhaseSchema = z.lazy(() => z.object({
  name: optionalShortTextSchema,
  todos: z.optional(z.array(cursorTodoSchema).check(z.maxLength(TODO_LIMIT))),
}));

export const cursorCreatePlanRequestSchema = z.lazy(() => z.object({
  toolCallId: z.optional(cursorOpaqueIdSchema),
  name: optionalShortTextSchema,
  overview: z.optional(z.string().check(z.trim(), z.maxLength(LONG_TEXT_MAX))),
  isProject: z.optional(z.boolean()),
  plan: z.optional(z.string().check(z.trim(), z.maxLength(LONG_TEXT_MAX))),
  todos: z.optional(z.array(cursorTodoSchema).check(z.maxLength(TODO_LIMIT))),
  phases: z.optional(z.array(cursorPlanPhaseSchema).check(z.maxLength(QUESTION_LIMIT))),
}).check(z.superRefine((value, context) => {
  const totalTodos = (value.todos?.length ?? 0)
    + (value.phases ?? []).reduce((count, phase) => count + (phase.todos?.length ?? 0), 0);
  if (totalTodos > TODO_LIMIT) {
    context.addIssue({
      code: 'too_big',
      origin: 'array',
      maximum: TODO_LIMIT,
      inclusive: true,
      path: ['phases'],
      message: `Plan may contain at most ${TODO_LIMIT} todos`,
    });
  }
})));

export const cursorCreatePlanResponseSchema = z.lazy(() => z.object({
  outcome: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('accepted'),
      planUri: z.optional(z.string().check(z.maxLength(SHORT_TEXT_MAX), z.url())),
    }),
    z.object({
      outcome: z.literal('rejected'),
      reason: z.optional(z.string().check(z.trim(), z.maxLength(SHORT_TEXT_MAX))),
    }),
    z.object({ outcome: z.literal('cancelled') }),
  ]),
}));

export const cursorTaskNotificationSchema = z.lazy(() => z.object({
  toolCallId: z.optional(cursorOpaqueIdSchema),
  description: optionalShortTextSchema,
  prompt: z.optional(z.string().check(z.maxLength(TASK_PROMPT_MAX))),
  subagentType: z.optional(z.union([
    z.string().check(z.maxLength(SHORT_TEXT_MAX)),
    z.object({ custom: z.string().check(z.maxLength(SHORT_TEXT_MAX)) }),
  ])),
  model: optionalExactShortTextSchema,
  agentId: z.optional(cursorOpaqueIdSchema),
  durationMs: z.optional(z.number().check(z.nonnegative(), z.maximum(2_592_000_000))),
}));

export const cursorGenerateImageNotificationSchema = z.lazy(() => z.object({
  toolCallId: z.optional(cursorOpaqueIdSchema),
  filePath: z.optional(z.string().check(z.maxLength(SHORT_TEXT_MAX))),
  description: z.optional(z.string().check(z.maxLength(LONG_TEXT_MAX))),
  referenceImagePaths: z.optional(z.array(z.string().check(z.maxLength(SHORT_TEXT_MAX))).check(z.maxLength(64))),
}));

export type CursorAskQuestionRequest = z.infer<typeof cursorAskQuestionRequestSchema>;
export type CursorCreatePlanRequest = z.infer<typeof cursorCreatePlanRequestSchema>;
export type CursorGenerateImageNotification =
  z.infer<typeof cursorGenerateImageNotificationSchema>;
export type CursorTaskNotification = z.infer<typeof cursorTaskNotificationSchema>;
export type CursorTodoInput = z.infer<typeof cursorTodoSchema>;
export type CursorUpdateTodosRequest = z.infer<typeof cursorUpdateTodosRequestSchema>;
