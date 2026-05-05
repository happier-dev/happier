import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import type { SyncReliabilityEventFields } from '@/sync/runtime/syncReliabilityTelemetry';
import {
    classifyChangeForCheckpoint,
    getChangeTargetMessageSeq,
} from './changesPlanner';

export type MissingMaterializationProof = Readonly<{
    cursor: string;
    kind: string;
    entityId: string;
    requiredSeq: number;
    materializedSeq: number;
}>;

export type CursorMaterializationDetectorResult =
    | Readonly<{ status: 'ok' }>
    | Readonly<{ status: 'not-in-batch' }>
    | Readonly<{ status: 'violation'; missingProofs: MissingMaterializationProof[] }>;

export type CursorMaterializationDetectorTelemetry = Readonly<{
    record: (name: string, fields?: SyncReliabilityEventFields) => unknown;
    recordCritical: (name: string, fields?: SyncReliabilityEventFields) => unknown;
}>;

function changesThroughAdvancedCursor(params: {
    changes: readonly ApiChangeEntry[];
    advancedCursor: string | null;
}): readonly ApiChangeEntry[] | null {
    const advancedCursor = String(params.advancedCursor ?? '').trim();
    if (!advancedCursor) return [];
    const prefix: ApiChangeEntry[] = [];
    for (const change of params.changes) {
        prefix.push(change);
        if (String(change.cursor) === advancedCursor) {
            return prefix;
        }
    }
    return null;
}

export function verifyChangesCursorMaterializationProofs(params: {
    changes: readonly ApiChangeEntry[];
    advancedCursor: string | null;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    loadSessionMaterializedMaxSeqById: () => Record<string, number>;
    telemetry: CursorMaterializationDetectorTelemetry;
}): CursorMaterializationDetectorResult {
    const safePrefix = changesThroughAdvancedCursor({
        changes: params.changes,
        advancedCursor: params.advancedCursor,
    });
    if (safePrefix === null) {
        return { status: 'not-in-batch' };
    }

    const materializedBySessionId = params.loadSessionMaterializedMaxSeqById();
    const missingProofs: MissingMaterializationProof[] = [];

    for (const change of safePrefix) {
        const classification = classifyChangeForCheckpoint(change, {
            isSessionMessagesLoaded: params.isSessionMessagesLoaded,
        });
        if (
            classification.decision !== 'critical'
            || (classification.kind !== 'session' && classification.kind !== 'share')
            || !params.isSessionMessagesLoaded(classification.entityId)
        ) {
            continue;
        }

        const requiredSeq = getChangeTargetMessageSeq(change);
        if (requiredSeq === null) {
            continue;
        }
        const materializedSeq = materializedBySessionId[classification.entityId] ?? 0;
        if (materializedSeq >= requiredSeq) {
            continue;
        }
        const missing: MissingMaterializationProof = {
            cursor: classification.cursor,
            kind: classification.kind,
            entityId: classification.entityId,
            requiredSeq,
            materializedSeq,
        };
        missingProofs.push(missing);
        params.telemetry.recordCritical('sync.cursor.advancedPastUnmaterialized', missing);
    }

    if (missingProofs.length > 0) {
        return { status: 'violation', missingProofs };
    }

    params.telemetry.record('sync.cursor.materializationProof.ok', {
        cursor: params.advancedCursor,
        checkedChanges: safePrefix.length,
    });
    return { status: 'ok' };
}
