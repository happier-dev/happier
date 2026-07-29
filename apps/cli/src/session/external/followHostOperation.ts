import {
    ExternalSessionsAgentIdSchema,
    resolveExternalSessionsSourceKey,
    type ExternalSessionsSource,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import {
    acquireCanonicalExternalSessionFollowLease,
    canAttemptCanonicalExternalSessionLiveFollow,
} from '@/api/session/external/leases/acquireCanonicalExternalSessionFollowLease';
import type {
    createExternalSessionFollowLeaseManager,
    ExternalSessionFollowRefreshResult,
} from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import type { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { resolveExternalSessionObservationLinkInput } from '@/api/session/external/leases/resolveExternalSessionObservationLinkInput';
import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readCredentials } from '@/persistence';
import { resolveDefaultMaxBytes, resolveDefaultMaxItems } from '@/session/actions/externalSessions/actionConfiguration';
import { resolveGenerationBoundExternalSessionFollowSurface } from '@/session/actions/externalSessions/providerOpsResolution';

import { mapPluginExternalTranscriptItem } from './pluginExternalSessionsAdapter';
import type {
    HostExternalSessionRef,
    HostExternalSessionsService,
    HostExternalTranscriptFollowEvent,
    HostExternalTranscriptFollowResult,
} from './privateContract';

export type ExternalSessionFollowHostOperationRequest = Readonly<{
    pluginId: string;
    contributionId: string;
    generationId: string;
    sessionId: string;
    machineId: string;
    ref: HostExternalSessionRef;
    source: ExternalSessionsSource;
    options: Parameters<HostExternalSessionsService['followTranscript']>[1];
    listener: Parameters<HostExternalSessionsService['followTranscript']>[2];
    retirementSignal?: AbortSignal;
    isCurrent: () => boolean;
}>;

export type ExternalSessionFollowHostOperation = Readonly<{
    execute(
        request: ExternalSessionFollowHostOperationRequest,
    ): Promise<HostExternalTranscriptFollowResult>;
}>;

type FollowLeaseManager = ReturnType<typeof createExternalSessionFollowLeaseManager>;
type ObservationProjection = ReturnType<typeof createExternalSessionObservationDaemonProjection>;

function unavailable(code: string): HostExternalTranscriptFollowResult {
    return Object.freeze({ status: 'unavailable', code });
}

function isRequestCurrent(request: ExternalSessionFollowHostOperationRequest): boolean {
    if (request.options.signal?.aborted || request.retirementSignal?.aborted) return false;
    try {
        return request.isCurrent() === true;
    } catch {
        return false;
    }
}

export function createExternalSessionFollowHostOperation(params: Readonly<{
    machineId: string;
    followLeaseManager: Pick<
        FollowLeaseManager,
        'attachScoped'
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
                || request.pluginId.trim().length === 0
                || request.generationId.trim().length === 0
                || request.sessionId.trim().length === 0
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
            const credentials = await readCredentials().catch(() => null);
            if (!credentials) return unavailable('plugin_external_follow_unavailable');
            const loaded = await loadLinkedExternalSession({
                credentials,
                sessionId: request.sessionId,
                machineId: params.machineId,
                expectedHostedIdentity: {
                    agentId,
                    machineId: params.machineId,
                    remoteSessionId: request.ref.remoteSessionId,
                    source: request.source,
                },
            });
            if (
                !loaded.ok
                || loaded.session.agentId !== agentId
                || loaded.session.remoteSessionId !== request.ref.remoteSessionId
                || resolveExternalSessionsSourceKey(loaded.session.source)
                    !== resolveExternalSessionsSourceKey(request.source)
            ) {
                return unavailable(
                    loaded.ok ? 'plugin_external_follow_identity_mismatch' : loaded.errorCode,
                );
            }
            const { providerOps, resource } =
                await resolveGenerationBoundExternalSessionFollowSurface(
                    loaded.session.agentId,
                    loaded.session.linkGeneration,
                );
            const observation = await resolveExternalSessionObservationLinkInput({
                linked: loaded.session,
                sessionId: request.sessionId,
            });
            const canObserveTranscript =
                canAttemptCanonicalExternalSessionLiveFollow({
                    observation,
                    resource,
                    providerOps,
                });
            const pageTranscript = providerOps.pageTranscript;
            const readAfterTranscript = providerOps.readAfterTranscript;
            if (
                !canObserveTranscript
                || !observation
                || !pageTranscript
                || !readAfterTranscript
            ) {
                return unavailable('plugin_external_follow_unavailable');
            }

            const combinedSignal = AbortSignal.any([
                ...(request.options.signal ? [request.options.signal] : []),
                ...(request.retirementSignal ? [request.retirementSignal] : []),
            ]);
            let cursor = request.options.cursor?.trim() || null;
            if (!cursor) {
                const baseline = await pageTranscript({
                    source: loaded.session.source,
                    remoteSessionId: loaded.session.remoteSessionId,
                    direction: 'older',
                    maxBytes: resolveDefaultMaxBytes(),
                    maxItems: 1,
                    signal: combinedSignal,
                });
                cursor = baseline.tailCursor;
            }
            if (!cursor || !isRequestCurrent(request)) {
                return unavailable(
                    combinedSignal.aborted
                        ? request.options.signal?.aborted
                            ? 'plugin_operation_aborted'
                            : 'plugin_generation_retired'
                        : 'plugin_external_follow_unavailable',
                );
            }
            const startingCursor = cursor;
            let scopedLease: Awaited<ReturnType<FollowLeaseManager['attachScoped']>> | null = null;
            let terminated = false;
            let delivery = Promise.resolve();
            const emit = (event: HostExternalTranscriptFollowEvent): Promise<void> => {
                const next = delivery.then(async () => await request.listener(event));
                delivery = next.catch(() => undefined);
                return next;
            };
            const release = async (): Promise<void> => {
                request.options.signal?.removeEventListener('abort', onCallerAbort);
                request.retirementSignal?.removeEventListener('abort', onRetirement);
                const lease = scopedLease;
                scopedLease = null;
                await lease?.release();
            };
            const terminate = async (
                reason: Extract<HostExternalTranscriptFollowEvent, { kind: 'terminated' }>['reason'],
                code?: string,
            ): Promise<void> => {
                if (terminated) return;
                terminated = true;
                await emit(Object.freeze({
                    kind: 'terminated',
                    reason,
                    cursor,
                    ...(code ? { code } : {}),
                })).catch(() => undefined);
                await release();
            };
            function onCallerAbort(): void {
                void terminate('aborted', 'plugin_operation_aborted');
            }
            function onRetirement(): void {
                void terminate('retired', 'plugin_generation_retired');
            }
            request.options.signal?.addEventListener('abort', onCallerAbort, { once: true });
            request.retirementSignal?.addEventListener('abort', onRetirement, { once: true });

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
                            resource,
                            observation,
                            providerOps,
                            initialCursor: reacquisitionCursor ?? cursor,
                            maxBytes: resolveDefaultMaxBytes(),
                            maxItems: Math.min(200, resolveDefaultMaxItems()),
                            observationProjection: params.observationProjection,
                            credentials,
                        }),
                    requestTranscriptRefresh: async (_acceptedCursor, isManagerCurrent) => {
                        const isRefreshCurrent = () =>
                            !terminated
                            && isRequestCurrent(request)
                            && isManagerCurrent();
                        if (!isRefreshCurrent()) return;
                        const requestedCursor = cursor;
                        if (!requestedCursor) return;
                        const result = await readAfterTranscript({
                            source: loaded.session.source,
                            remoteSessionId: loaded.session.remoteSessionId,
                            cursor: requestedCursor,
                            maxBytes: resolveDefaultMaxBytes(),
                            maxItems: Math.min(200, resolveDefaultMaxItems()),
                            signal: combinedSignal,
                        });
                        if (!isRefreshCurrent()) return;
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
                        if (
                            result.outcome === 'gap_or_cursor_expired'
                            || result.nextCursor === requestedCursor
                        ) {
                            let recovery: Promise<void> | null = null;
                            return {
                                outcome: 'gap_or_cursor_expired',
                                recover: async () => {
                                    recovery ??= (async () => {
                                        if (!isRefreshCurrent()) {
                                            throw new Error(
                                                'External Session follow changed before resync',
                                            );
                                        }
                                        const page = await pageTranscript({
                                            source: loaded.session.source,
                                            remoteSessionId: loaded.session.remoteSessionId,
                                            direction: 'older',
                                            maxBytes: resolveDefaultMaxBytes(),
                                            maxItems: Math.min(
                                                200,
                                                resolveDefaultMaxItems(),
                                            ),
                                            signal: combinedSignal,
                                        });
                                        if (
                                            !isRefreshCurrent()
                                            || !page.tailCursor
                                        ) {
                                            throw new Error(
                                                'External Session follow changed during resync',
                                            );
                                        }
                                        const priorCursor = cursor;
                                        await emit(Object.freeze({
                                            kind: 'resyncRequired',
                                            reason: 'cursorDiscontinuity',
                                            cursor: priorCursor,
                                        }));
                                        if (!isRefreshCurrent()) {
                                            throw new Error(
                                                'External Session follow changed before resync commit',
                                            );
                                        }
                                        cursor = page.tailCursor;
                                    })();
                                    await recovery;
                                },
                            } satisfies ExternalSessionFollowRefreshResult;
                        }
                        if (!isRefreshCurrent()) return;
                        await emit(Object.freeze({
                            kind: 'data',
                            items: Object.freeze(
                                result.items.map(mapPluginExternalTranscriptItem),
                            ),
                            fromCursor: requestedCursor,
                            nextCursor: result.nextCursor,
                        }));
                        if (!isRefreshCurrent()) return;
                        cursor = result.nextCursor;
                        return { outcome: 'advanced' } as const;
                    },
                });
            } catch (error) {
                await release();
                const code = error instanceof PluginError
                    ? error.code
                    : combinedSignal.aborted
                        ? request.options.signal?.aborted
                            ? 'plugin_operation_aborted'
                            : 'plugin_generation_retired'
                        : 'plugin_external_follow_acquisition_failed';
                return unavailable(code);
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
                startingCursor,
                subscription: Object.freeze({
                    dispose: async () => await terminate('disposed'),
                }),
            });
        },
    });
}
