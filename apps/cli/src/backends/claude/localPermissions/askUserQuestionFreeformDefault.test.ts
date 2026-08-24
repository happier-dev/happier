import { describe, expect, it } from 'vitest';

import { normalizeClaudeAskUserQuestionInputForPublication } from '../utils/normalizeClaudeAskUserQuestionInput';

describe('normalizeClaudeAskUserQuestionInputForPublication', () => {
    it('injects freeform: {} on every question when absent', () => {
        const input = {
            questions: [
                { header: 'A', question: 'pick', multiSelect: false, options: [{ label: 'x' }] },
                { header: 'B', question: 'pick b', multiSelect: true, options: [{ label: 'y' }] },
            ],
        };
        const out = normalizeClaudeAskUserQuestionInputForPublication('AskUserQuestion', input) as any;
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
        const out = normalizeClaudeAskUserQuestionInputForPublication('AskUserQuestion', input) as any;
        expect(out.questions[0].freeform).toEqual({ placeholder: 'custom' });
    });

    it('handles snake_case tool name alias', () => {
        const input = { questions: [{ header: 'H', question: 'Q', multiSelect: false, options: [] }] };
        const out = normalizeClaudeAskUserQuestionInputForPublication('ask_user_question', input) as any;
        expect(out.questions[0].freeform).toEqual({});
    });

    it('is a no-op for non-AskUserQuestion tools', () => {
        const input = { command: 'ls' };
        expect(normalizeClaudeAskUserQuestionInputForPublication('Bash', input)).toBe(input);
    });

    it('rejects malformed AskUserQuestion input through the shared publication validator', () => {
        expect(() => normalizeClaudeAskUserQuestionInputForPublication('AskUserQuestion', null)).toThrow();
        expect(() => normalizeClaudeAskUserQuestionInputForPublication('AskUserQuestion', 'str')).toThrow();
        expect(() => normalizeClaudeAskUserQuestionInputForPublication('AskUserQuestion', {})).toThrow();
        expect(() => normalizeClaudeAskUserQuestionInputForPublication('AskUserQuestion', { questions: 'bad' })).toThrow();
    });

    it('rejects malformed question descriptors through the shared publication validator', () => {
        const input = { questions: [null, { header: 'A', question: 'Q', multiSelect: false, options: [] }, 42] };
        expect(() => normalizeClaudeAskUserQuestionInputForPublication('AskUserQuestion', input)).toThrow();
    });

    it('preserves an existing freeform field in the bounded publication snapshot', () => {
        const input = {
            questions: [
                { header: 'A', question: 'pick', multiSelect: false, options: [], freeform: {} },
            ],
        };
        expect(normalizeClaudeAskUserQuestionInputForPublication('AskUserQuestion', input)).toEqual(input);
    });
});
