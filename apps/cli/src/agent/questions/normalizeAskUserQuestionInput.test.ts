import { describe, expect, it } from 'vitest';
import { STRUCTURED_QUESTION_LIMITS } from '@happier-dev/protocol';

import {
    InvalidAskUserQuestionInputError,
    normalizeAskUserQuestionInputForPublication,
} from './normalizeAskUserQuestionInput';

const providerShapes = [
    { questions: [{ header: 'Claude', question: 'Choose?', multiSelect: false, options: [{ label: 'A', description: 'a' }] }] },
    { questions: [{ header: 'Codex', question: 'Choose?', multiSelect: false, options: [{ label: 'A', description: 'a' }], freeform: { placeholder: 'Other' } }] },
    { questions: [{ id: 'cursor-id', header: 'Cursor', question: 'Choose?', multiSelect: true, options: [{ label: 'A', description: 'a' }] }] },
    { questions: [{ header: 'OpenCode', question: 'Choose?', multiple: false, options: [{ label: 'A', description: 'a' }], locations: [] }] },
    { _grokCorrelation: { v: 1, digest: 'a'.repeat(64) }, questions: [{ id: 'grok-id', header: 'Question', question: 'Choose?', multiSelect: false, options: [{ label: 'A', description: 'a' }] }] },
    { questions: [{ id: 'freeform', question: 'Type a value', freeform: true }] },
    { questions: [
        { header: 'Question', question: 'First?', options: [{ label: 'A' }] },
        { header: 'Question', question: 'Second?', options: [{ label: 'B' }] },
    ] },
] as const;

describe('normalizeAskUserQuestionInputForPublication', () => {
    it.each(providerShapes)('preserves a bounded provider shape exactly in a detached snapshot', (input) => {
        const pascal = normalizeAskUserQuestionInputForPublication('AskUserQuestion', input);
        const snake = normalizeAskUserQuestionInputForPublication('ask_user_question', input);
        expect(pascal).toEqual(input);
        expect(snake).toEqual(input);
        expect(pascal).not.toBe(input);
        expect(snake).not.toBe(input);
    });

    it.each([
        null,
        [],
        'question',
        {},
        { questions: [] },
        { questions: Array.from({ length: STRUCTURED_QUESTION_LIMITS.maxQuestions + 1 }, () => ({ question: 'q', options: [] })) },
        { questions: [{ question: 'q', options: Array.from({ length: STRUCTURED_QUESTION_LIMITS.maxOptionsPerQuestion + 1 }, () => 'a') }] },
        { questions: [{ question: 'x'.repeat(STRUCTURED_QUESTION_LIMITS.maxStringLength + 1), options: [] }] },
        { questions: [{ options: [] }] },
        { questions: [{ question: 'q', options: [42] }] },
        { questions: [{ question: 'q', options: [{}] }] },
        { questions: [{ question: 'q', options: [{ label: '   ' }] }] },
        { questions: [{ question: 'q', options: [] }], callback: () => {} },
        { questions: [{ question: 'q', options: [] }], invalidNumber: Number.NaN },
        { questions: [
            { id: 'duplicate', question: 'First?', options: [] },
            { id: 'duplicate', question: 'Second?', options: [] },
        ] },
    ])('rejects malformed or oversized AskUserQuestion input before publication', (input) => {
        expect(() => normalizeAskUserQuestionInputForPublication('AskUserQuestion', input))
            .toThrow(InvalidAskUserQuestionInputError);
    });

    it('rejects aggregate input overflow when every individual string is within its limit', () => {
        const boundedChunk = 'x'.repeat(16_000);
        const input = {
            questions: [{
                question: 'q',
                options: Array.from({ length: 17 }, (_, index) => ({
                    label: `option-${index}`,
                    description: boundedChunk,
                })),
            }],
        };

        expect(boundedChunk.length).toBeLessThanOrEqual(STRUCTURED_QUESTION_LIMITS.maxStringLength);
        expect(() => normalizeAskUserQuestionInputForPublication('AskUserQuestion', input))
            .toThrow(InvalidAskUserQuestionInputError);
    });

    it('rejects cyclic question input without traversing forever', () => {
        const question: Record<string, unknown> = { question: 'q', options: [] };
        question.self = question;
        expect(() => normalizeAskUserQuestionInputForPublication('AskUserQuestion', { questions: [question] }))
            .toThrow(InvalidAskUserQuestionInputError);
    });

    it('rejects array properties that JSON serialization would silently drop', () => {
        const options: unknown[] = [{ label: 'A' }];
        Object.defineProperty(options, '4294967295', {
            value: { label: 'hidden-extra' },
            enumerable: true,
        });

        expect(() => normalizeAskUserQuestionInputForPublication('AskUserQuestion', {
            questions: [{ question: 'Choose?', options }],
        })).toThrow(InvalidAskUserQuestionInputError);
    });

    it('returns a detached JSON-safe snapshot that caller mutation cannot change', () => {
        const input = {
            provider: { correlation: 'original' },
            questions: [{
                id: 'question-1',
                question: 'Original?',
                options: [{ label: 'Original', description: 'original description' }],
            }],
        };

        const normalized = normalizeAskUserQuestionInputForPublication('AskUserQuestion', input) as typeof input;
        input.provider.correlation = 'mutated';
        input.questions[0]!.question = 'Mutated?';
        input.questions[0]!.options[0]!.label = 'Mutated';

        expect(normalized).toEqual({
            provider: { correlation: 'original' },
            questions: [{
                id: 'question-1',
                question: 'Original?',
                options: [{ label: 'Original', description: 'original description' }],
            }],
        });
    });

    it('does not inspect or alter ordinary permission inputs', () => {
        const cyclic: Record<string, unknown> = { command: 'echo hi' };
        cyclic.self = cyclic;
        expect(normalizeAskUserQuestionInputForPublication('Bash', cyclic)).toBe(cyclic);
    });
});
