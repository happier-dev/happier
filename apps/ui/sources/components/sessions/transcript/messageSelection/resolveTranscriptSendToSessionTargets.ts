import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    compareSessionListSessionOrderingKeys,
    readSessionListUpdatedOrderingKey,
    type SessionListSessionOrderingKey,
} from '@/sync/domains/session/listing/sessionListOrderingRules';

export type TranscriptSendToSessionTargetCandidate = Readonly<{
    id: string;
    serverId?: string | null;
    accessLevel?: 'view' | 'edit' | 'admin' | null;
    metadata?: unknown;
    metadataUnavailable?: boolean;
    meaningfulActivityAt?: number | null;
    updatedAt?: number | null;
    createdAt?: number | null;
}>;

function normalizeId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readTimestamp(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buildDestinationOrderingKey(candidate: TranscriptSendToSessionTargetCandidate): SessionListSessionOrderingKey {
    return {
        updated: readSessionListUpdatedOrderingKey(candidate),
        createdAt: readTimestamp(candidate.createdAt),
        stableId: normalizeId(candidate.id),
    };
}

function isWritableSession(candidate: TranscriptSendToSessionTargetCandidate): boolean {
    return candidate.accessLevel !== 'view';
}

export function resolveTranscriptSendToSessionTargets(params: Readonly<{
    sourceSessionId: string;
    sourceServerId: string | null | undefined;
    sessions: ReadonlyArray<TranscriptSendToSessionTargetCandidate>;
}>): ReadonlyArray<TranscriptSendToSessionTargetCandidate> {
    const sourceSessionId = normalizeId(params.sourceSessionId);
    const sourceServerId = normalizeId(params.sourceServerId);
    if (!sourceSessionId || !sourceServerId) return [];

    return params.sessions
        .filter((session) => {
            const sessionId = normalizeId(session.id);
            if (!sessionId || sessionId === sourceSessionId) return false;
            if (!areServerProfileIdentifiersEquivalent(normalizeId(session.serverId), sourceServerId)) return false;
            if (!isWritableSession(session)) return false;
            return isUserFacingSession(session);
        })
        .sort((left, right) => compareSessionListSessionOrderingKeys(
            buildDestinationOrderingKey(left),
            buildDestinationOrderingKey(right),
            'updated',
        ));
}
