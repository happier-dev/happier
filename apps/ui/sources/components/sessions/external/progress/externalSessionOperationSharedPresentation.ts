import type {
    ExternalSessionOperationPhaseV1,
    ExternalSessionOperationSharedPresentationV1,
    ExternalSessionOperationStatusV1,
} from '@happier-dev/protocol/sessions/external/operationV1';

import type {
    ExternalSessionOperationTranslationKey,
} from './externalSessionOperationProgressPresentation';

const PHASE_KEYS: Readonly<
    Record<ExternalSessionOperationPhaseV1, ExternalSessionOperationTranslationKey>
> = {
    validating: 'externalSessions.operationPhaseValidating',
    quiescing: 'externalSessions.operationPhaseWaitingForAgent',
    staging: 'externalSessions.operationPhaseReadingSource',
    importing: 'externalSessions.operationPhaseImporting',
    final_catch_up: 'externalSessions.operationPhaseCatchingUp',
    admitting: 'externalSessions.operationPhasePreparingRuntime',
    spawning: 'externalSessions.operationPhaseStartingRuntime',
    finalizing: 'externalSessions.operationPhaseFinalizing',
    publishing: 'externalSessions.operationPhasePublishing',
};

const STATUS_KEYS: Readonly<
    Record<ExternalSessionOperationStatusV1, ExternalSessionOperationTranslationKey>
> = {
    running: 'externalSessions.operationStatusRunning',
    awaiting_user_resume: 'externalSessions.operationStatusNeedsResume',
    cancel_requested: 'externalSessions.operationStatusCancelling',
    cancelled: 'externalSessions.operationStatusCancelled',
    failed: 'externalSessions.operationStatusFailed',
    reconciliation_required: 'externalSessions.operationStatusNeedsReview',
    completed: 'externalSessions.operationStatusCompleted',
    discarded: 'externalSessions.operationStatusDiscarded',
};

export function presentExternalSessionOperationShared(
    presentation: ExternalSessionOperationSharedPresentationV1,
) {
    return {
        // A completed operation's last phase is history, not something still happening, so it names none.
        phaseKey: presentation.status === 'completed' ? null : PHASE_KEYS[presentation.phase],
        statusKey: STATUS_KEYS[presentation.status],
        titleKey: presentation.kind === 'materialize'
            ? 'externalSessions.operationTitleMaterialize'
            : presentation.kind === 'takeover_persisted'
                ? 'externalSessions.operationTitleTakeoverPersisted'
                : 'externalSessions.operationTitleTakeoverLinked',
    } as const;
}
