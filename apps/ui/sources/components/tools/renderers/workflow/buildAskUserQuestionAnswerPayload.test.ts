import { describe, expect, it } from 'vitest';

import {
    buildAskUserQuestionAnswerPayload,
    normalizeAskUserQuestionRenderQuestions,
    tryBuildAskUserQuestionAnswerPayload,
} from './buildAskUserQuestionAnswerPayload';
import { STRUCTURED_QUESTION_LIMITS } from '@happier-dev/protocol';

const questions = [
    {
        question: 'Pick values',
        header: 'Values',
        multiSelect: true,
        options: [
            { label: 'A, B', description: '' },
            { label: 'C', description: '' },
        ],
    },
];

describe('buildAskUserQuestionAnswerPayload', () => {
    it('uses exact arrays on the modern method', () => {
        const result = buildAskUserQuestionAnswerPayload({
            questions,
            selections: new Map([[0, new Set([0, 1])]]),
            freeformAnswers: new Map(),
            structuredQuestionAnswersV1Supported: true,
        });

        expect(result).toEqual({
            kind: 'modern',
            send: {
                protocol: 'structured-question-v1',
                structuredAnswersV1: { 'Pick values': ['A, B', 'C'] },
            },
        });
    });

    it('blocks lossy legacy projection without changing the selected answer', () => {
        const result = buildAskUserQuestionAnswerPayload({
            questions,
            selections: new Map([[0, new Set([0, 1])]]),
            freeformAnswers: new Map(),
            structuredQuestionAnswersV1Supported: false,
        });

        expect(result).toEqual({ kind: 'requires_cli_update', unsafeQuestionKeys: ['Pick values'] });
    });

    it('allows a legacy answer only when the historical parser recovers the exact array', () => {
        const result = buildAskUserQuestionAnswerPayload({
            questions: [{ ...questions[0]!, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }],
            selections: new Map([[0, new Set([0, 1])]]),
            freeformAnswers: new Map(),
            structuredQuestionAnswersV1Supported: false,
        });

        expect(result).toEqual({
            kind: 'legacy',
            send: { protocol: 'legacy-permission', answers: { 'Pick values': 'A, B' } },
        });
    });

    it('submits canonical option values while leaving display labels independent', () => {
        const result = buildAskUserQuestionAnswerPayload({
            questions: [{
                ...questions[0]!,
                options: [
                    { value: '  wire,value  ', choice: 'choice-a', label: 'Human A', description: '' },
                    { choice: 'choice-b', label: 'Human B', description: '' },
                    { label: '  Human C  ', description: '' },
                ],
            }],
            selections: new Map([[0, new Set([0, 1, 2])]]),
            freeformAnswers: new Map(),
            structuredQuestionAnswersV1Supported: true,
        });

        expect(result).toEqual({
            kind: 'modern',
            send: {
                protocol: 'structured-question-v1',
                structuredAnswersV1: {
                    'Pick values': ['  wire,value  ', 'choice-b', '  Human C  '],
                },
            },
        });
    });

    it.each(['  opaque  ', 'opaque,wire'])(
        'blocks legacy projection when the canonical value %j cannot round-trip exactly',
        (value) => {
            const result = buildAskUserQuestionAnswerPayload({
                questions: [{
                    ...questions[0]!,
                    options: [{ value, label: 'Safe display', description: '' }],
                }],
                selections: new Map([[0, new Set([0])]]),
                freeformAnswers: new Map(),
                structuredQuestionAnswersV1Supported: false,
            });

            expect(result).toEqual({ kind: 'requires_cli_update', unsafeQuestionKeys: ['Pick values'] });
        },
    );

    it('preserves reserved question keys without changing the record prototype', () => {
        const result = buildAskUserQuestionAnswerPayload({
            questions: [{ ...questions[0]!, question: '__proto__', options: [{ label: 'safe', description: '' }] }],
            selections: new Map([[0, new Set([0])]]),
            freeformAnswers: new Map(),
            structuredQuestionAnswersV1Supported: true,
        });

        expect(result.kind).toBe('modern');
        if (result.kind !== 'modern') return;
        expect(Object.getPrototypeOf(result.send.structuredAnswersV1)).toBeNull();
        expect(result.send.structuredAnswersV1.__proto__).toEqual(['safe']);
    });

    it('exposes a non-throwing prospective-build result for malformed older-CLI questions', () => {
        const result = tryBuildAskUserQuestionAnswerPayload({
            questions: [{ header: 'Header only', options: [{ label: 'A' }], multiSelect: false }],
            selections: new Map([[0, new Set([0])]]),
            freeformAnswers: new Map(),
            structuredQuestionAnswersV1Supported: true,
        });
        expect(result).toEqual({ ok: true, payload: expect.objectContaining({ kind: 'modern' }) });

        const invalid = tryBuildAskUserQuestionAnswerPayload({
            questions: [{ question: ' ', header: ' ', options: [{ label: 'A' }], multiSelect: false }],
            selections: new Map([[0, new Set([0])]]),
            freeformAnswers: new Map(),
            structuredQuestionAnswersV1Supported: true,
        });
        expect(invalid).toEqual({ ok: false });
    });

    it('rejects malformed persisted option entries before render can dereference them', () => {
        expect(normalizeAskUserQuestionRenderQuestions({
            questions: [{ question: 'Pick one', header: 'Pick', options: [null], multiSelect: false }],
        })).toEqual({ ok: false });
    });

    it('accepts one question whose provider id equals its response key', () => {
        expect(normalizeAskUserQuestionRenderQuestions({
            questions: [{
                id: 'Pick one',
                question: 'Pick one',
                header: 'Pick',
                options: [{ label: 'A' }],
                multiSelect: false,
            }],
        })).toEqual({
            ok: true,
            questions: [{
                question: 'Pick one',
                header: 'Pick',
                options: [{ label: 'A' }],
                multiSelect: false,
            }],
        });
    });

    it('still rejects a key collision between distinct questions', () => {
        expect(normalizeAskUserQuestionRenderQuestions({
            questions: [
                { id: 'shared', question: 'First', options: [{ label: 'A' }], multiSelect: false },
                { id: 'shared', question: 'Second', options: [{ label: 'B' }], multiSelect: false },
            ],
        })).toEqual({ ok: false });
    });

    it('rejects oversized persisted question collections before rendering them', () => {
        expect(normalizeAskUserQuestionRenderQuestions({
            questions: Array.from(
                { length: STRUCTURED_QUESTION_LIMITS.maxQuestions + 1 },
                (_, index) => ({ question: `Question ${index}`, header: `Q${index}`, options: [], multiSelect: false }),
            ),
        })).toEqual({ ok: false });
    });
});
