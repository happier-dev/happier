import { getVoiceAdapterRegistry } from './voiceAdapterRegistry';
import { getVoiceSessionSnapshot } from './voiceSessionStore';
import type { VoiceAdapterController, VoiceAdapterId, VoiceSessionSnapshot } from './types';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import {
    VoiceCaptureBusyError,
    voiceCaptureAdmissionController,
    type VoiceCaptureAdmissionController,
    type VoiceCaptureAdmissionLease,
} from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import {
    readSafeVoiceRuntimeFailureCode,
    recordVoiceRuntimeFailure,
} from '@/voice/runtime/voiceRuntimeFailureCode';

export type VoiceSessionLifecycleController = Readonly<{
    bargeIn: (sessionId: string) => Promise<void>;
    dispose: () => Promise<void>;
    getConfiguredProviderId: () => VoiceAdapterId | 'off' | null;
    getSnapshot: () => VoiceSessionSnapshot;
    interrupt: (sessionId: string) => Promise<void>;
    rearmAfterCredentialAuthorityChange: (options?: Readonly<{
        exactSessionAccountScopeChanged?: boolean;
        globalBindingAuthorityChanged?: boolean;
    }>) => void;
    sendContextUpdate: (sessionId: string, update: string) => void;
    setConfiguredProviderId: (providerId: VoiceAdapterId | 'off' | null) => void;
    setMuted: (sessionId: string, muted: boolean) => Promise<void>;
    stop: (sessionId: string) => Promise<void>;
    subscribe: (listener: () => void) => () => void;
    toggle: (sessionId: string) => Promise<void>;
}>;

type PendingAdapterSwitch = Readonly<{
    sourceAdapterId: string;
    sessionId: string;
    targetAdapterId: string | null;
    startRequested: boolean;
    sourceDisconnectObserved: boolean;
}>;

type StartingAdapter = {
    adapter: VoiceAdapterController;
    sessionId: string;
    expectedSnapshotSessionId: string;
    observedActiveTransition: boolean;
};

function createDisconnectedSnapshot(): VoiceSessionSnapshot {
    return {
        adapterId: null,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
    };
}

function matchesCurrentOwner(current: VoiceSessionSnapshot, candidate: VoiceSessionSnapshot): boolean {
    if (current.canStop !== true || !current.adapterId) return false;
    if (candidate.canStop !== true) return false;
    if (candidate.adapterId !== current.adapterId) return false;
    if (current.sessionId) {
        return candidate.sessionId === current.sessionId;
    }
    return true;
}

function isTerminalProviderAuthFailure(snapshot: VoiceSessionSnapshot): boolean {
    return (snapshot.status === 'disconnected' || snapshot.status === 'error')
        && snapshot.canStop === false
        && snapshot.errorCode === 'provider_auth_invalid';
}

function isTerminalRetryableRecovery(snapshot: VoiceSessionSnapshot): boolean {
    return (snapshot.status === 'disconnected' || snapshot.status === 'error')
        && snapshot.canStop === false
        && (snapshot.errorRecoveryAction === 'retry' || snapshot.errorRecoveryAction === 'reconnect');
}

function isAbortError(error: unknown): boolean {
    return Boolean(error)
        && typeof error === 'object'
        && (error as Readonly<{ name?: unknown }>).name === 'AbortError';
}

