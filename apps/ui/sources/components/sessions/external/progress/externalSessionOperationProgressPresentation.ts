import type {
    ExternalSessionOperationPhaseV1,
    ExternalSessionOperationProgressV1,
    ExternalSessionOperationStatusV1,
} from '@happier-dev/protocol';

import type {
    ProgressChecklistStepStatus,
} from '@/components/systemTasks/ProgressChecklist';

export type ExternalSessionOperationObservationContext = 'live' | 'hydrated';
export type ExternalSessionOperationOriginAvailability = 'online' | 'offline';
export type ExternalSessionOperationActionKind =
    | 'resume'
    | 'retry'
    | 'retry_start'
    | 'cancel'
    | 'discard'
    | 'dismiss';

export type ExternalSessionOperationTranslationKey =
    | 'externalSessions.operationTitleMaterialize'
    | 'externalSessions.operationTitleTakeoverLinked'
    | 'externalSessions.operationTitleTakeoverPersisted'
    | 'externalSessions.operationStatusRunning'
    | 'externalSessions.operationStatusCancelling'
    | 'externalSessions.operationStatusCancelled'
    | 'externalSessions.operationStatusCompleted'
    | 'externalSessions.operationStatusDiscarded'
    | 'externalSessions.operationStatusNeedsResume'
    | 'externalSessions.operationStatusNeedsReview'
    | 'externalSessions.operationStatusFailed'
    | 'externalSessions.operationStatusImportIncomplete'
    | 'externalSessions.operationStatusUpdateIncomplete'
    | 'externalSessions.operationStatusOriginOffline'
    | 'externalSessions.operationStatusExternalWriter'
    | 'externalSessions.operationStatusSpawnFailedAfterImport'
    | 'externalSessions.operationStatusSpawnFailedAfterTakeover'
    | 'externalSessions.operationErrorSourceUnavailable'
    | 'externalSessions.operationErrorSourceChanged'
    | 'externalSessions.operationErrorCapacity'
    | 'externalSessions.operationErrorRequiredItems'
    | 'externalSessions.operationErrorImport'
    | 'externalSessions.operationErrorPublication'
    | 'externalSessions.operationErrorAdmission'
    | 'externalSessions.operationErrorExternalWriter'
    | 'externalSessions.operationErrorInternal'
    | 'externalSessions.operationPhaseValidating'
    | 'externalSessions.operationPhaseWaitingForAgent'
    | 'externalSessions.operationPhaseReadingSource'
    | 'externalSessions.operationPhaseImporting'
    | 'externalSessions.operationPhaseCatchingUp'
    | 'externalSessions.operationPhasePreparingRuntime'
    | 'externalSessions.operationPhaseStartingRuntime'
    | 'externalSessions.operationPhaseFinalizing'
    | 'externalSessions.operationPhasePublishing'
    | 'externalSessions.operationActionResume'
    | 'externalSessions.operationActionRetryStart'
    | 'externalSessions.operationActionCancel'
    | 'externalSessions.operationActionDiscard'
    | 'externalSessions.operationActionDismiss'
    | 'common.retry';

export type ExternalSessionOperationProgressPresentation = Readonly<{
    titleKey: ExternalSessionOperationTranslationKey;
    summaryKey: ExternalSessionOperationTranslationKey;
    detailKey: ExternalSessionOperationTranslationKey | null;
    effectiveStatus: ExternalSessionOperationStatusV1;
    steps: readonly Readonly<{
        phase: ExternalSessionOperationPhaseV1;
        stepId: ExternalSessionOperationPhaseV1;
        titleKey: ExternalSessionOperationTranslationKey;
        status: ProgressChecklistStepStatus;
    }>[];
    actions: readonly Readonly<{
        kind: ExternalSessionOperationActionKind;
        titleKey: ExternalSessionOperationTranslationKey;
        enabled: boolean;
        destructive: boolean;
    }>[];
    importProgress: Readonly<{
        importedItemCount: number;
        totalItemEstimate: number | null;
        ratio: number | null;
    }> | null;
    publishedThroughServerSeq: number | null;
    discardRequiresConfirmation: boolean;
}>;

