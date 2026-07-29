import { describe, expect, it } from 'vitest';

import {
    EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
    ExternalSessionOperationProgressV1Schema,
    type ExternalSessionOperationProgressV1,
} from '@happier-dev/protocol';

import { presentExternalSessionOperationProgress } from './externalSessionOperationProgressPresentation';

const EMPTY_FAILURES = {
    total: 0,
    record: 0,
    media: 0,
    conversion: 0,
    diagnosticsTruncated: false,
} as const;

function createProgress(
    input: Readonly<{
        request?: ExternalSessionOperationProgressV1['request'];
        status?: ExternalSessionOperationProgressV1['status'];
        phase?: ExternalSessionOperationProgressV1['phase'];
        priorStableStorage?: ExternalSessionOperationProgressV1['priorStableStorage'];
        currentStorageState?: ExternalSessionOperationProgressV1['currentStorageState'];
        checkpoint?: ExternalSessionOperationProgressV1['checkpoint'];
        fence?: ExternalSessionOperationProgressV1['fence'];
        publication?: ExternalSessionOperationProgressV1['publication'];
        retryTargetPhase?: ExternalSessionOperationProgressV1['retryTargetPhase'];
        error?: ExternalSessionOperationProgressV1['error'];
    }> = {},
): ExternalSessionOperationProgressV1 {
    const request = input.request ?? {
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
    };
    const timeline = request.plan === 'materialize'
        ? EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize
        : request.targetStorageMode === 'persisted'
            ? EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_persisted
            : EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_external_linked;

    return ExternalSessionOperationProgressV1Schema.parse({
        v: 1,
        operationId: 'operation-1',
        revision: 4,
        request,
        status: input.status ?? 'running',
        phase: input.phase ?? timeline[0],
        timeline,
        updatedAtMs: 1_700_000_000_000,
        priorStableStorage: input.priorStableStorage ?? { state: 'machine_only' },
        currentStorageState: input.currentStorageState ?? 'machine_only',
        checkpoint: input.checkpoint ?? {
            sourcePagesRead: 0,
            stagedItemCount: 0,
            importedItemCount: 0,
            requiredItemFailures: EMPTY_FAILURES,
        },
        fence: input.fence ?? { kind: 'none' },
        ...(input.publication ? { publication: input.publication } : {}),
        ...(input.retryTargetPhase ? { retryTargetPhase: input.retryTargetPhase } : {}),
        ...(input.error ? { error: input.error } : {}),
    });
}

