import { t } from '@/text';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readExternalSessionTranscriptStorageState, resolveExternalSessionTranscriptAuthorityState } from '@/sync/runtime/external/externalSessionTranscriptAuthority';
import { HappyError } from '@/utils/errors/errors';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export type SharingAuthoritySession = Omit<Session, 'presence'> & { presence?: Session['presence'] };

function unavailableSharingMessage(session: SharingAuthoritySession): string | null {
    const link = readExternalSessionLink(readSessionOwnerMetadataView(session));
    const sharing = resolveExternalSessionTranscriptAuthorityState({
        linked: link !== null,
        agentReachable: false,
        liveSourceKey: null,
        currentStorageState: readExternalSessionTranscriptStorageState(session.currentStorageState, link !== null),
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

/** Exact-scope snapshots are normalized by the canonical Session ingress. */
export function assertSessionSharingMutationAuthority(
    session: SharingAuthoritySession,
    capability: 'manageAccess' | 'managePublicLink',
): void {
    if (session.access?.capabilities[capability] !== true) {
        throw new HappyError(t('errors.permissionDenied'), false, { code: 'session_sharing_permission_denied' });
    }
    const message = unavailableSharingMessage(session);
    if (message) throw new HappyError(message, false, { code: 'session_sharing_authority_unavailable' });
}