const TERMINAL_STATUSES = new Set<ExternalSessionOperationStatusV1>([
    'cancelled',
    'completed',
    'discarded',
]);

const PHASE_LABEL_KEYS: Readonly<
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

function resolveEffectiveStatus(
    progress: ExternalSessionOperationProgressV1,
    _observationContext: ExternalSessionOperationObservationContext,
): ExternalSessionOperationStatusV1 {
    return progress.status;
}

function isPersistedTakeoverAdmissionRecovery(
    progress: ExternalSessionOperationProgressV1,
): boolean {
    return progress.request.plan === 'takeover'
        && progress.request.targetStorageMode === 'persisted'
        && progress.status === 'failed'
        && progress.phase === 'admitting'
        && progress.retryTargetPhase === 'admitting'
        && progress.error?.code === 'admission_failed'
        && progress.error.retryable === true;
}

function isPersistedTakeoverSpawnRecovery(
    progress: ExternalSessionOperationProgressV1,
): boolean {
    return progress.request.plan === 'takeover'
        && progress.request.targetStorageMode === 'persisted'
        && progress.status === 'failed'
        && progress.phase === 'spawning'
        && progress.retryTargetPhase === 'spawning'
        && progress.currentStorageState === 'hosted'
        && progress.fence.kind === 'none'
        && progress.publication === undefined
        && progress.error?.code === 'spawn_failed'
        && progress.error.retryable === true;
}

function isExternalLinkedTakeoverRecovery(
    progress: ExternalSessionOperationProgressV1,
): boolean {
    if (
        progress.request.plan !== 'takeover'
        || progress.request.targetStorageMode !== 'external-linked'
        || progress.status !== 'failed'
        || progress.retryTargetPhase !== progress.phase
        || progress.error?.retryable !== true
    ) {
        return false;
    }
    if (progress.phase === 'admitting') {
        return progress.error.code === 'admission_failed'
            || progress.error.code === 'source_unavailable'
            || progress.error.code === 'internal_error';
    }
    if (progress.phase === 'spawning') {
        return progress.error.code === 'spawn_failed'
            || progress.error.code === 'source_unavailable'
            || progress.error.code === 'internal_error';
    }
    return progress.phase === 'quiescing'
        && (
            progress.error.code === 'source_unavailable'
            || progress.error.code === 'internal_error'
        );
}

function resolveStepStatus(
    effectiveStatus: ExternalSessionOperationStatusV1,
    index: number,
    currentIndex: number,
): ProgressChecklistStepStatus {
    if (effectiveStatus === 'completed') return 'done';
    if (index < currentIndex) return 'done';
    if (index > currentIndex) return 'pending';

    switch (effectiveStatus) {
        case 'running':
            return 'active';
        case 'awaiting_user_resume':
        case 'cancel_requested':
        case 'reconciliation_required':
            return 'waiting';
        case 'failed':
            return 'failed';
        case 'cancelled':
        case 'discarded':
            return 'canceled';
    }
}

function resolveTitleKey(
    progress: ExternalSessionOperationProgressV1,
): ExternalSessionOperationTranslationKey {
    if (progress.request.plan === 'materialize') {
        return 'externalSessions.operationTitleMaterialize';
    }
    return progress.request.targetStorageMode === 'persisted'
        ? 'externalSessions.operationTitleTakeoverPersisted'
        : 'externalSessions.operationTitleTakeoverLinked';
}

