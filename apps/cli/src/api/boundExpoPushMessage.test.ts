import { describe, expect, it } from 'vitest';
import { boundExpoPushMessage } from './boundExpoPushMessage';

describe('inline question native payload budget', () => {
    it('keeps the complete choice mapping when it fits', () => {
        const message = { to: 'ExponentPushToken[token]', body: 'Which?\n1. Main\n2. Develop', categoryId: 'happier.questionChoices2.v1',
            data: { sessionId: 'session', questionAnswerV1: { kind: 'choices', questionKey: 'Which?', values: ['main', 'develop'] } } };
        expect(boundExpoPushMessage(message)).toEqual(message);
    });
    it('opens review instead of truncating away an offered choice mapping', () => {
        const result = boundExpoPushMessage({ to: 'ExponentPushToken[token]', body: 'Which?\n1. ' + 'long choice'.repeat(600),
            categoryId: 'happier.questionChoices1.v1', data: { sessionId: 'session', requestId: 'request', occurrenceId: 'occurrence',
                questionAnswerV1: { kind: 'choices', questionKey: 'Which?', values: ['value'] } } });
        expect(result.categoryId).toBe('happier.userActionRequest.v1');
        expect(result.data?.questionAnswerV1).toBeUndefined();
        expect(result.data).toMatchObject({ sessionId: 'session', requestId: 'request', occurrenceId: 'occurrence' });
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
    });
});
