import { describe, expect, it } from 'vitest';

import { buildCodexRequestUserInputAnswers } from './codexRequestUserInputQuestions';

describe('buildCodexRequestUserInputAnswers', () => {
    it.each(['__proto__', 'constructor', 'prototype'])('round-trips reserved question id %s as an own wire key', (id) => {
        const answersByKey = Object.create(null) as Record<string, readonly string[]>;
        answersByKey['Which value?'] = ['Exact'];
        const result = buildCodexRequestUserInputAnswers({
            questions: [{ id, question: 'Which value?' }],
            answersByKey,
        });

        expect(Object.getPrototypeOf(result)).toBeNull();
        expect(Object.prototype.hasOwnProperty.call(result, id)).toBe(true);
        expect(result[id]).toEqual({ answers: ['Exact'] });
        expect(JSON.parse(JSON.stringify(result))).toEqual({ [id]: { answers: ['Exact'] } });
    });
});