function resolveSummaryKey(
    progress: ExternalSessionOperationProgressV1,
    effectiveStatus: ExternalSessionOperationStatusV1,
    originAvailability: ExternalSessionOperationOriginAvailability,
): ExternalSessionOperationTranslationKey {
    if (progress.error?.code === 'external_writer_conflict') {
        return 'externalSessions.operationStatusExternalWriter';
    }
    if (progress.status === 'reconciliation_required') {
        return 'externalSessions.operationStatusNeedsReview';
    }
    if (progress.fence.kind === 'initial_server_partial') {
        return 'externalSessions.operationStatusImportIncomplete';
    }
    if (progress.fence.kind === 'incomplete_update') {
        return 'externalSessions.operationStatusUpdateIncomplete';
    }
    if (progress.error?.code === 'spawn_failed') {
        return progress.request.targetStorageMode === 'persisted'
            ? 'externalSessions.operationStatusSpawnFailedAfterImport'
            : 'externalSessions.operationStatusSpawnFailedAfterTakeover';
    }
    if (originAvailability === 'offline' && !TERMINAL_STATUSES.has(effectiveStatus)) {
        return 'externalSessions.operationStatusOriginOffline';
    }
    switch (effectiveStatus) {
        case 'running':
            return 'externalSessions.operationStatusRunning';
        case 'awaiting_user_resume':
            return 'externalSessions.operationStatusNeedsResume';
        case 'cancel_requested':
            return 'externalSessions.operationStatusCancelling';
        case 'cancelled':
            return 'externalSessions.operationStatusCancelled';
        case 'failed':
            return 'externalSessions.operationStatusFailed';
        case 'reconciliation_required':
            return 'externalSessions.operationStatusNeedsReview';
        case 'completed':
            return 'externalSessions.operationStatusCompleted';
        case 'discarded':
            return 'externalSessions.operationStatusDiscarded';
    }
}

function resolveErrorDetailKey(
    progress: ExternalSessionOperationProgressV1,
): ExternalSessionOperationTranslationKey | null {
    switch (progress.error?.code) {
        case undefined:
        case 'spawn_failed':
        case 'reconciliation_required':
            return null;
        case 'external_writer_conflict':
            return 'externalSessions.operationErrorExternalWriter';
        case 'source_unavailable':
            return 'externalSessions.operationErrorSourceUnavailable';
        case 'source_changed':
            return 'externalSessions.operationErrorSourceChanged';
        case 'staging_capacity_exceeded':
            return 'externalSessions.operationErrorCapacity';
        case 'required_items_failed':
            return 'externalSessions.operationErrorRequiredItems';
        case 'historical_import_failed':
            return 'externalSessions.operationErrorImport';
        case 'publication_failed':
            return 'externalSessions.operationErrorPublication';
        case 'admission_failed':
            return 'externalSessions.operationErrorAdmission';
        case 'internal_error':
            return 'externalSessions.operationErrorInternal';
    }
}