describe('presentExternalSessionOperationProgress', () => {
    it.each([
        {
            label: 'materialization',
            progress: createProgress({ phase: 'importing' }),
            expected: EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize,
        },
        {
            label: 'external-linked takeover',
            progress: createProgress({
                request: {
                    plan: 'takeover',
                    targetStorageMode: 'external-linked',
                    targetRuntimeMode: 'terminal',
                },
                phase: 'admitting',
            }),
            expected: EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_external_linked,
        },
        {
            label: 'persisted takeover',
            progress: createProgress({
                request: {
                    plan: 'takeover',
                    targetStorageMode: 'persisted',
                    targetRuntimeMode: 'terminal',
                },
                phase: 'final_catch_up',
            }),
            expected: EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_persisted,
        },
    ])('renders only the A1 execution-plan phases for $label', ({ progress, expected }) => {
        const presentation = presentExternalSessionOperationProgress(progress, {
            observationContext: 'live',
            originAvailability: 'online',
        });

        expect(presentation.steps.map((step) => step.phase)).toEqual(expected);
    });

    it('does not manufacture a resumable state from hydrated running progress', () => {
        const progress = createProgress({ phase: 'importing', status: 'running' });

        const presentation = presentExternalSessionOperationProgress(progress, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        });

        expect(presentation.effectiveStatus).toBe('running');
        expect(presentation.actions).toEqual([
            expect.objectContaining({ kind: 'cancel', enabled: true }),
        ]);
        expect(progress.status).toBe('running');
        expect(progress.revision).toBe(4);
    });

    it('keeps interrupted materialize publishing cancellable without manufacturing Resume', () => {
        const progress = createProgress({
            phase: 'publishing',
            status: 'running',
        });

        const presentation = presentExternalSessionOperationProgress(progress, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        });

        expect(presentation.effectiveStatus).toBe('running');
        expect(presentation.actions).toEqual([
            expect.objectContaining({ kind: 'cancel', enabled: true }),
        ]);
    });

    it('keeps a hydrated cancellation request cancellable without presenting Resume', () => {
        const progress = createProgress({
            phase: 'staging',
            status: 'cancel_requested',
        });

        const presentation = presentExternalSessionOperationProgress(progress, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        });

        expect(presentation.effectiveStatus).toBe('cancel_requested');
        expect(presentation.actions).toEqual([
            expect.objectContaining({ kind: 'cancel', enabled: true }),
        ]);
    });

    it('maps validating recovery to Retry for materialize and Resume for persisted takeover', () => {
        const materialize = createProgress({
            status: 'awaiting_user_resume',
            phase: 'validating',
            retryTargetPhase: 'validating',
        });
        const persistedTakeover = createProgress({
            request: {
                plan: 'takeover',
                targetStorageMode: 'persisted',
                targetRuntimeMode: 'terminal',
            },
            status: 'awaiting_user_resume',
            phase: 'validating',
            retryTargetPhase: 'validating',
        });

        expect(presentExternalSessionOperationProgress(materialize, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        }).actions).toEqual([
            expect.objectContaining({ kind: 'retry', titleKey: 'common.retry' }),
            expect.objectContaining({ kind: 'cancel' }),
        ]);
        expect(presentExternalSessionOperationProgress(persistedTakeover, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        }).actions).toEqual([
            expect.objectContaining({ kind: 'resume' }),
            expect.objectContaining({ kind: 'cancel' }),
        ]);
    });

    it.each(['admitting', 'spawning'] as const)(
        'does not expose unsupported persisted-takeover controls for hydrated running/%s',
        (phase) => {
            const progress = createProgress({
                request: {
                    plan: 'takeover',
                    targetStorageMode: 'persisted',
                    targetRuntimeMode: 'terminal',
                },
                status: 'running',
                phase,
            });

            expect(presentExternalSessionOperationProgress(progress, {
                observationContext: 'hydrated',
                originAvailability: 'online',
            }).actions).toEqual([]);
        },
    );

    it('keeps durable progress visible but disables resume when a passive second client sees the origin offline', () => {
        const progress = createProgress({
            status: 'awaiting_user_resume',
            phase: 'importing',
            retryTargetPhase: 'importing',
            checkpoint: {
                sourcePagesRead: 8,
                stagedItemCount: 120,
                importedItemCount: 96,
                totalItemEstimate: 130,
                requiredItemFailures: EMPTY_FAILURES,
            },
        });

        const presentation = presentExternalSessionOperationProgress(progress, {
            observationContext: 'hydrated',
            originAvailability: 'offline',
        });

        expect(presentation.summaryKey).toBe('externalSessions.operationStatusOriginOffline');
        expect(presentation.importProgress).toEqual({
            importedItemCount: 96,
            totalItemEstimate: 130,
            ratio: 96 / 130,
        });
        expect(presentation.actions).toEqual([
            expect.objectContaining({ kind: 'resume', enabled: false }),
            expect.objectContaining({ kind: 'cancel', enabled: false }),
        ]);
    });

    it('offers separately confirmed whole-session discard only for an initial partial fence', () => {
        const initialPartial = createProgress({
            status: 'awaiting_user_resume',
            phase: 'importing',
            retryTargetPhase: 'importing',
            currentStorageState: 'server_partial',
            checkpoint: {
                sourcePagesRead: 2,
                stagedItemCount: 12,
                importedItemCount: 8,
                requiredItemFailures: EMPTY_FAILURES,
                acceptedThroughServerSeq: 8,
            },
            fence: {
                kind: 'initial_server_partial',
                acceptedThroughServerSeq: 8,
            },
        });

        const presentation = presentExternalSessionOperationProgress(initialPartial, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        });

        expect(presentation.summaryKey).toBe('externalSessions.operationStatusImportIncomplete');
        expect(presentation.actions.map((action) => action.kind)).toEqual(['resume', 'cancel', 'discard']);
        expect(presentation.discardRequiresConfirmation).toBe(true);
    });

    it('presents a server-confirmed discard as discarded rather than an incomplete import', () => {
        const discarded = createProgress({
            status: 'discarded',
            phase: 'importing',
            currentStorageState: 'machine_only',
            checkpoint: {
                sourcePagesRead: 0,
                stagedItemCount: 0,
                importedItemCount: 0,
                requiredItemFailures: EMPTY_FAILURES,
            },
            fence: { kind: 'none' },
        });

        const presentation = presentExternalSessionOperationProgress(discarded, {
            observationContext: 'hydrated',
            originAvailability: 'offline',
        });

        expect(presentation.summaryKey).toBe('externalSessions.operationStatusDiscarded');
        expect(presentation.actions).toEqual([
            expect.objectContaining({
                kind: 'dismiss',
                enabled: true,
                destructive: false,
            }),
        ]);
        expect(presentation.discardRequiresConfirmation).toBe(false);
    });

    it.each(['cancelled', 'completed', 'discarded'] as const)(
        'offers local Dismiss only after durable %s progress is pushed',
        (status) => {
            const presentation = presentExternalSessionOperationProgress(createProgress({
                status,
                ...(status === 'completed'
                    ? {
                        request: {
                            plan: 'takeover' as const,
                            targetStorageMode: 'external-linked' as const,
                            targetRuntimeMode: 'terminal' as const,
                        },
                        phase: 'finalizing' as const,
                    }
                    : { phase: 'importing' as const }),
            }), {
                observationContext: 'hydrated',
                originAvailability: 'offline',
            });

            expect(presentation.actions).toEqual([
                expect.objectContaining({
                    kind: 'dismiss',
                    titleKey: 'externalSessions.operationActionDismiss',
                    enabled: true,
                }),
            ]);
        },
    );

    it('preserves the published snapshot and never offers discard for an incomplete catch-up', () => {
        const publication = {
            materializationPublicationId: 'publication-1',
            materializedThroughSourceAt: 100,
            publishedThroughServerSeq: 24,
        };
        const incompleteUpdate = createProgress({
            status: 'failed',
            phase: 'importing',
            retryTargetPhase: 'importing',
            priorStableStorage: {
                state: 'snapshot_complete',
                publication,
            },
            currentStorageState: 'snapshot_complete',
            checkpoint: {
                sourcePagesRead: 2,
                stagedItemCount: 12,
                importedItemCount: 8,
                requiredItemFailures: EMPTY_FAILURES,
                acceptedThroughServerSeq: 28,
            },
            fence: {
                kind: 'incomplete_update',
                publication,
            },
            publication,
            error: {
                code: 'historical_import_failed',
                retryable: false,
                occurredAtMs: 1_700_000_000_000,
            },
        });

        const presentation = presentExternalSessionOperationProgress(incompleteUpdate, {
            observationContext: 'live',
            originAvailability: 'online',
        });

        expect(presentation.summaryKey).toBe('externalSessions.operationStatusUpdateIncomplete');
        expect(presentation.actions).toEqual([]);
        expect(presentation.publishedThroughServerSeq).toBe(24);
    });

    it('offers Resume only for the exact persisted-takeover admission recovery shape', () => {
        const progress = createProgress({
            request: {
                plan: 'takeover',
                targetStorageMode: 'persisted',
                targetRuntimeMode: 'terminal',
            },
            status: 'failed',
            phase: 'admitting',
            retryTargetPhase: 'admitting',
            priorStableStorage: { state: 'machine_only' },
            currentStorageState: 'snapshot_complete',
            fence: { kind: 'none' },
            publication: {
                materializationPublicationId: 'publication-1',
                materializedThroughSourceAt: 100,
                publishedThroughServerSeq: 24,
            },
            error: {
                code: 'admission_failed',
                retryable: true,
                occurredAtMs: 1_700_000_000_000,
            },
        });

        const presentation = presentExternalSessionOperationProgress(progress, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        });

        expect(presentation.effectiveStatus).toBe('failed');
        expect(presentation.actions).toEqual([
            expect.objectContaining({ kind: 'resume', enabled: true }),
        ]);
    });

    it('surfaces an external writer conflict without suggesting an automatic retry', () => {
        const progress = createProgress({
            request: {
                plan: 'takeover',
                targetStorageMode: 'external-linked',
                targetRuntimeMode: 'terminal',
            },
            status: 'failed',
            phase: 'spawning',
            retryTargetPhase: 'admitting',
            error: {
                code: 'external_writer_conflict',
                retryable: false,
                occurredAtMs: 1_700_000_000_000,
            },
        });

        const presentation = presentExternalSessionOperationProgress(progress, {
            observationContext: 'live',
            originAvailability: 'online',
        });

        expect(presentation.summaryKey).toBe('externalSessions.operationStatusExternalWriter');
        expect(presentation.actions).toEqual([]);
    });

    it('does not offer Cancel while an external-linked launch effect may be active', () => {
        const progress = createProgress({
            request: {
                plan: 'takeover',
                targetStorageMode: 'external-linked',
                targetRuntimeMode: 'terminal',
            },
            status: 'running',
            phase: 'spawning',
        });

        expect(presentExternalSessionOperationProgress(progress, {
            observationContext: 'live',
            originAvailability: 'online',
        }).actions).toEqual([]);
    });

    it('offers Cancel to finish an interrupted external-linked cancellation', () => {
        const progress = createProgress({
            request: {
                plan: 'takeover',
                targetStorageMode: 'external-linked',
                targetRuntimeMode: 'terminal',
            },
            status: 'cancel_requested',
            phase: 'admitting',
        });

        expect(presentExternalSessionOperationProgress(progress, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        }).actions).toEqual([
            expect.objectContaining({ kind: 'cancel', enabled: true }),
        ]);
    });

    it.each([
        ['admitting', 'admission_failed'],
        ['spawning', 'spawn_failed'],
    ] as const)('offers Retry and safe Cancel for retryable external-linked %s recovery', (
        phase,
        errorCode,
    ) => {
        const progress = createProgress({
            request: {
                plan: 'takeover',
                targetStorageMode: 'external-linked',
                targetRuntimeMode: 'terminal',
            },
            status: 'failed',
            phase,
            retryTargetPhase: phase,
            error: {
                code: errorCode,
                retryable: true,
                occurredAtMs: 1_700_000_000_000,
            },
        });

        expect(presentExternalSessionOperationProgress(progress, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        }).actions).toEqual([
            expect.objectContaining({
                kind: 'retry',
                titleKey: 'common.retry',
                enabled: true,
            }),
            expect.objectContaining({
                kind: 'cancel',
                titleKey: 'externalSessions.operationActionCancel',
                enabled: true,
            }),
        ]);
    });

    it('keeps a persisted takeover spawn failure explicit even when its source machine is offline', () => {
        const progress = createProgress({
            request: {
                plan: 'takeover',
                targetStorageMode: 'persisted',
                targetRuntimeMode: 'terminal',
            },
            status: 'failed',
            phase: 'spawning',
            priorStableStorage: { state: 'machine_only' },
            currentStorageState: 'hosted',
            retryTargetPhase: 'spawning',
            error: {
                code: 'spawn_failed',
                retryable: true,
                occurredAtMs: 1_700_000_000_000,
            },
        });

        const presentation = presentExternalSessionOperationProgress(progress, {
            observationContext: 'live',
            originAvailability: 'offline',
        });

        expect(presentation.summaryKey)
            .toBe('externalSessions.operationStatusSpawnFailedAfterImport');
        expect(presentation.actions).toEqual([
            expect.objectContaining({
                kind: 'retry_start',
                titleKey: 'externalSessions.operationActionRetryStart',
                enabled: false,
            }),
        ]);
        expect(presentExternalSessionOperationProgress(progress, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        }).actions).toEqual([
            expect.objectContaining({
                kind: 'retry_start',
                titleKey: 'externalSessions.operationActionRetryStart',
                enabled: true,
            }),
        ]);
    });

    it('does not offer Retry start for a non-retryable persisted takeover spawn failure', () => {
        const progress = createProgress({
            request: {
                plan: 'takeover',
                targetStorageMode: 'persisted',
                targetRuntimeMode: 'terminal',
            },
            status: 'failed',
            phase: 'spawning',
            priorStableStorage: { state: 'machine_only' },
            currentStorageState: 'hosted',
            retryTargetPhase: 'spawning',
            error: {
                code: 'spawn_failed',
                retryable: false,
                occurredAtMs: 1_700_000_000_000,
            },
        });

        expect(presentExternalSessionOperationProgress(progress, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        }).actions).toEqual([]);
    });

    it('does not turn canonical-owner disagreement into a resumable action after hydration', () => {
        const progress = createProgress({
            status: 'reconciliation_required',
            phase: 'importing',
            retryTargetPhase: 'importing',
            error: {
                code: 'reconciliation_required',
                retryable: false,
                occurredAtMs: 1_700_000_000_000,
            },
        });

        const presentation = presentExternalSessionOperationProgress(progress, {
            observationContext: 'hydrated',
            originAvailability: 'online',
        });

        expect(presentation.summaryKey).toBe('externalSessions.operationStatusNeedsReview');
        expect(presentation.actions).toEqual([]);
    });
});
