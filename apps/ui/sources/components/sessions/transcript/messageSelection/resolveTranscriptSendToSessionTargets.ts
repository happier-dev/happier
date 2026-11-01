import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { sortSessionSelectionCandidates } from '@/components/sessions/selection/sortSessionSelectionCandidates';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';

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

function isWritableSession(candidate: TranscriptSendToSessionTargetCandidate): boolean {
    return candidate.accessLevel !== 'view';
}

export function resolveTranscriptSendToSessionTargets<T extends TranscriptSendToSessionTargetCandidate>(params: Readonly<{
    sourceSessionId: string;
    sourceServerId: string | null | undefined;
    sessions: ReadonlyArray<T>;
}>): ReadonlyArray<T> {
    const sourceSessionId = normalizeId(params.sourceSessionId);
    const sourceServerIdRaw = normalizeId(params.sourceServerId);
    const sourceServerId = resolveServerProfileScopeIdForIdentifier(sourceServerIdRaw) || sourceServerIdRaw;
    if (!sourceSessionId || !sourceServerId) return [];

    return sortSessionSelectionCandidates(params.sessions
        .filter((session) => {
            const sessionId = normalizeId(session.id);
            if (!sessionId || sessionId === sourceSessionId) return false;
            const candidateServerId = normalizeId(session.serverId);
            if (!candidateServerId || !areServerProfileIdentifiersEquivalent(candidateServerId, sourceServerId)) return false;
            if (!isWritableSession(session)) return false;
            return isUserFacingSession(session);
        }));
}
