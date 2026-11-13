import type { Session } from '@/sync/domains/state/storageTypes';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { sortSessionSelectionCandidates } from '@/components/sessions/selection/sortSessionSelectionCandidates';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionTargetV1';

export type TranscriptSendToSessionTargetCandidate = Readonly<{
    id: string;
    serverId?: string | null;
    access?: Session['access'];
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
    return candidate.access?.capabilities.submitAgentInput === true;
}

function isReadableSession(candidate: TranscriptSendToSessionTargetCandidate): boolean {
    return candidate.access?.capabilities.readTranscript === true;
}

function resolveQualifiedSessionTargets<T extends TranscriptSendToSessionTargetCandidate>(params: Readonly<{
    excludedSessionId: string;
    serverId: string | null | undefined;
    sessions: ReadonlyArray<T>;
    accepts(candidate: TranscriptSendToSessionTargetCandidate): boolean;
}>): ReadonlyArray<T> {
    const excludedSessionId = normalizeId(params.excludedSessionId);
    const serverId = normalizeId(params.serverId);
    if (!serverId) return [];

    return sortSessionSelectionCandidates(params.sessions
        .filter((session) => {
            const sessionId = normalizeId(session.id);
            if (!sessionId || sessionId === excludedSessionId) return false;
            if (!areServerProfileIdentifiersEquivalent(normalizeId(session.serverId), serverId)) return false;
            if (!params.accepts(session)) return false;
            return isUserFacingSession(session);
        }));
}

export function resolveTranscriptSendToSessionTargets<T extends TranscriptSendToSessionTargetCandidate>(params: Readonly<{
    sourceSessionId: string;
    sourceServerId: string | null | undefined;
    sessions: ReadonlyArray<T>;
}>): ReadonlyArray<T> {
    if (!normalizeId(params.sourceSessionId)) return [];
    return resolveQualifiedSessionTargets({
        excludedSessionId: params.sourceSessionId,
        serverId: params.sourceServerId,
        sessions: params.sessions,
        accepts: isWritableSession,
    });
}

export function resolveTranscriptReadableSessionTargets<T extends TranscriptSendToSessionTargetCandidate>(params: Readonly<{
    excludedSessionId: string;
    serverId: string | null | undefined;
    sessions: ReadonlyArray<T>;
}>): ReadonlyArray<T> {
    if (!normalizeId(params.excludedSessionId)) return [];
    return resolveQualifiedSessionTargets({
        ...params,
        accepts: isReadableSession,
    });
}

function isRecordEditableSession(candidate: TranscriptSendToSessionTargetCandidate): boolean {
    return candidate.access?.capabilities.editSessionRecords === true;
}

/**
 * A no-invoke picker for a Session address. A reference has no source to exclude and needs only
 * reading; a destination for Session records (a copied visual) excludes its source and needs edit access.
 */
export function resolveReadableSessionPickerTargets<T extends TranscriptSendToSessionTargetCandidate>(params: Readonly<{
    serverId: string;
    sessions: ReadonlyArray<T>;
    excludedSessionId?: string;
    capability?: 'readTranscript' | 'editSessionRecords';
    sessionCandidates?: readonly ActionSessionAddressV1[];
}>): ReadonlyArray<T> {
    const candidates = params.sessionCandidates === undefined ? undefined : new Set(params.sessionCandidates
        .filter(candidate => areServerProfileIdentifiersEquivalent(candidate.serverId, params.serverId))
        .map(candidate => candidate.sessionId));
    return resolveQualifiedSessionTargets({ serverId: params.serverId, sessions: params.sessions, excludedSessionId: params.excludedSessionId ?? '',
        accepts: candidate => (candidates === undefined || candidates.has(candidate.id))
            && (candidates !== undefined ? isWritableSession(candidate)
                : params.capability === 'editSessionRecords' ? isRecordEditableSession(candidate) : isReadableSession(candidate)) });
}
