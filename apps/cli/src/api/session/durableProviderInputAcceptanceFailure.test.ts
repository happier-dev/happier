import { describe, expect, it } from 'vitest';
import { HttpStatusError } from '@/api/client/httpStatusError';
import { readDurableProviderInputAcceptanceFailure } from './durableProviderInputAcceptanceFailure';

describe('durable provider-input acceptance failure classification', () => {
    it.each([400, 401, 403, 404, 414, 422, 429])('preserves a transport refusal as a typed failure (%s)', status => {
        // Real message-not-found responses are handled by the transcript lookup
        // before this owner; an unrecognized HTTP404 is a refused lookup.
        const failure = new HttpStatusError(status, 'Acceptance lookup refused');
        expect(() => readDurableProviderInputAcceptanceFailure(failure)).toThrow(expect.objectContaining({
            name: 'HttpStatusError', response: { status },
        }));
    });

    it.each([new Error('Disconnected'), new HttpStatusError(503, 'Unavailable')])('keeps unavailable evidence unknown', failure => {
        expect(readDurableProviderInputAcceptanceFailure(failure)).toBe('unknown');
    });
});