export function createVoiceSessionLifecycleController(deps?: Readonly<{
    captureAdmission?: VoiceCaptureAdmissionController;
    getRegistry?: () => ReturnType<typeof getVoiceAdapterRegistry>;
}>): VoiceSessionLifecycleController {
    const getRegistry = deps?.getRegistry ?? getVoiceAdapterRegistry;
    const captureAdmissionOwner =
        deps?.captureAdmission ?? voiceCaptureAdmissionController;
    let configuredProviderId: VoiceAdapterId | 'off' | null = null;
    let publishedSnapshot = getVoiceSessionSnapshot();
    let pendingAdapterSwitch: PendingAdapterSwitch | null = null;
    let suppressedProviderAuthFailureAdapterId: string | null = null;
    let startingAdapter: StartingAdapter | null = null;
    let realtimeCaptureAdmission: Readonly<{
        adapterId: string;
        sessionId: string;
        lease: VoiceCaptureAdmissionLease;
    }> | null = null;
    let disposed = false;
    let disposePromise: Promise<void> | null = null;
    const listeners = new Set<() => void>();
    const adapterUnsubs = new Map<string, () => void>();
    const adapterStopPromises = new Map<string, Promise<void>>();

    const releaseRealtimeCaptureAdmission = (match?: Readonly<{
        adapterId?: string;
        sessionId?: string;
    }>): void => {
        const admission = realtimeCaptureAdmission;
        if (!admission) return;
        if (match?.adapterId && match.adapterId !== admission.adapterId) return;
        if (match?.sessionId && match.sessionId !== admission.sessionId) return;
        realtimeCaptureAdmission = null;
        admission.lease.release();
    };

    const createStartingAdapter = (
        adapter: VoiceAdapterController,
        sessionId: string,
    ): StartingAdapter => ({
        adapter,
        sessionId,
        expectedSnapshotSessionId: sessionId.trim() || VOICE_AGENT_GLOBAL_SESSION_ID,
        observedActiveTransition: false,
    });

    const startAdapter = async (
        adapter: VoiceAdapterController,
        sessionId: string,
        startAttempt = createStartingAdapter(adapter, sessionId),
    ): Promise<void> => {
        if (adapter.engineKind !== 'realtime') {
            startingAdapter = startAttempt;
            try {
                await adapter.start({ sessionId });
            } finally {
                if (startingAdapter === startAttempt) {
                    startingAdapter = null;
                }
            }
            return;
        }
        /*
         * Capture admission is refused before any provider runtime exists, so no
         * machine port can name it: the Start simply never happens while the
         * surface keeps whatever label it already had. Name it here — this owner
         * is the only place that observes the refusal.
         */
        if (realtimeCaptureAdmission) {
            recordVoiceRuntimeFailure(adapter.id, 'unstarted', 'capture_busy', 'voice_capture_busy_conversation');
            throw new VoiceCaptureBusyError('conversation');
        }
        const admission = captureAdmissionOwner.acquire('conversation');
        if (admission.status === 'busy') {
            const busy = new VoiceCaptureBusyError(admission.activeOwner);
            recordVoiceRuntimeFailure(adapter.id, 'unstarted', 'capture_busy', busy.code);
            throw busy;
        }
        realtimeCaptureAdmission = {
            adapterId: adapter.id,
            sessionId,
            lease: admission.lease,
        };
        startingAdapter = startAttempt;
        try {
            await adapter.start({ sessionId });
            if (adapter.getSnapshot().status === 'disconnected') {
                releaseRealtimeCaptureAdmission({
                    adapterId: adapter.id,
                    sessionId,
                });
            }
        } catch (error) {
            releaseRealtimeCaptureAdmission({
                adapterId: adapter.id,
                sessionId,
            });
            throw error;
        } finally {
            if (startingAdapter === startAttempt) {
                startingAdapter = null;
            }
        }
    };

    const stopAdapter = async (
        adapter: VoiceAdapterController,
        sessionId: string,
    ): Promise<void> => {
        const stopKey = `${adapter.id}\u0000${sessionId}`;
        const existingStop = adapterStopPromises.get(stopKey);
        if (existingStop) {
            await existingStop;
            return;
        }
        const stop = (async () => {
            try {
                await adapter.stop({ sessionId });
            } finally {
                releaseRealtimeCaptureAdmission({
                    adapterId: adapter.id,
                    sessionId,
                });
            }
        })();
        adapterStopPromises.set(stopKey, stop);
        try {
            await stop;
        } finally {
            if (adapterStopPromises.get(stopKey) === stop) {
                adapterStopPromises.delete(stopKey);
            }
        }
    };

    const emitChange = () => {
        if (disposed) {
            return;
        }
        for (const listener of listeners) {
            listener();
        }
    };

    const resolveConfiguredAdapter = (): VoiceAdapterController | null => {
        if (disposed) {
            return null;
        }
        if (configuredProviderId === null || configuredProviderId === 'off') {
            return null;
        }
        return getRegistry().get(configuredProviderId);
    };

    const resolveOwnedAdapter = (): Readonly<{
        adapter: VoiceAdapterController;
        snapshot: VoiceSessionSnapshot;
    }> | null => {
        if (disposed) {
            return null;
        }
        const snapshot = publishedSnapshot;
        if (snapshot.status === 'disconnected' || snapshot.canStop !== true || !snapshot.adapterId) {
            return null;
        }

        const adapter = getRegistry().get(snapshot.adapterId);
        if (!adapter) {
            return null;
        }

        return {
            adapter,
            snapshot,
        };
    };

    const computeSnapshot = (): VoiceSessionSnapshot => {
        if (disposed) {
            return publishedSnapshot;
        }
        const registry = getRegistry();
        const adapters = registry.list();
        const snapshots = adapters.map((adapter) => adapter.getSnapshot());
        const pending = pendingAdapterSwitch;
        if (pending) {
            const sourceSnapshot = snapshots.find((snapshot) => snapshot.adapterId === pending.sourceAdapterId) ?? null;
            const targetSnapshot =
                pending.targetAdapterId !== null
                    ? snapshots.find((snapshot) => snapshot.adapterId === pending.targetAdapterId) ?? null
                    : null;

            if (pending.startRequested) {
                if (targetSnapshot && targetSnapshot.status !== 'disconnected') {
                    return targetSnapshot;
                }
                return createDisconnectedSnapshot();
            }

            if (!pending.sourceDisconnectObserved) {
                if (sourceSnapshot && sourceSnapshot.status !== 'disconnected') {
                    return sourceSnapshot;
                }
                pendingAdapterSwitch = {
                    ...pending,
                    sourceDisconnectObserved: true,
                };
            }

            return targetSnapshot ?? createDisconnectedSnapshot();
        }

        const owned = snapshots.find((snapshot) => matchesCurrentOwner(publishedSnapshot, snapshot)) ?? null;
        if (owned) {
            return owned;
        }

        if (configuredProviderId === null || configuredProviderId === 'off') {
            return createDisconnectedSnapshot();
        }

        // Only the configured provider may surface as active or terminal. The machine now
        // carries its owning adapterId, so non-owning adapters already project a
        // disconnected snapshot; a blind `find(status !== 'disconnected')`
        // fallback would let a stale/non-configured adapter snapshot (or a
        // lingering error) hijack the published session. Keep the configured
        // provider's error-bearing disconnected projection so recoverable
        // failures such as microphone denial remain visible after teardown.
        const preferred = snapshots.find(
            (snapshot) => snapshot.adapterId === configuredProviderId
                && (snapshot.status !== 'disconnected' || Boolean(snapshot.errorCode?.trim()))
                && !(
                    snapshot.adapterId === suppressedProviderAuthFailureAdapterId
                    && isTerminalProviderAuthFailure(snapshot)
                ),
        );
        return preferred ?? createDisconnectedSnapshot();
    };

    const reconcilePendingSwitch = () => {
        if (disposed) {
            pendingAdapterSwitch = null;
            return;
        }
        const pending = pendingAdapterSwitch;
        if (pending) {
            if (
                pending.targetAdapterId
                && pending.startRequested
                && publishedSnapshot.adapterId === pending.targetAdapterId
                && publishedSnapshot.status !== 'disconnected'
            ) {
                pendingAdapterSwitch = null;
                return;
            }

            const sourceStillOwnsSession =
                publishedSnapshot.adapterId === pending.sourceAdapterId && publishedSnapshot.status !== 'disconnected';
            if (sourceStillOwnsSession) {
                return;
            }

            if (pending.startRequested) {
                return;
            }

            const targetAdapterId = configuredProviderId === 'off' ? null : configuredProviderId;
            if (!targetAdapterId || targetAdapterId === pending.sourceAdapterId) {
                pendingAdapterSwitch = null;
                return;
            }

            const targetAdapter = getRegistry().get(targetAdapterId);
            if (!targetAdapter) {
                pendingAdapterSwitch = null;
                return;
            }

            const startedSwitch: PendingAdapterSwitch = {
                ...pending,
                targetAdapterId,
                startRequested: true,
            };
            pendingAdapterSwitch = startedSwitch;
            void startAdapter(targetAdapter, pending.sessionId)
                .catch(() => {
                    // A failed target start must not leave a dangling pending
                    // switch pinning the published snapshot to `disconnected`
                    // forever; clear it if it is still ours.
                    if (pendingAdapterSwitch === startedSwitch) {
                        pendingAdapterSwitch = null;
                    }
                })
                .finally(() => {
                    publishSnapshot();
                    // If the target start settled without ever reaching a
                    // connected snapshot (rejected, or resolved without
                    // connecting), drop the dangling switch and republish a
                    // clean disconnected snapshot. A successful connect already
                    // cleared `pendingAdapterSwitch` via reconcilePendingSwitch.
                    if (pendingAdapterSwitch === startedSwitch && publishedSnapshot.status === 'disconnected') {
                        pendingAdapterSwitch = null;
                        publishSnapshot();
                    }
                });
            return;
        }

        if (
            publishedSnapshot.status === 'disconnected'
            || !publishedSnapshot.adapterId
            || publishedSnapshot.adapterId === configuredProviderId
            || !publishedSnapshot.sessionId
        ) {
            return;
        }

        const sourceAdapter = getRegistry().get(publishedSnapshot.adapterId);
        if (!sourceAdapter) {
            return;
        }

        pendingAdapterSwitch = {
            sourceAdapterId: publishedSnapshot.adapterId,
            sessionId: publishedSnapshot.sessionId,
            targetAdapterId: null,
            startRequested: false,
            sourceDisconnectObserved: false,
        };

        void stopAdapter(sourceAdapter, publishedSnapshot.sessionId).finally(() => {
            publishSnapshot();
        });
    };

    const publishSnapshot = () => {
        if (disposed) {
            return publishedSnapshot;
        }
        publishedSnapshot = computeSnapshot();
        const startAttempt = startingAdapter;
        if (
            startAttempt
            && publishedSnapshot.adapterId === startAttempt.adapter.id
            && publishedSnapshot.sessionId === startAttempt.expectedSnapshotSessionId
            && publishedSnapshot.canStop === true
        ) {
            startAttempt.observedActiveTransition = true;
        }
        const admission = realtimeCaptureAdmission;
        if (admission) {
            const adapter = getRegistry().get(admission.adapterId);
            const snapshot = adapter?.getSnapshot();
            if (!adapter || snapshot?.status === 'disconnected' || snapshot?.canStop !== true) {
                releaseRealtimeCaptureAdmission({
                    adapterId: admission.adapterId,
                    sessionId: admission.sessionId,
                });
            }
        }
        emitChange();
        reconcilePendingSwitch();
        return publishedSnapshot;
    };

    const refreshAdapterSubscriptions = () => {
        const adapters = getRegistry().list();
        const currentIds = new Set(adapters.map((adapter) => adapter.id));
        for (const [adapterId, unsubscribe] of adapterUnsubs) {
            if (currentIds.has(adapterId)) continue;
            adapterUnsubs.delete(adapterId);
            try { unsubscribe(); } catch { /* ignore teardown failures */ }
        }
        for (const adapter of adapters) {
            if (adapterUnsubs.has(adapter.id)) continue;
            const unsubscribe = adapter.subscribe?.(() => publishSnapshot());
            if (typeof unsubscribe === 'function') adapterUnsubs.set(adapter.id, unsubscribe);
        }
    };
    refreshAdapterSubscriptions();
    const unsubscribeRegistry = getRegistry().subscribe?.(() => {
        refreshAdapterSubscriptions();
        publishSnapshot();
    });

    return {
        bargeIn: async (sessionId) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (!owned?.adapter.bargeIn) return;
            await owned.adapter.bargeIn({ sessionId: owned.snapshot.sessionId ?? sessionId });
        },
        dispose: () => {
            if (disposePromise) return disposePromise;
            const owned = resolveOwnedAdapter();
            const disposalTargets = new Map<string, Readonly<{
                adapter: VoiceAdapterController;
                sessionId: string;
            }>>();
            if (owned) {
                const sessionId = owned.snapshot.sessionId ?? publishedSnapshot.sessionId ?? '';
                disposalTargets.set(`${owned.adapter.id}\u0000${sessionId}`, {
                    adapter: owned.adapter,
                    sessionId,
                });
            }
            if (startingAdapter) {
                disposalTargets.set(
                    `${startingAdapter.adapter.id}\u0000${startingAdapter.sessionId}`,
                    startingAdapter,
                );
            }
            const admission = realtimeCaptureAdmission;
            if (admission) {
                const adapter = getRegistry().get(admission.adapterId);
                if (adapter) {
                    disposalTargets.set(`${adapter.id}\u0000${admission.sessionId}`, {
                        adapter,
                        sessionId: admission.sessionId,
                    });
                }
            }
            disposed = true;
            pendingAdapterSwitch = null;
            unsubscribeRegistry?.();
            for (const unsub of adapterUnsubs.values()) {
                try {
                    unsub();
                } catch {
                    // ignore unsubscribe failures during teardown
                }
            }
            adapterUnsubs.clear();
            listeners.clear();
            const disposal = (async () => {
                if (disposalTargets.size === 0) {
                    releaseRealtimeCaptureAdmission();
                    return;
                }
                await Promise.allSettled(
                    [...disposalTargets.values()].map(
                        async (target) => await stopAdapter(target.adapter, target.sessionId),
                    ),
                );
                releaseRealtimeCaptureAdmission();
            })();
            disposePromise = disposal;
            return disposal;
        },
        getSnapshot: () => publishedSnapshot,
        getConfiguredProviderId: () => configuredProviderId,
        interrupt: async (sessionId) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (!owned) return;
            await owned.adapter.interrupt({ sessionId: owned.snapshot.sessionId ?? sessionId });
        },
        rearmAfterCredentialAuthorityChange: (options) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            const stopTargets = new Map<string, Readonly<{
                adapter: VoiceAdapterController;
                sessionId: string;
            }>>();
            // Broad account/settings observations only rearm a terminal auth
            // presentation for a later explicit Start. The runtime reports
            // exact-session Account changes and global-binding changes, but
            // this owner classifies the live target from its start/attachment
            // session id. Ordinary providers retain their admitted attempt.
            const fencesSession = (sessionId: string): boolean => (
                options?.exactSessionAccountScopeChanged === true
                || (
                    options?.globalBindingAuthorityChanged === true
                    && sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
                )
            );
            if (startingAdapter && fencesSession(startingAdapter.sessionId)) {
                stopTargets.set(
                    `${startingAdapter.adapter.id}\u0000${startingAdapter.sessionId}`,
                    startingAdapter,
                );
            }
            if (owned) {
                const sessionId = owned.snapshot.sessionId ?? publishedSnapshot.sessionId ?? '';
                if (fencesSession(sessionId)) {
                    stopTargets.set(`${owned.adapter.id}\u0000${sessionId}`, {
                        adapter: owned.adapter,
                        sessionId,
                    });
                }
            }
            if (stopTargets.size > 0) {
                void Promise.allSettled(
                    [...stopTargets.values()].map(
                        async (target) => await stopAdapter(target.adapter, target.sessionId),
                    ),
                ).then(() => {
                    publishSnapshot();
                });
                return;
            }
            if (!isTerminalProviderAuthFailure(publishedSnapshot)) return;
            suppressedProviderAuthFailureAdapterId = publishedSnapshot.adapterId;
            publishSnapshot();
        },
        sendContextUpdate: (sessionId, update) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (owned) {
                owned.adapter.sendContextUpdate({ sessionId: owned.snapshot.sessionId ?? sessionId, update });
                return;
            }

            const adapter = resolveConfiguredAdapter();
            if (!adapter) return;
            adapter.sendContextUpdate({ sessionId, update });
        },
        setConfiguredProviderId: (providerId) => {
            if (disposed) return;
            if (providerId !== configuredProviderId) {
                suppressedProviderAuthFailureAdapterId = null;
            }
            configuredProviderId = providerId;
            publishSnapshot();
        },
        setMuted: async (sessionId, muted) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (!owned) return;
            await owned.adapter.setMuted({ sessionId: owned.snapshot.sessionId ?? sessionId, muted });
        },
        stop: async (sessionId) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (!owned) return;
            const ownedSessionId = owned.snapshot.sessionId ?? sessionId;
            await stopAdapter(owned.adapter, ownedSessionId);
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        toggle: async (sessionId) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (owned) {
                await stopAdapter(
                    owned.adapter,
                    owned.snapshot.sessionId ?? sessionId,
                );
                return;
            }

            const adapter = resolveConfiguredAdapter();
            if (!adapter) {
                /*
                 * A selected provider whose adapter is absent from the registry —
                 * withdrawn while its plugin projection re-installs, or never
                 * registered — makes Start a no-op: no request, no microphone, no
                 * state change, and a surface still showing its previous label.
                 * It is the one Start refusal with no other observer.
                 */
                if (configuredProviderId !== null && configuredProviderId !== 'off') {
                    recordVoiceRuntimeFailure(
                        configuredProviderId,
                        'unstarted',
                        'adapter_unavailable',
                        'voice_provider_adapter_not_registered',
                    );
                }
                return;
            }
            if (suppressedProviderAuthFailureAdapterId === adapter.id) {
                suppressedProviderAuthFailureAdapterId = null;
            }
            const startAttempt = createStartingAdapter(adapter, sessionId);
            try {
                await startAdapter(adapter, sessionId, startAttempt);
            } catch (error) {
                const settledSnapshot = publishedSnapshot;
                const isCurrentPublishedFailure = configuredProviderId === adapter.id
                    && startAttempt.observedActiveTransition
                    && settledSnapshot.adapterId === adapter.id
                    && settledSnapshot.sessionId === startAttempt.expectedSnapshotSessionId
                    && isTerminalRetryableRecovery(settledSnapshot);
                /*
                 * Realtime adapters publish their terminal recovery before
                 * rejecting the Start. That is an expected, already-visible
                 * attempt outcome: consumers recover from the snapshot, while
                 * surfacing the rejection again through fire-and-forget makes
                 * Expo hide that recovery behind its development error overlay.
                 *
                 * The terminal snapshot must follow this Start's own active
                 * transition for its exact control session and name the same
                 * safe error code. Every other rejection remains observable:
                 * a prior error republished by the registry, a provider
                 * switch, cancellation, a non-retryable recovery, an
                 * unexpected rejection after a recovery snapshot, and a
                 * failure that never entered this current attempt.
                 */
                if (
                    !isAbortError(error)
                    && isCurrentPublishedFailure
                    && settledSnapshot.errorCode === readSafeVoiceRuntimeFailureCode(error)
                ) {
                    return;
                }
                throw error;
            }
        },
    };
}
