import { describe, expect, it } from 'vitest';

import { MetadataSchema } from './storageTypes';

describe('MetadataSchema (forkV1)', () => {
    it('retains the durable request identity used to reconcile an issued fork', () => {
        const parsed = MetadataSchema.parse({
            forkV1: {
                v: 1,
                parentSessionId: 'parent-session',
                parentCutoffSeqInclusive: 12,
                createdAtMs: 123,
                strategy: 'replay',
                requestId: 'fork-request-1',
            },
        });

        expect(parsed.forkV1).toMatchObject({
            requestId: 'fork-request-1',
        });
    });

    it('continues to accept lineage persisted before request identities existed', () => {
        const parsed = MetadataSchema.parse({
            forkV1: {
                v: 1,
                parentSessionId: 'parent-session',
                parentCutoffSeqInclusive: 12,
                createdAtMs: 123,
                strategy: 'replay',
            },
        });

        expect(parsed.forkV1?.requestId).toBeUndefined();
    });
});
