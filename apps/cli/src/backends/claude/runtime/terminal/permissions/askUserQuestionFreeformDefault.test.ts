import { describe, expect, it } from 'vitest';

import { withAskUserQuestionUiFreeformDefault } from './askUserQuestionFreeformDefault';

describe('withAskUserQuestionUiFreeformDefault', () => {
    it('injects freeform: {} on every question when absent', () => {
        const input = {
            questions: [
                { header: 'A', question: 'pick', multiSelect: false, options: [{ label: 'x' }] },
                { header: 'B', question: 'pick b', multiSelect: true, options: [{ label: 'y' }] },
            ],
        };
        const out = withAskUserQuestionUiFreeformDefault('AskUserQuestion', input) as any;
        expect(out.questions[0].freeform).toEqual({});
        expect(out.questions[1].freeform).toEqual({});
        // Original untouched
        expect((input.questions[0] as any).freeform).toBeUndefined();
        expect((input.questions[1] as any).freeform).toBeUndefined();
    });

    it('preserves existing freeform field when present', () => {
        const input = {
            questions: [
                { header: 'A', question: 'pick', multiSelect: false, options: [], freeform: { placeholder: 'custom' } },
            ],
        };
        const out = withAskUserQuestionUiFreeformDefault('AskUserQuestion', input) as any;
        expect(out.questions[0].freeform).toEqual({ placeholder: 'custom' });
    });

    it('handles snake_case tool name alias', () => {
        const input = { questions: [{ header: 'H', question: 'Q', multiSelect: false, options: [] }] };
        const out = withAskUserQuestionUiFreeformDefault('ask_user_question', input) as any;
        expect(out.questions[0].freeform).toEqual({});
    });

    it('is a no-op for non-AskUserQuestion tools', () => {
        const input = { command: 'ls' };
        expect(withAskUserQuestionUiFreeformDefault('Bash', input)).toBe(input);
    });

    it('is a no-op when input is not an object', () => {
        expect(withAskUserQuestionUiFreeformDefault('AskUserQuestion', null)).toBe(null);
        expect(withAskUserQuestionUiFreeformDefault('AskUserQuestion', 'str')).toBe('str');
    });

    it('is a no-op when questions is missing or not an array', () => {
        expect(withAskUserQuestionUiFreeformDefault('AskUserQuestion', {})).toEqual({});
        const input = { questions: 'bad' };
        expect(withAskUserQuestionUiFreeformDefault('AskUserQuestion', input)).toBe(input);
    });

    it('skips non-object questions while mutating valid ones', () => {
        const input = { questions: [null, { header: 'A', question: 'Q', multiSelect: false, options: [] }, 42] };
        const out = withAskUserQuestionUiFreeformDefault('AskUserQuestion', input) as any;
        expect(out.questions[0]).toBeNull();
        expect(out.questions[1].freeform).toEqual({});
        expect(out.questions[2]).toBe(42);
    });

    it('returns the original object reference when nothing changed (no mutation required)', () => {
        const input = {
            questions: [
                { header: 'A', question: 'pick', multiSelect: false, options: [], freeform: {} },
            ],
        };
        expect(withAskUserQuestionUiFreeformDefault('AskUserQuestion', input)).toBe(input);
    });
});
