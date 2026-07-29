import { describe, expect, it } from 'vitest';

import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

import { resolveAskUserQuestionDecisionAnswers } from './resolveAskUserQuestionDecisionAnswers';

function makeRequest(tool: string): PendingPermissionRequest {
  return {
    id: 'req_1',
    tool,
    kind: 'user_action',
    createdAt: 0,
    arguments: {
      questions: [
        {
          question: 'Proceed with deploy?',
          options: [{ label: 'Yes, deploy' }, { label: 'No, cancel' }],
        },
      ],
    },
  };
}

describe('resolveAskUserQuestionDecisionAnswers tool-name matching', () => {
  it('matches the canonical PascalCase AskUserQuestion tool name', () => {
    const answers = resolveAskUserQuestionDecisionAnswers(makeRequest('AskUserQuestion'), 'allow');
    expect(answers).toEqual([{ question: 'Proceed with deploy?', values: ['Yes, deploy'] }]);
  });

  it('matches the snake_case ask_user_question tool name via the canonical helper', () => {
    const answers = resolveAskUserQuestionDecisionAnswers(makeRequest('ask_user_question'), 'allow');
    expect(answers).toEqual([{ question: 'Proceed with deploy?', values: ['Yes, deploy'] }]);
  });

  it('matches case-insensitively', () => {
    const answers = resolveAskUserQuestionDecisionAnswers(makeRequest('askuserquestion'), 'deny');
    expect(answers).toEqual([{ question: 'Proceed with deploy?', values: ['No, cancel'] }]);
  });

  it('returns null for unrelated tools', () => {
    expect(resolveAskUserQuestionDecisionAnswers(makeRequest('write'), 'allow')).toBeNull();
  });
});
