import { describe, expect, it, vi } from 'vitest';
import { verifyChangesCursorMaterializationProofs } from './cursorMaterializationDetector';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';

function change(params: {
    cursor: number;
    kind?: string;
    entityId?: string;
    hint?: unknown;
}): ApiChangeEntry {
    return {
        cursor: params.cursor,
        kind: params.kind ?? 'session',
        entityId: params.entityId ?? 's1',
        changedAt: params.cursor,
        hint: params.hint ?? null,
    };
}

describe('verifyChangesCursorMaterializationProofs', () => {
    it('persists an invariant event when durable materialized seq is behind the safe prefix', () => {
        const recordCritical = vi.fn();

        const result = verifyChangesCursorMaterializationProofs({
            changes: [change({ cursor: 1, entityId: 's1', hint: { lastMessageSeq: 5 } })],
            advancedCursor: '1',
            isSessionMessagesLoaded: () => true,
            loadSessionMaterializedMaxSeqById: () => ({ s1: 4 }),
            telemetry: { record: vi.fn(), recordCritical },
        });

        expect(result).toEqual({
            status: 'violation',
            missingProofs: [{ cursor: '1', kind: 'session', entityId: 's1', requiredSeq: 5, materializedSeq: 4 }],
        });
        expect(recordCritical).toHaveBeenCalledWith('sync.cursor.advancedPastUnmaterialized', {
            cursor: '1',
            kind: 'session',
            entityId: 's1',
            requiredSeq: 5,
            materializedSeq: 4,
        });
    });

    it('treats unloaded session skips as intentionally unverifiable without a violation', () => {
        const recordCritical = vi.fn();

        const result = verifyChangesCursorMaterializationProofs({
            changes: [change({ cursor: 1, entityId: 's1', hint: { lastMessageSeq: 5 } })],
            advancedCursor: '1',
            isSessionMessagesLoaded: () => false,
            loadSessionMaterializedMaxSeqById: () => ({}),
            telemetry: { record: vi.fn(), recordCritical },
        });

        expect(result).toEqual({ status: 'ok' });
        expect(recordCritical).not.toHaveBeenCalled();
    });

    it('uses feed-order cursor equality instead of lexical cursor comparison', () => {
        const recordCritical = vi.fn();

        const result = verifyChangesCursorMaterializationProofs({
            changes: [
                change({ cursor: 9, entityId: 's9', hint: { lastMessageSeq: 9 } }),
                change({ cursor: 10, entityId: 's10', hint: { lastMessageSeq: 10 } }),
            ],
            advancedCursor: '9',
            isSessionMessagesLoaded: () => true,
            loadSessionMaterializedMaxSeqById: () => ({ s9: 9, s10: 0 }),
            telemetry: { record: vi.fn(), recordCritical },
        });

        expect(result).toEqual({ status: 'ok' });
        expect(recordCritical).not.toHaveBeenCalled();
    });
});
