import { z } from 'zod';

const OPAQUE_ID_MAX = 512;
const SHORT_TEXT_MAX = 16 * 1024;
const TASK_PROMPT_MAX = 64 * 1024;
const LONG_TEXT_MAX = 1024 * 1024;
const TODO_LIMIT = 2_000;
const QUESTION_LIMIT = 256;

export const cursorOpaqueIdSchema = z.string()
  .min(1)
  .max(OPAQUE_ID_MAX)
  .refine((value) => value.trim().length > 0, 'Opaque id must not be blank');

const shortTextSchema = z.string().trim().min(1).max(SHORT_TEXT_MAX);
const optionalShortTextSchema = z.string().trim().max(SHORT_TEXT_MAX).optional();
const optionalExactShortTextSchema = z.string().max(SHORT_TEXT_MAX)
  .refine((value) => value.trim().length > 0, 'Text must not be blank')
  .optional();

export const cursorTodoSchema = z.object({
  id: cursorOpaqueIdSchema.optional(),
  content: shortTextSchema.optional(),
  title: shortTextSchema.optional(),
  status: z.string().trim().min(1).max(64).optional(),
}).strip().refine(
  (value) => value.content !== undefined || value.title !== undefined,
  'Todo must include content or title',
);

export const cursorUpdateTodosRequestSchema = z.object({
  toolCallId: cursorOpaqueIdSchema.optional(),
  merge: z.boolean().optional(),
  todos: z.array(cursorTodoSchema).max(TODO_LIMIT),
}).strip();

const cursorQuestionOptionSchema = z.object({
  id: cursorOpaqueIdSchema,
  label: shortTextSchema,
}).strip();

const cursorQuestionSchema = z.object({
  id: cursorOpaqueIdSchema,
  prompt: shortTextSchema,
  options: z.array(cursorQuestionOptionSchema).max(QUESTION_LIMIT).optional(),
  allowMultiple: z.boolean().optional(),
}).strip();

export const cursorAskQuestionRequestSchema = z.object({
  toolCallId: cursorOpaqueIdSchema.optional(),
  title: optionalShortTextSchema,
  questions: z.array(cursorQuestionSchema).min(1).max(QUESTION_LIMIT),
}).strip();

const cursorQuestionAnswerSchema = z.object({
  questionId: cursorOpaqueIdSchema,
  selectedOptionIds: z.array(z.string().min(1).max(SHORT_TEXT_MAX)
    .refine((value) => value.trim().length > 0, 'Answer value must not be blank')).max(QUESTION_LIMIT),
}).strip();

export const cursorAskQuestionResponseSchema = z.object({
  outcome: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('answered'),
      answers: z.array(cursorQuestionAnswerSchema).max(QUESTION_LIMIT),
    }).strip(),
    z.object({
      outcome: z.literal('skipped'),
      reason: z.string().trim().max(SHORT_TEXT_MAX).optional(),
    }).strip(),
    z.object({ outcome: z.literal('cancelled') }).strip(),
  ]),
}).strip();

const cursorPlanPhaseSchema = z.object({
  name: optionalShortTextSchema,
  todos: z.array(cursorTodoSchema).max(TODO_LIMIT).optional(),
}).strip();

export const cursorCreatePlanRequestSchema = z.object({
  toolCallId: cursorOpaqueIdSchema.optional(),
  name: optionalShortTextSchema,
  overview: z.string().trim().max(LONG_TEXT_MAX).optional(),
  isProject: z.boolean().optional(),
  plan: z.string().trim().max(LONG_TEXT_MAX).optional(),
  todos: z.array(cursorTodoSchema).max(TODO_LIMIT).optional(),
  phases: z.array(cursorPlanPhaseSchema).max(QUESTION_LIMIT).optional(),
}).strip().superRefine((value, context) => {
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
});

export const cursorCreatePlanResponseSchema = z.object({
  outcome: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('accepted'),
      planUri: z.string().max(SHORT_TEXT_MAX).url().optional(),
    }).strip(),
    z.object({
      outcome: z.literal('rejected'),
      reason: z.string().trim().max(SHORT_TEXT_MAX).optional(),
    }).strip(),
    z.object({ outcome: z.literal('cancelled') }).strip(),
  ]),
}).strip();

export const cursorTaskNotificationSchema = z.object({
  toolCallId: cursorOpaqueIdSchema.optional(),
  description: optionalShortTextSchema,
  prompt: z.string().max(TASK_PROMPT_MAX).optional(),
  subagentType: z.union([
    z.string().max(SHORT_TEXT_MAX),
    z.object({ custom: z.string().max(SHORT_TEXT_MAX) }).strip(),
  ]).optional(),
  model: optionalExactShortTextSchema,
  agentId: cursorOpaqueIdSchema.optional(),
  durationMs: z.number().finite().nonnegative().max(2_592_000_000).optional(),
}).strip();

export const cursorGenerateImageNotificationSchema = z.object({
  toolCallId: cursorOpaqueIdSchema.optional(),
  filePath: z.string().max(SHORT_TEXT_MAX).optional(),
  description: z.string().max(LONG_TEXT_MAX).optional(),
  referenceImagePaths: z.array(z.string().max(SHORT_TEXT_MAX)).max(64).optional(),
}).strip();

export type CursorAskQuestionRequest = z.infer<typeof cursorAskQuestionRequestSchema>;
export type CursorCreatePlanRequest = z.infer<typeof cursorCreatePlanRequestSchema>;
export type CursorGenerateImageNotification =
  z.infer<typeof cursorGenerateImageNotificationSchema>;
export type CursorTaskNotification = z.infer<typeof cursorTaskNotificationSchema>;
export type CursorTodoInput = z.infer<typeof cursorTodoSchema>;
export type CursorUpdateTodosRequest = z.infer<typeof cursorUpdateTodosRequestSchema>;
