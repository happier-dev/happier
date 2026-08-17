import { describe, expect, it } from 'vitest';

import { ChangesResponseSchema } from './index.js';

describe('Session access change witness', () => {
    it('accepts a cursor-bounded current-access witness while retaining the older response shape', () => {
        const base = {
            changes: [
                {
                    cursor: 17,
                    kind: 'session',
                    entityId: 'session-removed',
                    changedAt: 17,
                    hint: null,
                },
            ],
            nextCursor: 17,
        } as const;

        expect(ChangesResponseSchema.safeParse({
            ...base,
            sessionAccessWitness: {
                v: 1,
                throughCursor: 17,
                entries: [{
                    sessionId: 'session-removed',
                    cursor: 17,
                    status: 'unavailable',
                }],
            },
        }).success).toBe(true);

        // Supported predecessor servers omit this additive proof. The caller,
        // rather than the shared wire reader, decides which scoped operation
        // must fail closed when it is absent.
        expect(ChangesResponseSchema.safeParse(base).success).toBe(true);
    });

    it('rejects a witness that claims a Session fact beyond its captured range', () => {
        expect(ChangesResponseSchema.safeParse({
            changes: [],
            nextCursor: 17,
            sessionAccessWitness: {
                v: 1,
                throughCursor: 17,
                entries: [{
                    sessionId: 'session-race',
                    cursor: 18,
                    status: 'available',
                }],
            },
        }).success).toBe(false);
    });

    it('accepts one exact current-access probe bound to the captured Account cursor', () => {
        expect(ChangesResponseSchema.safeParse({
            changes: [],
            nextCursor: 21,
            sessionAccessProbe: {
                v: 1,
                sessionId: 'session-current',
                throughCursor: 21,
                status: 'available',
            },
        }).success).toBe(true);

        expect(ChangesResponseSchema.safeParse({
            changes: [],
            nextCursor: 22,
            sessionAccessProbe: {
                v: 1,
                sessionId: 'session-current',
                throughCursor: 21,
                status: 'available',
            },
        }).success).toBe(false);
    });
});
