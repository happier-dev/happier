import type {
  InteractionTransientAuthorQuestionV1,
  InteractionTransientQuestionAnswerV1,
  InteractionTransientQuestionsResultV1,
} from '@happier-dev/plugin-sdk/interactions';

import type { CursorAskQuestionRequest } from './schemas.js';

export function buildCursorHostQuestions(
  request: CursorAskQuestionRequest,
): [InteractionTransientAuthorQuestionV1, ...InteractionTransientAuthorQuestionV1[]] {
  const questions = request.questions.map((question): InteractionTransientAuthorQuestionV1 => {
    const options = question.options ?? [];
    if (options.length === 0) {
      return Object.freeze({
        id: question.id,
        prompt: question.prompt,
        type: 'text',
      });
    }
    const choices = options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.label,
    })) as [
      Readonly<{ id: string; label: string; description: string }>,
      ...Readonly<{ id: string; label: string; description: string }>[],
    ];
    return {
      id: question.id,
      prompt: question.prompt,
      type: question.allowMultiple === true ? 'multipleChoice' : 'singleChoice',
      choices,
    };
  });
  return questions as [InteractionTransientAuthorQuestionV1, ...InteractionTransientAuthorQuestionV1[]];
}

function readCursorAnswerValues(answer: InteractionTransientQuestionAnswerV1): readonly string[] {
  if (answer.kind === 'text') {
    return answer.value.length > 0 ? Object.freeze([answer.value]) : Object.freeze([]);
  }
  if (answer.kind === 'singleChoice') {
    return Object.freeze([
      answer.answer.kind === 'choice' ? answer.answer.choiceId : answer.answer.value,
    ]);
  }
  return Object.freeze(answer.answers.map((item) =>
    item.kind === 'choice' ? item.choiceId : item.value));
}

export function buildCursorQuestionAnswers(
  request: CursorAskQuestionRequest,
  result: Extract<InteractionTransientQuestionsResultV1, { status: 'answered' }>,
): readonly Readonly<{ questionId: string; selectedOptionIds: readonly string[] }>[] {
  return Object.freeze(request.questions.flatMap((question) => {
    const answer = result.answers[question.id];
    if (!answer) return [];
    const selectedOptionIds = readCursorAnswerValues(answer);
    return selectedOptionIds.length > 0
      ? [Object.freeze({ questionId: question.id, selectedOptionIds })]
      : [];
  }));
}
