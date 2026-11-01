import { z } from 'zod';
import { isAskUserQuestionToolName, normalizeStructuredQuestionDescriptors, STRUCTURED_QUESTION_LIMITS } from '../tools/structuredQuestionAnswersV1.js';
import { PUSH_NOTIFICATION_ACTION_IDS, PUSH_NOTIFICATION_CATEGORY_IDS } from './pushNotificationActions.js';
import { lazySchema } from '../lazySchema.js';

// Android supports at most three notification actions; every offered choice
// keeps its numbered label in the complete notification body.
export const NOTIFICATION_QUESTION_MAX_CHOICES = 3;
const questionString = lazySchema(() => z.string().max(STRUCTURED_QUESTION_LIMITS.maxStringLength));
export const NotificationQuestionAnswerV1Schema = lazySchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choices'), questionKey: questionString.min(1),
    values: z.array(questionString).min(1).max(NOTIFICATION_QUESTION_MAX_CHOICES) }).strict(),
  z.object({ kind: z.literal('text'), questionKey: questionString.min(1), allowEmpty: z.boolean() }).strict(),
]));
export type NotificationQuestionAnswerV1 = z.infer<typeof NotificationQuestionAnswerV1Schema>;

export function projectNotificationQuestion(toolName: string, toolInput: unknown): Readonly<{
  descriptor: NotificationQuestionAnswerV1; body: string; categoryId: string;
}> | null {
  if (!isAskUserQuestionToolName(toolName) || !toolInput || typeof toolInput !== 'object' || !('questions' in toolInput)) return null;
  const normalized = normalizeStructuredQuestionDescriptors(toolInput.questions);
  if (!normalized.ok || normalized.questions.length !== 1) return null;
  const question = normalized.questions[0]!;
  if (question.multiSelect) return null;
  const questionKey = question.id?.trim() ? question.id : question.responseKey;
  const label = question.question?.trim() ? question.question : question.responseKey;
  if (question.options.length > 0 && question.options.length <= NOTIFICATION_QUESTION_MAX_CHOICES) {
    const categoryId = [PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices1V1,
      PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices2V1, PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices3V1][question.options.length - 1]!;
    return { descriptor: { kind: 'choices', questionKey, values: question.options.map(option => option.answerValue) },
      body: [label, ...question.options.map((option, index) => {
        const text = [option.label, option.description]
          .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
          .map(part => part.replace(/\s+/gu, ' ').trim()).join(' — ');
        return `${index + 1}. ${text}`;
      })].join('\n'), categoryId };
  }
  if (question.options.length === 0 && question.allowsFreeform && !question.freeform?.multiline && !question.freeform?.initialValue) {
    return { descriptor: { kind: 'text', questionKey, allowEmpty: question.freeform?.allowEmpty === true },
      body: label, categoryId: PUSH_NOTIFICATION_CATEGORY_IDS.questionTextV1 };
  }
  return null;
}

export function isNotificationQuestionAnswerAction(actionIdentifier: string): boolean {
  return actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.questionChoice1V1
    || actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.questionChoice2V1
    || actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.questionChoice3V1
    || actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.questionTextV1;
}

export function readNotificationQuestionAnswer(
  descriptor: unknown, actionIdentifier: string, userText: unknown,
): Readonly<Record<string, readonly string[]>> | null {
  const parsed = NotificationQuestionAnswerV1Schema.safeParse(descriptor);
  if (!parsed.success) return null;
  const question = parsed.data;
  if (question.kind === 'text') {
    if (actionIdentifier !== PUSH_NOTIFICATION_ACTION_IDS.questionTextV1 || typeof userText !== 'string'
      || userText.length > STRUCTURED_QUESTION_LIMITS.maxStringLength || (!question.allowEmpty && !userText.trim())) return null;
    return { [question.questionKey]: [userText] };
  }
  const index = [PUSH_NOTIFICATION_ACTION_IDS.questionChoice1V1, PUSH_NOTIFICATION_ACTION_IDS.questionChoice2V1,
    PUSH_NOTIFICATION_ACTION_IDS.questionChoice3V1].findIndex(id => id === actionIdentifier);
  const value = question.values[index];
  return value === undefined ? null : { [question.questionKey]: [value] };
}
