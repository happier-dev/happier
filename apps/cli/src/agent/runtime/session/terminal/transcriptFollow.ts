import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';

import type {
  HostExternalTranscriptFollowEvent,
  HostExternalTranscriptFollowResult,
} from '@/session/external/privateContract';
import type { CommittedTranscriptLocalIdBaseline } from '@/api/session/client/transcript/committedTranscriptLocalIdBaseline';
import {
    EXTERNAL_SESSIONS_INVOCATION_POLICY,
    invokeBoundedExternalSessionsOperation,
} from '@/session/external/agentExternalSessionsInvocation';
import type { ExternalSessionTerminalFollowProjectionAdmission } from '@/session/external/terminalFollowProjection';

import type {
    HostTerminalTranscriptFollowBinding,
    HostTerminalTranscriptFollowBindResult,
    HostTerminalTranscriptFollowService,
} from './contract';

function unavailable(
    code: string,
): Extract<HostTerminalTranscriptFollowBindResult, { status: 'unavailable' }> {
    return Object.freeze({ status: 'unavailable', code });
}

function terminalFollowFailure(
    code: string,
    message: string,
): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    return error;
}

function normalizeTerminalFollowFailure(error: unknown): Error {
    return error instanceof Error
        ? error
        : terminalFollowFailure(
            'plugin_external_follow_failed',
            'External Session transcript follow failed',
        );
}

function readTerminalFollowUnavailableCode(error: unknown): string | null {
    if (!(error instanceof Error)) return null;
    const code = Reflect.get(error, 'code');
    if (
        code === 'runtime_transcript_required_admission_failed'
        && Reflect.get(error, 'reason') === 'admission_expired'
    ) {
        return 'plugin_external_follow_resync_required';
    }
    return code === 'plugin_external_follow_resync_required'
        || code === 'plugin_external_follow_unavailable'
        || code === 'plugin_operation_aborted'
        || code === 'plugin_generation_retired'
        ? code
        : null;
}

