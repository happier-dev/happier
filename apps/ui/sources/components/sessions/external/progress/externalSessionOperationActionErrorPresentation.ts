import type { ExternalSessionOperationActionErrorCodeV1 } from '@happier-dev/protocol';

export type ExternalSessionOperationActionErrorTranslationKey =
    | 'externalSessions.operationActionErrorUpgradeRequired'
    | 'externalSessions.operationActionErrorNotFound'
    | 'externalSessions.operationActionErrorConflict'
    | 'externalSessions.operationActionErrorStaleRevision'
    | 'externalSessions.operationActionErrorInvalidState'
    | 'externalSessions.operationActionErrorNotAllowed'
    | 'externalSessions.operationStatusNeedsReview'
    | 'externalSessions.operationErrorSourceUnavailable'
    | 'externalSessions.operationErrorInternal';

const ERROR_TRANSLATION_KEYS: Readonly<
    Record<
        ExternalSessionOperationActionErrorCodeV1,
        ExternalSessionOperationActionErrorTranslationKey
    >
> = {
    upgrade_required: 'externalSessions.operationActionErrorUpgradeRequired',
    operation_not_found: 'externalSessions.operationActionErrorNotFound',
    operation_conflict: 'externalSessions.operationActionErrorConflict',
    stale_revision: 'externalSessions.operationActionErrorStaleRevision',
    invalid_state: 'externalSessions.operationActionErrorInvalidState',
    not_allowed: 'externalSessions.operationActionErrorNotAllowed',
    reconciliation_required: 'externalSessions.operationStatusNeedsReview',
    source_unavailable: 'externalSessions.operationErrorSourceUnavailable',
    internal_error: 'externalSessions.operationErrorInternal',
};

export function presentExternalSessionOperationActionError(
    code: ExternalSessionOperationActionErrorCodeV1,
): ExternalSessionOperationActionErrorTranslationKey {
    return ERROR_TRANSLATION_KEYS[code];
}
