import { t } from '@/text';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { getStorage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveExternalSessionTranscriptAuthorityState } from '@/sync/runtime/external/externalSessionTranscriptAuthority';
import { HappyError } from '@/utils/errors/errors';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

function unavailableSharingMessage(session: Session): string | null {
    const link = readExternalSessionLink(readSessionOwnerMetadataView(session));
    const sharing = resolveExternalSessionTranscriptAuthorityState({
        linked: link !== null,
        agentReachable: false,
        liveSourceKey: null,
        currentStorageState: session.currentStorageState
            ?? (link ? 'legacy_external_unknown' : 'hosted'),
        acceptedThroughServerSeq: session.acceptedThroughServerSeq ?? null,
        publishedThroughServerSeq: session.publishedThroughServerSeq ?? null,
        materializedThroughSourceAt: session.materializedThroughSourceAt ?? null,
        transcriptShareable: session.transcriptShareable ?? null,
        operationPresentation: null,
        operationProgress: null,
    }).sharing;

    switch (sharing.kind) {
        case 'hosted':
        case 'published_snapshot':
            return null;
        case 'requires_persisted_import':
            return t('externalSessions.sharingTranscriptOnMachine', {
                machine: link?.machineId ?? t('status.unknown'),
            });
        case 'import_incomplete':
            return t('externalSessions.sharingImportIncomplete');
        case 'unavailable':
            return t('externalSessions.sharingTranscriptUnavailable');
    }
}

/**
 * Mutation-time guard for stale modal callbacks. Render eligibility is only
 * presentation; every outward sharing write re-reads the live store here.
 */
export function assertCurrentSessionSharingMutationAuthority(sessionId: string): Session {
    const session = getStorage().getState().sessions[sessionId] ?? null;
    if (!session) {
        throw new HappyError(t('errors.sessionNotFound'), false, {
            code: 'session_sharing_session_missing',
        });
    }
    if (session.accessLevel && session.accessLevel !== 'admin') {
        throw new HappyError(t('errors.permissionDenied'), false, {
            code: 'session_sharing_permission_denied',
        });
    }

    const unavailableMessage = unavailableSharingMessage(session);
    if (unavailableMessage) {
        throw new HappyError(unavailableMessage, false, {
            code: 'session_sharing_authority_unavailable',
        });
    }
    return session;
}
