import { describe, expect, it } from 'vitest';

import { MetadataSchema } from "./metadata.js";
import { SessionOwnerCompatibilityViewV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

describe('MetadataSchema (forkV1)', () => {
    it.each([true, undefined])('round-trips recorded origin through the real metadata parser (%s)', continuation => {
        const forkV1 = SessionOwnerCompatibilityViewV1Schema.shape.forkV1.parse({
            v: 1, parentSessionId: 'parent-session', parentCutoffSeqInclusive: 12,
            createdAtMs: 123, strategy: 'replay', ...(continuation ? { continuation } : {}),
        });
        const parsed = MetadataSchema.parse({ forkV1 });
        expect(JSON.parse(JSON.stringify(parsed)).forkV1).toEqual(forkV1);
    });
    it('retains explicit null request and native-session identities from the canonical owner fork shape', () => {
        const forkV1 = SessionOwnerCompatibilityViewV1Schema.shape.forkV1.parse({
            v: 1, parentSessionId: 'parent-session', parentCutoffSeqInclusive: 12,
            createdAtMs: 123, strategy: 'replay', requestId: null,
            agentHint: { agentId: 'codex', agentSessionId: null },
        });
        const parsed = MetadataSchema.parse({ forkV1 });
        expect(parsed.forkV1?.requestId).toBeNull();
        expect(parsed.forkV1?.agentHint?.agentSessionId).toBeNull();
    });
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
