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
    setCurrentUiContextToolSetEnabled: (enabled: boolean) => void;
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
    restartForCurrentUiContextTools: boolean;
    startedCurrentUiContextToolSetEnabled: boolean | null;
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

function requiresCurrentUiContextToolSetReplacement(
    adapter: VoiceAdapterController,
    enabled: boolean,
): boolean {
    // Realtime tool definitions are frozen for a connection. Local Agent Voice
    // seeds its model session once, so only the restrictive off transition
    // needs to replace it; restoring disclosure applies on a later attempt.
    // Local direct lacks the Agent text-turn capability, hence no model-session
    // tool catalog to retire.
    return adapter.engineKind === 'realtime'
        || (enabled === false && typeof adapter.sendTextTurn === 'function');
}

export function createVoiceSessionLifecycleController(deps?: Readonly<{
    captureAdmission?: VoiceCaptureAdmissionController;
    getRegistry?: () => ReturnType<typeof getVoiceAdapterRegistry>;
}>): VoiceSessionLifecycleController {
    const getRegistry = deps?.getRegistry ?? getVoiceAdapterRegistry;
    const captureAdmissionOwner =
        deps?.captureAdmission ?? voiceCaptureAdmissionController;
    let configuredProviderId: VoiceAdapterId | 'off' | null = null;
    let currentUiContextToolSetEnabled: boolean | null = null;
    let publishedSnapshot = getVoiceSessionSnapshot();
    let pendingAdapterSwitch: PendingAdapterSwitch | null = null;
    let suppressedProviderAuthFailureAdapterId: string | null = null;
    let startingAdapter: StartingAdapter | null = null;
    let realtimeCaptureAdmission: Readonly<{
        adapter: VoiceAdapterController;
        adapterId: string;
        sessionId: string;
        lease: VoiceCaptureAdmissionLease;
    }> | null = null;
    let retiredAttemptStopStarted = false;
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
        retiredAttemptStopStarted = false;
        admission.lease.release();
    };

    /*
     * Withdrawing a provider's registration removes it from SELECTION; it does
     * not terminalize the media the retired adapter is still running, and it
     * does not move Stop authority. The admitted attempt is therefore resolved
     * from the exact adapter this owner started, not from current registry
     * membership — otherwise a withdrawal publishes idle and hands global
     * capture admission to another product while the old microphone is live.
     */
    const resolveAttemptAdapter = (adapterId: string): VoiceAdapterController | null => {
        const admitted = realtimeCaptureAdmission?.adapter ?? null;
        if (admitted && admitted.id === adapterId) return admitted;
        return getRegistry().get(adapterId);
    };

    /** Registered adapters plus the admitted attempt owner they may no longer list. */
    const listAttemptAdapters = (): ReadonlyArray<VoiceAdapterController> => {
        const adapters = getRegistry().list();
        const admitted = realtimeCaptureAdmission?.adapter ?? null;
        if (!admitted || adapters.includes(admitted)) return adapters;
        return [...adapters, admitted];
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
            adapter,
            adapterId: adapter.id,
            sessionId,
            lease: admission.lease,
        };
        retiredAttemptStopStarted = false;
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

        const adapter = resolveAttemptAdapter(snapshot.adapterId);
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
        const adapters = listAttemptAdapters();
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
                const targetAdapter = resolveAttemptAdapter(pending.targetAdapterId);
                if (!targetAdapter) {
                    pendingAdapterSwitch = null;
                    return;
                }
                const toolSetChangedDuringRestart = pending.restartForCurrentUiContextTools
                    && pending.startedCurrentUiContextToolSetEnabled !== null
                    && currentUiContextToolSetEnabled !== null
                    && pending.startedCurrentUiContextToolSetEnabled !== currentUiContextToolSetEnabled
                    && requiresCurrentUiContextToolSetReplacement(targetAdapter, currentUiContextToolSetEnabled);
                if (!toolSetChangedDuringRestart) {
                    pendingAdapterSwitch = null;
                    return;
                }
                pendingAdapterSwitch = {
                    sourceAdapterId: targetAdapter.id,
                    sessionId: pending.sessionId,
                    targetAdapterId: targetAdapter.id,
                    startRequested: false,
                    sourceDisconnectObserved: false,
                    restartForCurrentUiContextTools: true,
                    startedCurrentUiContextToolSetEnabled: null,
                };
                void stopAdapter(targetAdapter, pending.sessionId).finally(() => {
                    publishSnapshot();
                });
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
            if (
                !targetAdapterId
                || (
                    targetAdapterId === pending.sourceAdapterId
                    && !pending.restartForCurrentUiContextTools
                )
            ) {
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
                startedCurrentUiContextToolSetEnabled:
                    pending.restartForCurrentUiContextTools
                        ? currentUiContextToolSetEnabled
                        : null,
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

        const sourceAdapter = resolveAttemptAdapter(publishedSnapshot.adapterId);
        if (!sourceAdapter) {
            return;
        }

        pendingAdapterSwitch = {
            sourceAdapterId: publishedSnapshot.adapterId,
            sessionId: publishedSnapshot.sessionId,
            targetAdapterId: null,
            startRequested: false,
            sourceDisconnectObserved: false,
            restartForCurrentUiContextTools: false,
            startedCurrentUiContextToolSetEnabled: null,
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
            const snapshot = admission.adapter.getSnapshot();
            if (snapshot.status === 'disconnected' || snapshot.canStop !== true) {
                releaseRealtimeCaptureAdmission({
                    adapterId: admission.adapterId,
                    sessionId: admission.sessionId,
                });
            } else if (
                !retiredAttemptStopStarted
                && getRegistry().get(admission.adapterId) !== admission.adapter
            ) {
                /*
                 * The projection that owned this adapter has withdrawn it, so
                 * nothing will ask it to stop through selection any more. Retire
                 * the attempt through the same coalesced Stop the surface uses:
                 * its settlement — not registry absence — is what releases
                 * capture admission and lets this owner publish idle.
                 */
                retiredAttemptStopStarted = true;
                void stopAdapter(admission.adapter, admission.sessionId).finally(() => {
                    publishSnapshot();
                });
            }
        }
        emitChange();
        reconcilePendingSwitch();
        return publishedSnapshot;
    };

    const refreshAdapterSubscriptions = () => {
        const adapters = listAttemptAdapters();
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

    const stopForCurrentUiContextToolSetRestart = (
        adapter: VoiceAdapterController,
        sessionId: string,
    ): void => {
        void (async () => {
            await stopAdapter(adapter, sessionId);
            const pending = pendingAdapterSwitch;
            if (
                pending?.restartForCurrentUiContextTools
                && pending.sourceAdapterId === adapter.id
                && pending.sessionId === sessionId
                && !pending.startRequested
                && adapter.getSnapshot().status !== 'disconnected'
            ) {
                // A prior stop may have been coalesced while its replacement
                // reached connected. Retire that now-current attachment rather
                // than leaving this newer disclosure transition stranded.
                await stopAdapter(adapter, sessionId);
            }
        })().finally(() => {
            publishSnapshot();
        });
    };

    const cancelPendingCurrentUiContextToolSetRestart = (): StartingAdapter | null => {
        const pending = pendingAdapterSwitch;
        if (!pending?.restartForCurrentUiContextTools) {
            return null;
        }
        pendingAdapterSwitch = null;
        const startAttempt = startingAdapter;
        if (
            startAttempt
            && startAttempt.adapter.id === pending.targetAdapterId
            && startAttempt.sessionId === pending.sessionId
        ) {
            return startAttempt;
        }
        return null;
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
                disposalTargets.set(`${admission.adapter.id}\u0000${admission.sessionId}`, {
                    adapter: admission.adapter,
                    sessionId: admission.sessionId,
                });
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
            if (options?.exactSessionAccountScopeChanged === true) {
                // A queued provider/tool-set transition belongs to the Account
                // authority that admitted it. Retire that intent before an
                // in-flight source stop can settle and reconcile the target.
                pendingAdapterSwitch = null;
            }
            const owned = resolveOwnedAdapter();
            const stopTargets = new Map<string, Readonly<{
                adapter: VoiceAdapterController;
                sessionId: string;
            }>>();
            // Credential/settings revisions only rearm a terminal auth
            // presentation for a later explicit Start, so an ordinary provider
            // keeps its admitted attempt. A server-Account scope change is not
            // credential currentness: it retires every starting or attached
            // attempt, whatever provider owns it. Global-binding changes stay
            // specific to the global Agent session, which this owner
            // classifies from its start/attachment session id.
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
        setCurrentUiContextToolSetEnabled: (enabled) => {
            if (disposed || currentUiContextToolSetEnabled === enabled) return;
            const previous = currentUiContextToolSetEnabled;
            currentUiContextToolSetEnabled = enabled;
            if (previous === null) return;

            const pending = pendingAdapterSwitch;
            if (pending) {
                if (pending.restartForCurrentUiContextTools) {
                    // Keep this serialized transition current. Realtime will
                    // retire a started stale schema; Local Agent only retires
                    // on the restrictive boundary and otherwise waits for its
                    // next explicit attempt.
                    publishSnapshot();
                }
                if (!pending.restartForCurrentUiContextTools) {
                    const pendingTargetAdapterId = pending.targetAdapterId
                        ?? (configuredProviderId === 'off' ? null : configuredProviderId);
                    const pendingTargetAdapter = pendingTargetAdapterId
                        ? getRegistry().get(pendingTargetAdapterId)
                        : null;
                    if (
                        pendingTargetAdapter
                        && requiresCurrentUiContextToolSetReplacement(pendingTargetAdapter, enabled)
                    ) {
                        // A normal provider hand-off has already chosen its
                        // target, but it may have captured the old tool-set
                        // boundary before disclosure became restrictive. Fold
                        // that replacement into this serialized hand-off.
                        pendingAdapterSwitch = {
                            ...pending,
                            restartForCurrentUiContextTools: true,
                            startedCurrentUiContextToolSetEnabled:
                                pending.startRequested ? previous : null,
                        };
                        publishSnapshot();
                    }
                }
                return;
            }

            const owned = resolveOwnedAdapter();
            if (
                !owned
                || !owned.snapshot.sessionId
                || !requiresCurrentUiContextToolSetReplacement(owned.adapter, enabled)
            ) {
                return;
            }

            /*
             * Reuse this owner's serialized switch path so a disclosure change
             * that freezes into an active provider/model session retires the
             * exact attempt before constructing its replacement.
             */
            pendingAdapterSwitch = {
                sourceAdapterId: owned.adapter.id,
                sessionId: owned.snapshot.sessionId,
                targetAdapterId: owned.adapter.id,
                startRequested: false,
                sourceDisconnectObserved: false,
                restartForCurrentUiContextTools: true,
                startedCurrentUiContextToolSetEnabled: null,
            };
            stopForCurrentUiContextToolSetRestart(owned.adapter, owned.snapshot.sessionId);
        },
        setMuted: async (sessionId, muted) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (!owned) return;
            await owned.adapter.setMuted({ sessionId: owned.snapshot.sessionId ?? sessionId, muted });
        },
        stop: async (sessionId) => {
            if (disposed) return;
            const cancelledRestartStart = cancelPendingCurrentUiContextToolSetRestart();
            const owned = resolveOwnedAdapter();
            if (!owned) {
                if (cancelledRestartStart) {
                    await stopAdapter(cancelledRestartStart.adapter, cancelledRestartStart.sessionId);
                }
                return;
            }
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
            const cancelledRestartStart = cancelPendingCurrentUiContextToolSetRestart();
            const owned = resolveOwnedAdapter();
            if (owned) {
                await stopAdapter(
                    owned.adapter,
                    owned.snapshot.sessionId ?? sessionId,
                );
                return;
            }
            if (cancelledRestartStart) {
                await stopAdapter(cancelledRestartStart.adapter, cancelledRestartStart.sessionId);
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
