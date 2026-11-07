import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { AgentRequestSemanticSummary } from '../activity/agentRequestSummary.js';
import { StructuredQuestionAnswersV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import { PUSH_NOTIFICATION_ACTION_IDS, PUSH_NOTIFICATION_CATEGORY_IDS } from './pushNotificationActions.js';

// Android supports at most three native notification actions.
export const NOTIFICATION_QUESTION_MAX_CHOICES = 3;
export const NotificationQuestionAnswerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('choices'),
    questionKey: z.string().check(z.minLength(1)),
    values: z.array(z.string()).check(z.minLength(1), z.maxLength(NOTIFICATION_QUESTION_MAX_CHOICES)),
  }),
  z.strictObject({
    kind: z.literal('text'),
    questionKey: z.string().check(z.minLength(1)),
    allowEmpty: z.boolean(),
  }),
]));
export type NotificationQuestionAnswerV1 = z.infer<typeof NotificationQuestionAnswerV1Schema>;

/** Project native actions from the same admitted question semantics as the full form. */
export function projectNotificationQuestion(
  summary: Pick<AgentRequestSemanticSummary, 'kind' | 'questions'>,
): Readonly<{ descriptor: NotificationQuestionAnswerV1; body: string; categoryId: string }> | null {
  if (summary.kind !== 'user_action' || summary.questions.length !== 1) return null;
  const question = summary.questions[0]!;
  if (question.selection === 'multiple') return null;
  if (question.selection === 'single' && question.choices.length > 0
    && question.choices.length <= NOTIFICATION_QUESTION_MAX_CHOICES) {
    const categoryId = [PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices1V1,
      PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices2V1, PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices3V1][question.choices.length - 1]!;
    return {
      descriptor: { kind: 'choices', questionKey: question.answerKey, values: question.choices.map(choice => choice.value) },
      body: [question.question, ...question.choices.map((choice, index) => {
        const text = [choice.label, choice.description]
          .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
          .map(part => part.replace(/\s+/gu, ' ').trim()).join(' — ');
        return `${index + 1}. ${text}`;
      })].join('\n'),
      categoryId,
    };
  }
  if (question.choices.length === 0 && question.allowCustom
    && !question.freeformMultiline && !question.freeformInitialValue) {
    return {
      descriptor: { kind: 'text', questionKey: question.answerKey,
        allowEmpty: !question.required || question.freeformAllowEmpty === true },
      body: question.question,
      categoryId: PUSH_NOTIFICATION_CATEGORY_IDS.questionTextV1,
    };
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
  let value: string;
  if (question.kind === 'text') {
    if (actionIdentifier !== PUSH_NOTIFICATION_ACTION_IDS.questionTextV1 || typeof userText !== 'string'
      || (!question.allowEmpty && !userText.trim())) return null;
    value = userText;
  } else {
    const index = [PUSH_NOTIFICATION_ACTION_IDS.questionChoice1V1, PUSH_NOTIFICATION_ACTION_IDS.questionChoice2V1,
      PUSH_NOTIFICATION_ACTION_IDS.questionChoice3V1].findIndex(id => id === actionIdentifier);
    const selected = question.values[index];
    if (selected === undefined) return null;
    value = selected;
  }
  // The incumbent answer carrier owns question-key/value limits and exact bytes.
  const answer = StructuredQuestionAnswersV1Schema.safeParse({ [question.questionKey]: [value] });
  return answer.success ? answer.data : null;
}
