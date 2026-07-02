import {
    buildSessionMetadataStabilitySignatureValue,
    buildStableJsonSignature,
} from '@/sync/domains/session/metadata/sessionMetadataStability';
import type { Metadata } from '@/sync/domains/state/storageTypes';

const TRANSCRIPT_RENDER_IGNORED_SESSION_FIELDS = new Set([
    'updatedAt',
    'activeAt',
    'thinkingAt',
    'latestTurnStatus',
    'latestTurnStatusObservedAt',
    'meaningfulActivityAt',
    'latestReadyEventAt',
    'latestUsage',
    'pendingVersion',
    'pendingCount',
    'agentStateVersion',
    'pendingPermissionRequestCount',
    'pendingUserActionRequestCount',
    'lastRuntimeIssue',
]);

export function buildTranscriptRenderSignature(session: object): string {
    const record = session as Readonly<Record<string, unknown>>;
    const signatureValue: Record<string, unknown> = {};

    for (const key of Object.keys(record).sort()) {
        if (TRANSCRIPT_RENDER_IGNORED_SESSION_FIELDS.has(key)) continue;
        signatureValue[key] = key === 'metadata'
            ? buildSessionMetadataStabilitySignatureValue(record.metadata as Metadata | null | undefined)
            : record[key];
    }

    return buildStableJsonSignature(signatureValue);
}
