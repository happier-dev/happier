import { describe, expect, it } from 'vitest';

import {
    normalizeAskUserQuestionAnswers,
    withAskUserQuestionUiFreeformDefault,
} from './askUserQuestion.js';

describe('Claude AskUserQuestion permissions helpers', () => {
    it('injects freeform defaults on every question when absent', () => {
        const input = {
            questions: [
                { header: 'A', question: 'pick', multiSelect: false, options: [{ label: 'x' }] },
                { header: 'B', question: 'pick b', multiSelect: true, options: [{ label: 'y' }] },
            ],
        };
        const out = withAskUserQuestionUiFreeformDefault('AskUserQuestion', input);

        expect(out).toEqual({
            questions: [
                { header: 'A', question: 'pick', multiSelect: false, options: [{ label: 'x' }], freeform: {} },
                { header: 'B', question: 'pick b', multiSelect: true, options: [{ label: 'y' }], freeform: {} },
            ],
        });
        expect(input.questions[0]?.freeform).toBeUndefined();
        expect(input.questions[1]?.freeform).toBeUndefined();
    });

    it('preserves existing freeform fields', () => {
        const input = {
            questions: [
                { header: 'A', question: 'pick', multiSelect: false, options: [], freeform: { placeholder: 'custom' } },
            ],
        };

        expect(withAskUserQuestionUiFreeformDefault('AskUserQuestion', input)).toBe(input);
    });

    it('handles the snake_case tool name alias', () => {
        const input = { questions: [{ header: 'H', question: 'Q', multiSelect: false, options: [] }] };

        expect(withAskUserQuestionUiFreeformDefault('ask_user_question', input)).toEqual({
            questions: [{ header: 'H', question: 'Q', multiSelect: false, options: [], freeform: {} }],
        });
    });

    it('leaves unrelated or unsupported inputs unchanged', () => {
        const commandInput = { command: 'ls' };
        const malformedQuestions = { questions: 'bad' };

        expect(withAskUserQuestionUiFreeformDefault('Bash', commandInput)).toBe(commandInput);
        expect(withAskUserQuestionUiFreeformDefault('AskUserQuestion', null)).toBe(null);
        expect(withAskUserQuestionUiFreeformDefault('AskUserQuestion', 'str')).toBe('str');
        expect(withAskUserQuestionUiFreeformDefault('AskUserQuestion', {})).toEqual({});
        expect(withAskUserQuestionUiFreeformDefault('AskUserQuestion', malformedQuestions)).toBe(malformedQuestions);
    });

    it('skips non-object questions while updating valid ones', () => {
        const input = { questions: [null, { header: 'A', question: 'Q', multiSelect: false, options: [] }, 42] };

        expect(withAskUserQuestionUiFreeformDefault('AskUserQuestion', input)).toEqual({
            questions: [null, { header: 'A', question: 'Q', multiSelect: false, options: [], freeform: {} }, 42],
        });
    });

    it('normalizes string answers only', () => {
        expect(normalizeAskUserQuestionAnswers({
            'Question A': 'Answer A',
            'Question B': 123,
            '': 'blank',
        })).toEqual({ 'Question A': 'Answer A' });
        expect(normalizeAskUserQuestionAnswers({})).toBeNull();
        expect(normalizeAskUserQuestionAnswers(null)).toBeNull();
    });
});
