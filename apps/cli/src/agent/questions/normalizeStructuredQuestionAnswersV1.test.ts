import { describe, expect, it } from 'vitest';

import { PUBLIC_RPC_HANDLER_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import {
    normalizeLegacyStructuredQuestionAnswers,
    normalizeStructuredQuestionAnswersV1,
} from './normalizeStructuredQuestionAnswersV1';

describe('normalizeLegacyStructuredQuestionAnswers', () => {
    function expectPublicCode(run: () => unknown, rpcErrorCode: string): void {
        try {
            run();
            throw new Error('expected structured question normalization to fail');
        } catch (error) {
            expect(error).toMatchObject({ rpcErrorCode });
        }
    }

    it('recovers a unique comma-bearing option decomposition', () => {
        const result = normalizeLegacyStructuredQuestionAnswers({
            answers: { q: 'A, B, C' },
            questions: [{ question: 'q', multiSelect: true, options: [{ label: 'A, B' }, { label: 'C' }] }],
        });
        expect(result.q).toEqual(['A, B', 'C']);
    });

    it('recovers a unique seven-option answer without exhausting the bounded decoder', () => {
        const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
        const result = normalizeLegacyStructuredQuestionAnswers({
            answers: { q: labels.join(', ') },
            questions: [{
                question: 'q',
                multiSelect: true,
                options: labels.map((label) => ({ label })),
            }],
        });

        expect(result.q).toEqual(labels);
    });

    it('still fails closed for an ambiguous seven-option encoded answer', () => {
        expectPublicCode(() => normalizeLegacyStructuredQuestionAnswers({
            answers: { q: 'A, B, C, D, E, F, G' },
            questions: [{
                question: 'q',
                multiSelect: true,
                options: [
                    { label: 'A' },
                    { label: 'B' },
                    { label: 'A, B' },
                    { label: 'C' },
                    { label: 'D' },
                    { label: 'E' },
                    { label: 'F' },
                    { label: 'G' },
                ],
            }],
        }), PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_AMBIGUOUS);
    });

    it('fails closed when two option decompositions serialize identically', () => {
        expectPublicCode(() => normalizeLegacyStructuredQuestionAnswers({
            answers: { q: 'A, B, C' },
            questions: [{
                question: 'q',
                multiSelect: true,
                options: [{ label: 'A, B' }, { label: 'C' }, { label: 'A' }, { label: 'B, C' }],
            }],
        }), PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_AMBIGUOUS);
    });

    it('fails closed when freeform and option candidates collide', () => {
        expectPublicCode(() => normalizeLegacyStructuredQuestionAnswers({
            answers: { q: 'A, B' },
            questions: [{
                question: 'q',
                multiSelect: true,
                freeform: {},
                options: [{ label: 'A' }, { label: 'B' }],
            }],
        }), PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_AMBIGUOUS);
    });

    it('rejects missing legacy values before completion', () => {
        const answers = JSON.parse('{"__proto__":"safe"}');
        expectPublicCode(() => normalizeLegacyStructuredQuestionAnswers({
            answers,
            questions: [{ question: '__proto__', multiSelect: false, options: [{ label: 'safe' }] }, { question: 'missing', options: [] }],
        }), PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID);
    });

    it('preserves reserved legacy question keys in a null-prototype answer record', () => {
        const result = normalizeLegacyStructuredQuestionAnswers({
            answers: JSON.parse('{"__proto__":"safe"}'),
            questions: [{ question: '__proto__', multiSelect: false, options: [{ label: 'safe' }] }],
        });
        expect(Object.getPrototypeOf(result)).toBeNull();
        expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
        expect(result.__proto__).toEqual(['safe']);
    });

    it.each([null, [], 'q=a', 42])('returns the typed legacy error for a malformed answer map: %j', (answers) => {
        expectPublicCode(() => normalizeLegacyStructuredQuestionAnswers({
            answers,
            questions: [{ question: 'q', options: [{ label: 'a' }] }],
        }), PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID);
    });

    it('rejects whitespace-only legacy freeform answers while preserving exact surrounding whitespace', () => {
        expectPublicCode(() => normalizeLegacyStructuredQuestionAnswers({
            answers: { q: '   ' },
            questions: [{ question: 'q', options: [], freeform: {} }],
        }), PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID);

        expect(normalizeLegacyStructuredQuestionAnswers({
            answers: { q: '  exact value  ' },
            questions: [{ question: 'q', options: [], freeform: {} }],
        })).toEqual({ q: ['  exact value  '] });
    });

});

describe('normalizeStructuredQuestionAnswersV1', () => {
    function expectModernFailure(answers: unknown): void {
        try {
            normalizeStructuredQuestionAnswersV1(
                answers,
                [{
                    id: 'scope',
                    question: 'Which scope?',
                    multiSelect: false,
                    options: [{ label: 'Workspace' }, { label: 'Session' }],
                }],
            );
            throw new Error('expected structured question normalization to fail');
        } catch (error) {
            expect(error).toMatchObject({
                rpcErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID,
            });
        }
    }

    it.each([
        {},
        { scope: [] },
        { scope: ['Unknown'] },
        { scope: ['Workspace'], unexpected: ['Session'] },
        { scope: ['Workspace'], 'Which scope?': ['Session'] },
        { scope: ['Workspace', 'Session'] },
    ])('rejects answers that do not satisfy the advertised question contract: %o', (answers) => {
        expectModernFailure(answers);
    });

    it('preserves exact option arrays, comma-bearing freeform, and the submitted correlation key', () => {
        const optionResult = normalizeStructuredQuestionAnswersV1(
            { scope: ['Workspace'] },
            [{
                id: 'scope',
                question: 'Which scope?',
                multiSelect: false,
                options: [{ label: 'Workspace' }],
            }],
        );
        expect(Object.getPrototypeOf(optionResult)).toBeNull();
        expect(optionResult).toEqual({ scope: ['Workspace'] });

        const freeformResult = normalizeStructuredQuestionAnswersV1(
            { 'Describe it': ['Custom value, with commas'] },
            [{
                question: 'Describe it',
                multiSelect: false,
                options: [{ label: 'Preset' }],
                freeform: {},
            }],
        );
        expect(freeformResult).toEqual({ 'Describe it': ['Custom value, with commas'] });
    });

    it('rejects whitespace-only modern freeform answers while preserving exact nonblank values', () => {
        expect(() => normalizeStructuredQuestionAnswersV1(
            { q: ['   '] },
            [{ question: 'q', options: [], freeform: {} }],
        )).toThrow(expect.objectContaining({
            rpcErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID,
        }));

        expect(normalizeStructuredQuestionAnswersV1(
            { q: ['  exact value  '] },
            [{ question: 'q', options: [], freeform: {} }],
        )).toEqual({ q: ['  exact value  '] });
    });

    it.each([
        [{ id: '   ', question: '', header: '', options: [{ label: 'A' }] }, { '   ': ['A'] }],
        [{ question: '   ', header: '   ', options: [{ label: 'A' }] }, { '   ': ['A'] }],
        [{ question: 'q', options: [{ label: '   ' }] }, { q: ['   '] }],
    ])('rejects whitespace-only question identifiers, fallback headers, and option values', (question, answers) => {
        expect(() => normalizeStructuredQuestionAnswersV1(answers, [question])).toThrow(expect.objectContaining({
            rpcErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID,
        }));
    });

    it('preserves surrounding whitespace in a genuinely nonempty advertised option', () => {
        expect(normalizeStructuredQuestionAnswersV1(
            { q: ['  Workspace  '] },
            [{ question: 'q', options: [{ label: '  Workspace  ' }] }],
        )).toEqual({ q: ['  Workspace  '] });
    });

    it('validates distinct option value, choice, and label fields using canonical wire precedence', () => {
        const questions = [{
            question: 'q',
            multiSelect: true,
            options: [
                { value: '  wire,value  ', choice: 'choice-a', label: 'Human A' },
                { value: ' ', choice: 'choice-b', label: 'Human B' },
                { value: '', choice: '', label: '  Human C  ' },
            ],
        }];

        expect(normalizeStructuredQuestionAnswersV1(
            { q: ['  wire,value  ', 'choice-b', '  Human C  '] },
            questions,
        )).toEqual({ q: ['  wire,value  ', 'choice-b', '  Human C  '] });

        expect(() => normalizeStructuredQuestionAnswersV1(
            { q: ['Human A'] },
            questions,
        )).toThrow(expect.objectContaining({
            rpcErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID,
        }));
    });

    it('accepts multiple questions that share a display header while using distinct canonical response keys', () => {
        const result = normalizeStructuredQuestionAnswersV1(
            { first: ['A'], 'Second question?': ['B'] },
            [
                {
                    id: 'first',
                    header: 'Question',
                    question: 'First question?',
                    multiSelect: false,
                    options: [{ label: 'A' }],
                },
                {
                    id: 'second',
                    header: 'Question',
                    question: 'Second question?',
                    multiSelect: false,
                    options: [{ label: 'B' }],
                },
            ],
        );
        expect(result).toEqual({ first: ['A'], 'Second question?': ['B'] });
    });

    it('uses the header key when question text is only whitespace, matching the canonical UI producer', () => {
        const result = normalizeStructuredQuestionAnswersV1(
            { Header: ['A'] },
            [{
                header: 'Header',
                question: '   ',
                multiSelect: false,
                options: [{ label: 'A' }],
            }],
        );
        expect(result).toEqual({ Header: ['A'] });
    });

    it('rejects an id that aliases another question canonical response key', () => {
        try {
            normalizeStructuredQuestionAnswersV1(
                { 'Second question?': ['A'], second: ['B'] },
                [
                    {
                        id: 'Second question?',
                        question: 'First question?',
                        multiSelect: false,
                        options: [{ label: 'A' }],
                    },
                    {
                        id: 'second',
                        question: 'Second question?',
                        multiSelect: false,
                        options: [{ label: 'B' }],
                    },
                ],
            );
            throw new Error('expected overlapping question aliases to fail');
        } catch (error) {
            expect(error).toMatchObject({
                rpcErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID,
            });
        }
    });
});