function resolveActions(
    progress: ExternalSessionOperationProgressV1,
    effectiveStatus: ExternalSessionOperationStatusV1,
    originAvailability: ExternalSessionOperationOriginAvailability,
): ExternalSessionOperationProgressPresentation['actions'] {
    if (TERMINAL_STATUSES.has(effectiveStatus)) {
        return [{
            kind: 'dismiss',
            titleKey: 'externalSessions.operationActionDismiss',
            enabled: true,
            destructive: false,
        }];
    }
    if (
        progress.status === 'reconciliation_required'
        || progress.error?.code === 'external_writer_conflict'
    ) {
        return [];
    }

    const enabled = originAvailability === 'online';
    const actions: Array<ExternalSessionOperationProgressPresentation['actions'][number]> = [];
    const hasInitialPartialFence = progress.fence.kind === 'initial_server_partial';
    const hasIncompleteUpdateFence = progress.fence.kind === 'incomplete_update';
    const isPostPublicationPersistedTakeover =
        progress.request.plan === 'takeover'
        && progress.request.targetStorageMode === 'persisted'
        && (
            progress.phase === 'admitting'
            || progress.phase === 'spawning'
            || progress.phase === 'finalizing'
        );
    const isExternalLinkedTakeover =
        progress.request.plan === 'takeover'
        && progress.request.targetStorageMode === 'external-linked';
    const canResume = (
        effectiveStatus === 'awaiting_user_resume'
        && (
            !isExternalLinkedTakeover
            || progress.phase === 'validating'
            || progress.phase === 'quiescing'
            || progress.phase === 'admitting'
            || progress.phase === 'spawning'
        )
    ) || isPersistedTakeoverAdmissionRecovery(progress);
    const canRetryStart = isPersistedTakeoverSpawnRecovery(progress);
    const canRetryExternalLinked = isExternalLinkedTakeoverRecovery(progress);
    const canCancelExternalLinked = isExternalLinkedTakeover
        && (
            canRetryExternalLinked
            || effectiveStatus === 'cancel_requested'
            || (
                effectiveStatus === 'awaiting_user_resume'
                && (
                    progress.phase === 'validating'
                    || progress.phase === 'quiescing'
                    || progress.phase === 'admitting'
                )
            )
        );

    if (canResume || canRetryStart || canRetryExternalLinked) {
        const retryValidation = progress.request.plan === 'materialize'
            && progress.phase === 'validating'
            && progress.retryTargetPhase === 'validating';
        actions.push({
            kind: retryValidation
                ? 'retry'
                : canRetryExternalLinked
                    ? 'retry'
                : canRetryStart
                    ? 'retry_start'
                    : 'resume',
            titleKey: retryValidation
                ? 'common.retry'
                : canRetryExternalLinked
                    ? 'common.retry'
                : canRetryStart
                    ? 'externalSessions.operationActionRetryStart'
                    : 'externalSessions.operationActionResume',
            enabled,
            destructive: false,
        });
    }

    if (
        !hasIncompleteUpdateFence
        && !isPostPublicationPersistedTakeover
        && (
            canCancelExternalLinked
            || (
                !isExternalLinkedTakeover
                && (
                    effectiveStatus === 'running'
                    || effectiveStatus === 'awaiting_user_resume'
                    || effectiveStatus === 'cancel_requested'
                )
            )
        )
    ) {
        actions.push({
            kind: 'cancel',
            titleKey: 'externalSessions.operationActionCancel',
            enabled,
            destructive: false,
        });
    }

    if (hasInitialPartialFence) {
        actions.push({
            kind: 'discard',
            titleKey: 'externalSessions.operationActionDiscard',
            enabled,
            destructive: true,
        });
    }

    return actions;
}

export function presentExternalSessionOperationProgress(
    progress: ExternalSessionOperationProgressV1,
    context: Readonly<{
        observationContext: ExternalSessionOperationObservationContext;
        originAvailability: ExternalSessionOperationOriginAvailability;
    }>,
): ExternalSessionOperationProgressPresentation {
    const effectiveStatus = resolveEffectiveStatus(progress, context.observationContext);
    const currentIndex = Math.max(0, progress.timeline.indexOf(progress.phase));
    const steps = progress.timeline.map((phase, index) => ({
        phase,
        stepId: phase,
        titleKey: PHASE_LABEL_KEYS[phase],
        status: resolveStepStatus(effectiveStatus, index, currentIndex),
    }));
    const estimate = progress.checkpoint.totalItemEstimate ?? null;
    const importProgress = progress.timeline.includes('importing')
        ? {
            importedItemCount: progress.checkpoint.importedItemCount,
            totalItemEstimate: estimate,
            ratio: estimate !== null && estimate > 0
                ? Math.min(1, progress.checkpoint.importedItemCount / estimate)
                : null,
        }
        : null;

    return {
        titleKey: resolveTitleKey(progress),
        summaryKey: resolveSummaryKey(progress, effectiveStatus, context.originAvailability),
        detailKey: resolveErrorDetailKey(progress),
        effectiveStatus,
        steps,
        actions: resolveActions(progress, effectiveStatus, context.originAvailability),
        importProgress,
        publishedThroughServerSeq: progress.fence.kind === 'incomplete_update'
            ? progress.fence.publication.publishedThroughServerSeq
            : progress.publication?.publishedThroughServerSeq ?? null,
        discardRequiresConfirmation: progress.fence.kind === 'initial_server_partial',
    };
}
