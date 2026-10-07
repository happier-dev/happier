import { describe, expect, it } from 'vitest';

import { MetadataSchema } from "./metadata.js";

describe('MetadataSchema (forkV1)', () => {
    it('preserves managed directory classification while dropping unknown stored marker fields', () => {
        const parsed = MetadataSchema.parse({
            sessionDirectoryV1: { v: 1, kind: 'managed', futureField: 'ignored' },
        });
        expect(parsed.sessionDirectoryV1).toEqual({ v: 1, kind: 'managed' });
    });

    it('retains the durable request identity used to reconcile an issued fork', () => {
        const parsed = MetadataSchema.parse({
            forkV1: {
                v: 1,
                parentSessionId: 'parent-session',
                parentCutoffSeqInclusive: 12,
                createdAtMs: 123,
                strategy: 'replay',
                requestId: 'fork-request-1',
                filesNotCopied: { reason: 'cross_machine' },
            },
        });

        expect(parsed.forkV1).toMatchObject({
            requestId: 'fork-request-1',
            filesNotCopied: { reason: 'cross_machine' },
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
