import type {
  PluginUiQuestion,
  PluginUiQuestionAnswer,
  PluginUiQuestionsResult,
} from '@happier-dev/plugin-sdk/runtime';

import type { CursorAskQuestionRequest } from './schemas.js';

export function buildCursorHostQuestions(
  request: CursorAskQuestionRequest,
): readonly [PluginUiQuestion, ...PluginUiQuestion[]] {
  const questions = request.questions.map((question): PluginUiQuestion => {
    const options = question.options ?? [];
    if (options.length === 0) {
      return Object.freeze({
        id: question.id,
        prompt: question.prompt,
        type: 'text',
      });
    }
    const choices = options.map((option) => Object.freeze({
      id: option.id,
      label: option.label,
      description: option.label,
    })) as [
      Readonly<{ id: string; label: string; description: string }>,
      ...Readonly<{ id: string; label: string; description: string }>[],
    ];
    return Object.freeze({
      id: question.id,
      prompt: question.prompt,
      type: question.allowMultiple === true ? 'multiple' : 'single',
      choices: Object.freeze(choices),
    });
  });
  return Object.freeze(questions) as [PluginUiQuestion, ...PluginUiQuestion[]];
}

function readCursorAnswerValues(answer: PluginUiQuestionAnswer): readonly string[] {
  if (answer.type === 'text') {
    return answer.value.length > 0 ? Object.freeze([answer.value]) : Object.freeze([]);
  }
  if (answer.type === 'single') {
    return Object.freeze([
      answer.answer.type === 'choice' ? answer.answer.choiceId : answer.answer.value,
    ]);
  }
  return Object.freeze(answer.answers.map((item) =>
    item.type === 'choice' ? item.choiceId : item.value));
}

export function buildCursorQuestionAnswers(
  request: CursorAskQuestionRequest,
  result: Extract<PluginUiQuestionsResult, { status: 'answered' }>,
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
