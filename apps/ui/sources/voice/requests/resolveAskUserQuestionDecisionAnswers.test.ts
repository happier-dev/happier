import { describe, expect, it } from 'vitest';

import { resolveAskUserQuestionDecisionAnswers } from './resolveAskUserQuestionDecisionAnswers';

describe('resolveAskUserQuestionDecisionAnswers', () => {
    it.each(['AskUserQuestion', 'ask_user_question'] as const)('builds the same decision answers for %s', (tool) => {
        expect(resolveAskUserQuestionDecisionAnswers({
            tool,
            kind: 'user_action',
            arguments: {
                questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }],
            },
            createdAt: 1,
        } as any, 'allow')).toEqual([{ question: 'Continue?', values: ['Yes'] }]);
    });

    it.each(['AskUserQuestion', 'ask_user_question'] as const)(
        'matches human labels but submits exact canonical option values for %s',
        (tool) => {
            const request = {
                tool,
                kind: 'user_action',
                arguments: {
                    questions: [{
                        question: 'Continue?',
                        options: [
                            { value: '  allow,wire  ', choice: 'allow-choice', label: 'Yes, continue' },
                            { choice: 'deny-choice', label: 'No, stop' },
                        ],
                    }],
                },
                createdAt: 1,
            } as any;

            expect(resolveAskUserQuestionDecisionAnswers(request, 'allow'))
                .toEqual([{ question: 'Continue?', values: ['  allow,wire  '] }]);
            expect(resolveAskUserQuestionDecisionAnswers(request, 'deny'))
                .toEqual([{ question: 'Continue?', values: ['deny-choice'] }]);
        },
    );

    it('does not treat another user-action tool as AskUserQuestion', () => {
        expect(resolveAskUserQuestionDecisionAnswers({
            tool: 'ExitPlanMode',
            kind: 'user_action',
            arguments: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] },
            createdAt: 1,
        } as any, 'allow')).toBeNull();
    });

    it('preserves exact nonblank provider question-key bytes', () => {
        expect(resolveAskUserQuestionDecisionAnswers({
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: { questions: [{ question: '  Continue exactly?  ', options: [{ label: 'Yes' }, { label: 'No' }] }] },
            createdAt: 1,
        } as any, 'allow')).toEqual([{ question: '  Continue exactly?  ', values: ['Yes'] }]);
    });
});
