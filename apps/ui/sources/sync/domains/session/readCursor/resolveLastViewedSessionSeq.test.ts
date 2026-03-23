import { describe, expect, it } from 'vitest';

import { resolveLastViewedSessionSeq } from './resolveLastViewedSessionSeq';

describe('resolveLastViewedSessionSeq', () => {
    it('prefers the authoritative session field when present', () => {
        expect(resolveLastViewedSessionSeq({
            lastViewedSessionSeq: 8,
            metadata: {
                path: '',
                host: '',
                readStateV1: {
                    v: 1,
                    sessionSeq: 3,
                    pendingActivityAt: 0,
                    updatedAt: 1,
                },
            },
        } as any)).toBe(8);
    });

    it('falls back to legacy readStateV1 during migration', () => {
        expect(resolveLastViewedSessionSeq({
            metadata: {
                path: '',
                host: '',
                readStateV1: {
                    v: 1,
                    sessionSeq: 4,
                    pendingActivityAt: 0,
                    updatedAt: 1,
                },
            },
        } as any)).toBe(4);
    });
});
