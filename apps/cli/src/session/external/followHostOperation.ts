import { ExternalSessionsAgentIdSchema } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import type { ExternalSessionsSource } from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import {
    acquireCanonicalExternalSessionFollowLease,
    drainCanonicalExternalSessionTranscriptReadAfter,
} from '@/api/session/external/leases/acquireCanonicalExternalSessionFollowLease';
import type {
    createExternalSessionFollowLeaseManager,
    ExternalSessionFollowRefreshResult,
} from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import type { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { resolveExternalSessionObservationLinkInput } from '@/api/session/external/leases/resolveExternalSessionObservationLinkInput';
import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readStoredCredentials } from '@/persistence';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from './agentExternalSessionsInvocation';
import { resolveOccurrenceBoundExternalSessionFollowSurface } from '@/session/actions/externalSessions/providerOpsResolution';

import { mapPluginExternalTranscriptItem, mapPluginExternalTerminalSourceItem } from './pluginExternalSessionsAdapter';
import type {
    HostExternalSessionRef,
    HostExternalSessionFollowTarget,
    HostExternalTranscriptFollowEvent,
    HostExternalTranscriptFollowResult,
} from './privateContract';
import type { ExternalSessionExecutionSurface } from './providerOps';
import type { ExternalSessionHostAccountContext } from './hostOperationOwner';
import { admitProviderSessionFollowSource } from './admitProviderSessionFollowSource';
import { reportExternalSessionFollowAcquisitionFailure, type ExternalSessionFollowReplayDiagnostic } from './followFailureDiagnostic';
import { ExternalSessionFollowFailureError } from './externalSessionFollowFailure';

export type ExternalSessionFollowHostOperationRequest = Readonly<{
    providerSessionTarget?: Pick<HostExternalSessionFollowTarget, 'linkData'>;
    accountContext?: ExternalSessionHostAccountContext;
    pluginId: string;
    contributionId: string;
    occurrenceId: string;
    sessionId: string;
    machineId: string;
    ref: HostExternalSessionRef;
    source: ExternalSessionsSource;
    options: Readonly<{
        cursor?: string;
        initialReplay?: boolean;
        projection?: 'terminal';
        replay?: 'fresh';
        admissionDeadlineAtMs?: number;
        signal?: AbortSignal;
    }>;
    listener: (event: HostExternalTranscriptFollowEvent) => void | Promise<void>;
    retirementSignal?: AbortSignal;
    isCurrent: () => boolean;
    /** Exact generation-private provider callbacks supplied by the runner. */
    providerOps?: Required<Pick<
        ExternalSessionExecutionSurface,
        'pageTranscript' | 'readAfterTranscript'
    >>;
}>;

export type ExternalSessionFollowHostOperation = Readonly<{
    execute(
        request: ExternalSessionFollowHostOperationRequest,
    ): Promise<HostExternalTranscriptFollowResult>;
}>;

type FollowLeaseManager = ReturnType<typeof createExternalSessionFollowLeaseManager>;
type ObservationProjection = ReturnType<typeof createExternalSessionObservationDaemonProjection>;

function unavailable(code: string): HostExternalTranscriptFollowResult {
    return Object.freeze({ status: 'unavailable', code, retryable: false });
}