export function createHostTerminalTranscriptFollowService(params: Readonly<{
    loadCommittedLocalIdBaseline?(input: Readonly<{
        signal: AbortSignal;
        deadlineAtMs: number;
    }>): Promise<CommittedTranscriptLocalIdBaseline>;
    followProviderSession(
        request: Readonly<{
            agentId: string;
            providerSessionId: string;
            initialReplay?: boolean;
            replay?: 'fresh';
            admissionDeadlineAtMs?: number;
            signal: AbortSignal;
        }>,
        listener: (
            event: HostExternalTranscriptFollowEvent,
        ) => void | Promise<void>,
    ): Promise<HostExternalTranscriptFollowResult>;
    signal: AbortSignal;
    publish(
        event: HostExternalTranscriptFollowEvent,
        admission?: ExternalSessionTerminalFollowProjectionAdmission,
    ): void | Promise<void>;
}>): HostTerminalTranscriptFollowService {
    const activeBindings = new Set<HostTerminalTranscriptFollowBinding>();

    const releaseActiveBindings = async (): Promise<void> => {
        const bindings = Array.from(activeBindings);
        const results = await Promise.allSettled(
            bindings.map(async (binding) => await binding.dispose()),
        );
        const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failure) throw failure.reason;
    };

    const sourceService: HostTerminalTranscriptFollowService = Object.freeze({
        async bindProviderSession(request) {
            if (params.signal.aborted || request.signal?.aborted) {
                const result = unavailable('plugin_operation_aborted');
                return result;
            }
            // `agentId` is Happier/manifest-owned and must already be canonical.
            // `providerSessionId` is the Agent's own opaque identity, so padding
            // is part of those bytes -- only blankness disqualifies it.
            if (
                request.agentId.length === 0
                || request.agentId !== request.agentId.trim()
                || readNonBlankOpaqueIdentifier(request.providerSessionId) === null
            ) {
                const result = unavailable('plugin_external_follow_identity_mismatch');
                return result;
            }
            const admissionDeadlineAtMs =
                Date.now() + EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs;
            const bindingAbort = new AbortController();
            const signal = AbortSignal.any([
                params.signal,
                bindingAbort.signal,
                ...(request.signal ? [request.signal] : []),
            ]);
            let failureReported = false;
            let resolveFailure!: (error: Error) => void;
            const failure = new Promise<Error>((resolve) => {
                resolveFailure = resolve;
            });
            const reportFailure = (error: unknown): void => {
                if (failureReported) return;
                failureReported = true;
                resolveFailure(normalizeTerminalFollowFailure(error));
            };
            let result: HostExternalTranscriptFollowResult;
            try {
                const loadCommittedLocalIdBaseline =
                    params.loadCommittedLocalIdBaseline;
                if (!loadCommittedLocalIdBaseline) {
                    const unavailableResult = unavailable(
                        'plugin_external_follow_unavailable',
                    );
                    return unavailableResult;
                }
                const baselineResult = await invokeBoundedExternalSessionsOperation({
                    signal,
                    retirementSignal: params.signal,
                    isCurrent: () => !params.signal.aborted,
                    deadlineAtMs: admissionDeadlineAtMs,
                    operation: (baselineSignal, deadlineAtMs) => loadCommittedLocalIdBaseline({ signal: baselineSignal, deadlineAtMs }),
                });
                if (baselineResult.status !== 'fulfilled') {
                    throw terminalFollowFailure(
                        baselineResult.status === 'timeout' ? 'plugin_external_follow_resync_required'
                            : baselineResult.status === 'cancelled' || baselineResult.status === 'retired'
                                ? 'plugin_operation_aborted' : 'plugin_external_follow_unavailable',
                        'Committed transcript baseline could not be loaded',
                    );
                }
                if (Date.now() >= admissionDeadlineAtMs) {
                    throw terminalFollowFailure('plugin_external_follow_resync_required', 'Committed transcript baseline exceeded admission');
                }
                const committedBaseline = baselineResult.value;
                if (!committedBaseline.complete) {
                    throw terminalFollowFailure('plugin_external_follow_unavailable', 'Committed transcript baseline is incomplete');
                }
                const committedLocalIds = new Set(committedBaseline.localIds);
                let admittingSource = true;
                result = await params.followProviderSession(
                    {
                        agentId: request.agentId,
                        providerSessionId: request.providerSessionId,
                        initialReplay: true,
                        ...(request.replay === 'fresh' ? { replay: request.replay } : {}),
                        admissionDeadlineAtMs,
                        signal,
                    },
                    async (event) => {
                        const isInitialReplay =
                            event.kind === 'data'
                            && event.phase === 'initial_replay';
                        let publishEvent = event;
                        if (isInitialReplay) {
                            const items = event.items.filter((item) => {
                                const localId = item.localId ?? item.id;
                                return !committedLocalIds.has(localId);
                            });
                            publishEvent = Object.freeze({
                                ...event,
                                items: Object.freeze(items),
                            });
                        }
                        try {
                            if (!admittingSource) {
                                await params.publish(publishEvent, { signal });
                            } else {
                                const publication =
                                    await invokeBoundedExternalSessionsOperation({
                                        signal,
                                        retirementSignal: params.signal,
                                        isCurrent: () => !params.signal.aborted,
                                        deadlineAtMs: admissionDeadlineAtMs,
                                        operation: async (
                                            publicationSignal,
                                            deadlineAtMs,
                                        ) => {
                                            try {
                                                await params.publish(publishEvent, {
                                                    signal: publicationSignal,
                                                    deadlineAtMs,
                                                });
                                                return undefined;
                                            } catch (error) {
                                                if (
                                                    readTerminalFollowUnavailableCode(error)
                                                    === 'plugin_external_follow_resync_required'
                                                ) {
                                                    return 'admission_expired' as const;
                                                }
                                                throw error;
                                            }
                                        },
                                    });
                                if (
                                    publication.status === 'fulfilled'
                                    && publication.value === 'admission_expired'
                                ) {
                                    throw terminalFollowFailure(
                                        'plugin_external_follow_resync_required',
                                        'Initial transcript publication exceeded the follow admission deadline',
                                    );
                                }
                                if (publication.status === 'timeout') {
                                    throw terminalFollowFailure(
                                        'plugin_external_follow_resync_required',
                                        'Initial transcript publication exceeded the follow admission deadline',
                                    );
                                }
                                if (publication.status === 'cancelled') {
                                    throw terminalFollowFailure(
                                        'plugin_operation_aborted',
                                        'Initial transcript publication was cancelled',
                                    );
                                }
                                if (publication.status === 'retired') {
                                    throw terminalFollowFailure(
                                        'plugin_generation_retired',
                                        'Initial transcript publication belongs to a retired generation',
                                    );
                                }
                                if (publication.status === 'rejected') {
                                    throw terminalFollowFailure(
                                        'plugin_external_follow_unavailable',
                                        'Initial transcript publication was unavailable',
                                    );
                                }
                            }
                        } catch (error) {
                            reportFailure(error);
                            throw error;
                        }
                        if (event.kind === 'data') {
                            for (const item of event.items) {
                                const localId = item.localId ?? item.id;
                                if (localId.trim().length > 0) {
                                    committedLocalIds.add(localId);
                                }
                            }
                        }
                        if (
                            event.kind === 'terminated'
                            && (
                                event.reason === 'providerFailure'
                                || event.reason === 'resyncRequired'
                            )
                        ) {
                            reportFailure(terminalFollowFailure(
                                event.code
                                    ?? 'plugin_external_follow_terminated',
                                'External Session transcript follow terminated',
                            ));
                        }
                    },
                );
                admittingSource = false;
            } catch (error) {
                bindingAbort.abort();
                const code = readTerminalFollowUnavailableCode(error);
                if (code) {
                    return unavailable(code);
                }
                throw error;
            }
            if (result.status === 'unavailable') {
                bindingAbort.abort();
                const code = result.code === 'plugin_operation_deadline_exceeded'
                    ? 'plugin_external_follow_resync_required'
                    : result.code;
                return unavailable(code);
            }
            if (result.failure) {
                void result.failure.then(
                    reportFailure,
                    reportFailure,
                );
            }

            let disposePromise: Promise<void> | null = null;
            const binding: HostTerminalTranscriptFollowBinding = Object.freeze({
                failure,
                async dispose() {
                    if (disposePromise) {
                        return await disposePromise;
                    }
                    const attempt = (async () => {
                        await result.subscription.dispose();
                        activeBindings.delete(binding);
                        bindingAbort.abort();
                    })();
                    disposePromise = attempt;
                    try {
                        await attempt;
                    } catch (error) {
                        reportFailure(error);
                        if (disposePromise === attempt) {
                            disposePromise = null;
                        }
                        throw error;
                    }
                },
            });
            activeBindings.add(binding);
            if (signal.aborted) {
                await binding.dispose();
                const result = unavailable('plugin_operation_aborted');
                return result;
            }
            return Object.freeze({
                status: 'following',
                startingCursor: result.startingCursor,
                binding,
            });
        },
        releaseActiveBindings,
    });

    type SharedBinding = {
        references: number;
        abort: AbortController;
        acquisition: Promise<HostTerminalTranscriptFollowBindResult>;
    };
    const sharedBindings = new Map<string, SharedBinding>();
    const service: HostTerminalTranscriptFollowService = Object.freeze({
        async bindProviderSession(request) {
            if (params.signal.aborted || request.signal?.aborted) return unavailable('plugin_operation_aborted');
            if (request.replay !== undefined && request.replay !== 'fresh' && request.replay !== 'historical') {
                return unavailable('plugin_external_follow_identity_mismatch');
            }
            const key = JSON.stringify([request.agentId, request.providerSessionId]);
            let shared = sharedBindings.get(key);
            if (!shared) {
                const abort = new AbortController();
                const acquisition = sourceService.bindProviderSession({ ...request, signal: abort.signal });
                shared = { references: 0, abort, acquisition };
                sharedBindings.set(key, shared);
                const entry = shared;
                void acquisition.then((result) => {
                    if (result.status === 'unavailable' && sharedBindings.get(key) === entry) sharedBindings.delete(key);
                }, () => {
                    if (sharedBindings.get(key) === entry) sharedBindings.delete(key);
                });
            }
            const entry = shared;
            entry.references += 1;
            let released = false;
            let releasePromise: Promise<void> | null = null;
            const release = (): Promise<void> => {
                if (releasePromise) return releasePromise;
                if (!released) {
                    released = true;
                    request.signal?.removeEventListener('abort', onAbort);
                    entry.references -= 1;
                }
                if (entry.references > 0) return Promise.resolve();
                if (sharedBindings.get(key) === entry) sharedBindings.delete(key);
                entry.abort.abort();
                const attempt = entry.acquisition.then(async (result) => {
                    if (result.status === 'following') await result.binding.dispose();
                }, () => undefined);
                releasePromise = attempt.catch((error) => {
                    releasePromise = null;
                    throw error;
                });
                return releasePromise;
            };
            let resolveCancellation!: (result: HostTerminalTranscriptFollowBindResult) => void;
            const cancellation = new Promise<HostTerminalTranscriptFollowBindResult>((resolve) => { resolveCancellation = resolve; });
            const onAbort = () => {
                resolveCancellation(unavailable('plugin_operation_aborted'));
                void release().catch(() => undefined); // The source binding reports disposal failure through its failure signal.
            };
            request.signal?.addEventListener('abort', onAbort, { once: true });
            if (request.signal?.aborted) onAbort();
            try {
                const result = await Promise.race([entry.acquisition, cancellation]);
                if (result.status === 'unavailable' || released) {
                    await release();
                    return result.status === 'unavailable' ? result : unavailable('plugin_operation_aborted');
                }
                return Object.freeze({ ...result, binding: Object.freeze({ failure: result.binding.failure, dispose: release }) });
            } catch (error) {
                await release();
                throw error;
            }
        },
        async releaseActiveBindings() {
            for (const entry of sharedBindings.values()) entry.abort.abort();
            const acquisitions = Array.from(sharedBindings.values(), (entry) => entry.acquisition);
            sharedBindings.clear();
            await Promise.allSettled(acquisitions);
            await releaseActiveBindings();
        },
    });

    const releaseOnAbort = () => {
        void service.releaseActiveBindings().catch(() => undefined);
    };
    if (params.signal.aborted) releaseOnAbort();
    else params.signal.addEventListener('abort', releaseOnAbort, { once: true });

    return service;
}
