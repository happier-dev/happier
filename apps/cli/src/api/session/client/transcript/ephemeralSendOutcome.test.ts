import { describe, expect, it } from 'vitest';

import { normalizeEphemeralSendOutcome, serializeEphemeralSendError } from './ephemeralSendOutcome';

describe('ephemeral send outcome diagnostics', () => {
    it.each([
        { accepted: true },
        { accepted: true, epoch: Number.NaN },
        { accepted: true, epoch: Number.POSITIVE_INFINITY },
    ])('fails closed for a malformed accepted outcome %#', (outcome) => {
        expect(normalizeEphemeralSendOutcome(outcome, 9)).toMatchObject({
            accepted: false,
            epoch: 9,
            reason: 'transport_unavailable',
        });
    });

    it('serializes hostile thrown values without letting diagnostic getters escape', () => {
        const hostile = Object.defineProperties({}, {
            name: { get: () => { throw new Error('name getter escaped'); } },
            message: { get: () => { throw new Error('message getter escaped'); } },
            stack: { get: () => { throw new Error('stack getter escaped'); } },
            code: { get: () => { throw new Error('code getter escaped'); } },
            cause: { get: () => { throw new Error('cause getter escaped'); } },
        });

        expect(() => serializeEphemeralSendError(hostile)).not.toThrow();
        expect(serializeEphemeralSendError(hostile)).toMatchObject({
            name: 'Error',
            message: expect.any(String),
        });
    });
});