function terminalAdmissionFailure(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function isRequestCurrent(request: ExternalSessionFollowHostOperationRequest): boolean {
    if (request.options.signal?.aborted || request.retirementSignal?.aborted) return false;
    try {
        return request.isCurrent() === true;
    } catch {
        return false;
    }
}

function readTerminalAdmissionFailureCode(error: unknown): string | null {
    if (error instanceof ExternalSessionFollowFailureError && error.kind === 'follow_unavailable') {
        return 'plugin_external_follow_unavailable';
    }
    if (!(error instanceof Error)) return null;
    const code = Reflect.get(error, 'code');
    return code === 'plugin_external_follow_resync_required'
        || code === 'plugin_external_follow_unavailable'
        || code === 'plugin_operation_aborted'
        || code === 'plugin_generation_retired'
        ? code
        : null;
}

export function createExternalSessionFollowHostOperation(params: Readonly<{
    machineId: string;
    followLeaseManager: Pick<
        FollowLeaseManager,
        'attachScoped' | 'requestTranscriptRefresh'
    >;
    observationProjection: Pick<
        ObservationProjection,
        'reconcileTranscriptDemand'
    >;
}>): ExternalSessionFollowHostOperation {
    return Object.freeze({
        async execute(request) {
            const agentId = ExternalSessionsAgentIdSchema.parse(request.ref.agentId);
            if (
                request.machineId !== params.machineId
                || request.contributionId !== agentId
            ) {
                return unavailable('plugin_external_follow_identity_mismatch');
            }
            if (!isRequestCurrent(request)) {
                return unavailable(
                    request.options.signal?.aborted
                        ? 'plugin_operation_aborted'
                        : 'plugin_generation_retired',
                );
            }
            const credentials = request.accountContext
                ? request.accountContext.credentials
                : await readStoredCredentials().catch(() => null);
            if (!credentials) return unavailable('plugin_external_follow_unavailable');
            const loaded = request.providerSessionTarget
                ? await admitProviderSessionFollowSource({
                    credentials,
                    sessionId: request.sessionId,
                    agentId,
                    machineId: params.machineId,
                    remoteSessionId: request.ref.remoteSessionId,
                    source: request.source,
                    linkData: request.providerSessionTarget.linkData,
                    signal: request.options.signal,
                    deadlineAtMs: request.options.admissionDeadlineAtMs,
                })
                : await loadLinkedExternalSession({
                    credentials,
                    sessionId: request.sessionId,
                    machineId: params.machineId,
                    expectedIdentity: {
                        agentId,
                        machineId: params.machineId,
                        remoteSessionId: request.ref.remoteSessionId,
                        source: request.source,
                    },
                });
            if (!loaded.ok) {
                return unavailable(
                    loaded.error === 'linked_session_identity_mismatch'
                        ? 'plugin_external_follow_identity_mismatch'
                        : loaded.errorCode,
                );
            }
            const resolved = request.providerOps
                ? {
                    providerOps: request.providerOps,
                    occurrenceId: request.occurrenceId,
                    resource: {
                        linkGeneration: loaded.session.linkGeneration,
                        occurrenceId: request.occurrenceId,
                        retirementSignal: request.retirementSignal,
                    },
                }
                : await resolveOccurrenceBoundExternalSessionFollowSurface(
                    loaded.session.agentId,
                    loaded.session.linkGeneration,
                );
            const {
                providerOps,
                resource: resolvedResource,
                occurrenceId,
            } = resolved;
            if (!request.providerOps && occurrenceId !== request.occurrenceId) {
                return unavailable('plugin_generation_retired');
            }
            const observation = await resolveExternalSessionObservationLinkInput({
                linked: loaded.session,
                sessionId: request.sessionId,
                credentials,
            });
            // A runner-carried codec is admitted by its exact service binding;
            // that binding id is not the daemon observer's plugin occurrence.
            // Native observation and scoped-follow custody stay with the
            // canonical daemon resource, retaining both retirement signals.
            const resource = request.providerOps && observation ? {
                linkGeneration: loaded.session.linkGeneration,
                occurrenceId: observation.resource.occurrenceId,
                retirementSignal: AbortSignal.any([
                    ...(request.retirementSignal ? [request.retirementSignal] : []),
                    ...(observation.resource.retirementSignal ? [observation.resource.retirementSignal] : []),
                ]),
            } : resolvedResource;
            const pageTranscript = providerOps.pageTranscript;
            const readAfterTranscript = providerOps.readAfterTranscript;
            if (
                !observation
                || !pageTranscript
                || !readAfterTranscript
            ) {
                return unavailable('plugin_external_follow_unavailable');
            }

            const retirementSignal = AbortSignal.any([
                ...(request.retirementSignal ? [request.retirementSignal] : []),
                ...(resource.retirementSignal ? [resource.retirementSignal] : []),
            ]);
            const combinedSignal = AbortSignal.any([
                ...(request.options.signal ? [request.options.signal] : []),
                retirementSignal,
            ]);
            let delivery = Promise.resolve();
            let replayFailure: ExternalSessionFollowReplayDiagnostic | undefined;
            const emit = (event: HostExternalTranscriptFollowEvent): Promise<void> => {
                const next = delivery.then(async () => await request.listener(event));
                delivery = next.catch(() => undefined);
                return next;
            };
            const replayInitialTranscript = async (): Promise<string> => {
                const fresh = request.options.replay === 'fresh';
                const terminal = fresh || request.options.projection === 'terminal';
                let pageCursor: string | undefined;
                let fromCursor: string | null = null;
                const seenCursors = new Set<string>();
                const replayBatchesNewestFirst: Array<Readonly<{
                    items: Array<ReturnType<typeof mapPluginExternalTerminalSourceItem>>;
                    fetchCursor: string | null;
                }>> = [];
                let replayTailCursor: string | null = null;
                let historicalCutoff: string | null = null;
                while (!replayTailCursor) {
                    combinedSignal.throwIfAborted();
                    if (
                        Date.now() >= (
                            request.options.admissionDeadlineAtMs
                            ?? Number.POSITIVE_INFINITY
                        )
                    ) {
                        throw terminalAdmissionFailure(
                            'plugin_external_follow_resync_required',
                            'External Session initial replay exceeded its admission boundary',
                        );
                    }
                    replayFailure = { operation: 'page_read', cursorKind: pageCursor ? 'continuation' : 'initial',
                        direction: fresh ? 'newer' : 'older' };
                    const page = await pageTranscript({
                        source: loaded.session.source,
                        remoteSessionId: loaded.session.remoteSessionId,
                        direction: fresh ? 'newer' : 'older',
                        ...(terminal ? { projection: 'terminal' as const } : {}),
                        ...(pageCursor ? { cursor: pageCursor } : {}),
                        maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxSerializedBytes,
                        maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxItems,
                        ...(request.options.admissionDeadlineAtMs === undefined
                            ? {}
                            : { deadlineAtMs: request.options.admissionDeadlineAtMs }),
                        signal: combinedSignal,
                    });
                    replayFailure = undefined;
                    if (!fresh && historicalCutoff === null) historicalCutoff = page.tailCursor;
                    if (page.truncated) {
                        throw terminalAdmissionFailure(
                            'plugin_external_follow_resync_required',
                            'External Session initial replay page was incomplete',
                        );
                    }
                    const nextCursor = page.nextCursor ?? page.tailCursor;
                    if (!nextCursor) {
                        throw terminalAdmissionFailure(
                            'plugin_external_follow_unavailable',
                            'External Session initial replay did not provide a cursor',
                        );
                    }
                    if (seenCursors.has(nextCursor)) {
                        throw terminalAdmissionFailure(
                            'plugin_external_follow_cursor_stalled',
                            'External Session initial replay cursor stalled',
                        );
                    }
                    seenCursors.add(nextCursor);
                    const batch = {
                        items: page.items.map(terminal ? mapPluginExternalTerminalSourceItem : mapPluginExternalTranscriptItem),
                        fetchCursor: fresh ? page.nextCursor ?? null : fromCursor,
                    };
                    replayBatchesNewestFirst.push(batch);
                    if (!page.hasMore || !page.nextCursor) {
                        replayTailCursor = historicalCutoff ?? page.tailCursor ?? nextCursor;
                        break;
                    }
                    fromCursor = page.nextCursor;
                    pageCursor = page.nextCursor;
                }
                let emittedFromCursor: string | null = null;
                const replayBatchesOldestFirst = fresh ? replayBatchesNewestFirst : replayBatchesNewestFirst.slice().reverse();
                for (let index = 0; index < replayBatchesOldestFirst.length; index += 1) {
                    const batch = replayBatchesOldestFirst[index]!;
                    const isNewestBatch = index === replayBatchesOldestFirst.length - 1;
                    const emittedNextCursor = isNewestBatch
                        ? replayTailCursor
                        : batch.fetchCursor;
                    if (!emittedNextCursor) {
                        throw terminalAdmissionFailure(
                            'plugin_external_follow_resync_required',
                            'External Session initial replay could not account for its cursor',
                        );
                    }
                    replayFailure = { operation: 'listener_delivery', cursorKind: emittedFromCursor ? 'continuation' : 'initial',
                        direction: fresh ? 'newer' : 'older' };
                    await emit(Object.freeze({
                        kind: 'data',
                        ...(terminal ? { providerSessionId: request.ref.remoteSessionId, source: loaded.session.source } : {}),
                        ...(!fresh ? { phase: 'initial_replay' as const } : {}),
                        items: Object.freeze(batch.items),
                        fromCursor: emittedFromCursor,
                        nextCursor: emittedNextCursor,
                    }));
                    replayFailure = undefined;
                    emittedFromCursor = emittedNextCursor;
                    if (Date.now() >= (
                            request.options.admissionDeadlineAtMs
                            ?? Number.POSITIVE_INFINITY
                        )) {
                        throw terminalAdmissionFailure(
                            'plugin_external_follow_resync_required',
                            'External Session initial replay exceeded its admission deadline',
                        );
                    }
                }
                if (!replayTailCursor) {
                    throw terminalAdmissionFailure(
                        'plugin_external_follow_unavailable',
                        'External Session initial replay did not establish a tail cursor',
                    );
                }
                return replayTailCursor;
            };
            let cursor = request.options.cursor?.trim() || null;
            let startingCursor: string | null = null;
            let scopedLease: Awaited<ReturnType<FollowLeaseManager['attachScoped']>> | null = null;
            let releasePromise: Promise<void> | null = null;
            let terminated = false;
            const removeTerminationListeners = (): void => {
                request.options.signal?.removeEventListener('abort', onCallerAbort);
                retirementSignal.removeEventListener('abort', onRetirement);
            };
            const release = async (): Promise<void> => {
                if (releasePromise) return await releasePromise;
                const lease = scopedLease;
                if (!lease) {
                    removeTerminationListeners();
                    return;
                }
                const attempt = lease.release();
                releasePromise = attempt;
                try {
                    await attempt;
                    if (scopedLease === lease) scopedLease = null;
                    removeTerminationListeners();
                } finally {
                    if (releasePromise === attempt) releasePromise = null;
                }
            };
            const notifyTermination = async (
                reason: Extract<HostExternalTranscriptFollowEvent, { kind: 'terminated' }>['reason'],
                code?: string,
            ): Promise<boolean> => {
                if (terminated) return false;
                terminated = true;
                removeTerminationListeners();
                await emit(Object.freeze({
                    kind: 'terminated',
                    reason,
                    cursor,
                    ...(code ? { code } : {}),
                })).catch(() => undefined);
                return true;
            };
            const terminate = async (
                reason: Extract<HostExternalTranscriptFollowEvent, { kind: 'terminated' }>['reason'],
                code?: string,
            ): Promise<void> => {
                await notifyTermination(reason, code);
                await release();
            };
            function onCallerAbort(): void {
                void terminate('aborted', 'plugin_operation_aborted');
            }
            function onRetirement(): void {
                void terminate('retired', 'plugin_generation_retired');
            }
            request.options.signal?.addEventListener('abort', onCallerAbort, { once: true });
            retirementSignal.addEventListener('abort', onRetirement, { once: true });

            if (Date.now() >= (
                request.options.admissionDeadlineAtMs
                ?? Number.POSITIVE_INFINITY
            )) {
                removeTerminationListeners();
                return unavailable('plugin_external_follow_resync_required');
            }

            let admissionOpen = true;
            let pendingAdmissionRefresh = false;
            const refreshTranscript = async (
                isManagerCurrent: () => boolean,
            ): Promise<ExternalSessionFollowRefreshResult | void> => {
                const isRefreshCurrent = () =>
                    !terminated
                    && isRequestCurrent(request)
                    && isManagerCurrent();
                if (!isRefreshCurrent()) return;
                const requestedCursor = cursor;
                if (!requestedCursor) return;
                const result = await drainCanonicalExternalSessionTranscriptReadAfter({
                    cursor: requestedCursor,
                    isCurrent: isRefreshCurrent,
                    read: async readCursor => await readAfterTranscript({
                        source: loaded.session.source,
                        remoteSessionId: loaded.session.remoteSessionId,
                        cursor: readCursor,
                        ...(request.options.projection ? { projection: request.options.projection } : {}),
                        maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxSerializedBytes,
                        maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxItems,
                        ...(!admissionOpen || request.options.admissionDeadlineAtMs === undefined
                            ? {} : { deadlineAtMs: request.options.admissionDeadlineAtMs }),
                        signal: combinedSignal,
                    }),
                    apply: async (page, fromCursor) => {
                        await emit(Object.freeze({
                            kind: 'data',
                            ...(request.options.projection ? { providerSessionId: request.ref.remoteSessionId, source: loaded.session.source } : {}),
                            items: Object.freeze(page.items.map(request.options.projection === 'terminal'
                                ? mapPluginExternalTerminalSourceItem : mapPluginExternalTranscriptItem)),
                            fromCursor,
                            nextCursor: page.nextCursor,
                        }));
                        if (isRefreshCurrent()) cursor = page.nextCursor;
                    },
                });
                if (!result) return;
                if (result.outcome === 'already_current') {
                    return { outcome: 'already_current' } as const;
                }
                if (
                    result.outcome === 'source_replaced'
                    || result.outcome === 'source_unavailable'
                    || result.outcome === 'read_failed'
                ) {
                    return { outcome: result.outcome } as const;
                }
                if (result.outcome === 'gap_or_cursor_expired') {
                    await emit(Object.freeze({
                        kind: 'resyncRequired',
                        reason: 'cursorDiscontinuity',
                        cursor,
                    }));
                    return {
                        outcome: 'resync_required',
                    } satisfies ExternalSessionFollowRefreshResult;
                }
                return { outcome: 'advanced' } as const;
            };

            let failurePhase: 'admission' | 'replay' = 'admission';
            try {
                try {
                    scopedLease = await params.followLeaseManager.attachScoped({
                        sessionId: request.sessionId,
                        acceptedTailCursor: cursor,
                        resource,
                        acquireFollowLease: async (reacquisitionCursor) =>
                            await acquireCanonicalExternalSessionFollowLease({
                                sessionId: request.sessionId,
                                machineId: params.machineId,
                                linked: loaded.session,
                                ...(request.providerSessionTarget ? { providerSessionTarget: true } : {}),
                                resource,
                                observation,
                                providerOps,
                                initialCursor: reacquisitionCursor ?? cursor,
                                maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxSerializedBytes,
                                maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxItems,
                                ...(request.options.admissionDeadlineAtMs === undefined
                                    ? {}
                                    : { deadlineAtMs: request.options.admissionDeadlineAtMs }),
                                signal: combinedSignal,
                                observationProjection: params.observationProjection,
                                credentials,
                            }),
                        requestTranscriptRefresh: async (_acceptedCursor, isManagerCurrent) => {
                            if (admissionOpen) {
                                pendingAdmissionRefresh = true;
                                return { outcome: 'already_current' } as const;
                            }
                            return await refreshTranscript(isManagerCurrent);
                        },
                        onSourceReplaced: async () => {
                            await notifyTermination(
                                'providerFailure',
                                'follow_refresh_source_replaced',
                            );
                            // The manager just removed this scoped demand as part
                            // of its source-replacement transition. Do not re-enter
                            // it from this notification while it owns that turn.
                            scopedLease = null;
                        },
                    });
                    cursor = cursor ?? scopedLease.acceptedTailCursor ?? null;
                    if (!cursor) {
                        throw terminalAdmissionFailure(
                            'plugin_external_follow_unavailable',
                            'External Session live follow did not establish an accepted cursor',
                        );
                    }
                    if (
                        request.options.initialReplay === true
                        && !request.options.cursor?.trim()
                    ) {
                        failurePhase = 'replay';
                        cursor = await replayInitialTranscript();
                        failurePhase = 'admission';
                    }
                    startingCursor = cursor;
                    admissionOpen = false;
                    if (pendingAdmissionRefresh) {
                        pendingAdmissionRefresh = false;
                        await params.followLeaseManager.requestTranscriptRefresh({
                            sessionId: request.sessionId,
                            resource,
                        });
                    }
                } finally {
                    admissionOpen = false;
                    pendingAdmissionRefresh = false;
                }
                // Cancellation can win while the manager is admitting the scoped
                // lease. `terminate` then has no lease to release yet, so release
                // the just-acquired lease before returning its terminal result.
                if (terminated) {
                    await release();
                    return unavailable(
                        request.options.signal?.aborted
                            ? 'plugin_operation_aborted'
                            : 'plugin_generation_retired',
                    );
                }
                if (Date.now() >= (
                    request.options.admissionDeadlineAtMs
                    ?? Number.POSITIVE_INFINITY
                )) {
                    await release();
                    return unavailable('plugin_external_follow_resync_required');
                }
            } catch (error) {
                await release();
                const terminalAdmissionFailureCode = readTerminalAdmissionFailureCode(error);
                const code = isPluginError(error)
                    ? error.code
                    : terminalAdmissionFailureCode
                        ?? (
                            combinedSignal.aborted
                                ? request.options.signal?.aborted
                                    ? 'plugin_operation_aborted'
                                    : 'plugin_generation_retired'
                                : 'plugin_external_follow_acquisition_failed'
                        );
                const data = reportExternalSessionFollowAcquisitionFailure({ error, code, phase: failurePhase,
                    ...(replayFailure ? { replay: replayFailure } : {}) });
                return Object.freeze({ status: 'unavailable', code, data,
                    retryable: terminalAdmissionFailureCode === null && !combinedSignal.aborted,
                });
            }
            if (!isRequestCurrent(request)) {
                await terminate(
                    request.options.signal?.aborted ? 'aborted' : 'retired',
                    request.options.signal?.aborted
                        ? 'plugin_operation_aborted'
                        : 'plugin_generation_retired',
                );
                return unavailable(
                    request.options.signal?.aborted
                        ? 'plugin_operation_aborted'
                        : 'plugin_generation_retired',
                );
            }
            return Object.freeze({
                status: 'following',
                startingCursor: startingCursor!,
                subscription: Object.freeze({
                    dispose: async () => await terminate('disposed'),
                }),
            });
        },
    });
}
