import { getVoiceAdapterRegistry } from './voiceAdapterRegistry';
import { canDismissVoiceSessionFailedAttempt, getVoiceSessionSnapshot, recordVoiceSessionEndReason, type VoiceSessionEndReason } from './voiceSessionStore';
import type { VoiceAdapterController, VoiceAdapterId, VoiceSessionSnapshot } from './types';
import type { VoiceHeldInput } from '@/voice/runtime/controller/VoiceConversationController';
import type { Message } from '@happier-dev/session-core/messages';
import type {
    VoiceOutputFocusApplication,
    VoiceOutputFocusState,
} from '@happier-dev/plugin-sdk/voice/client';
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
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import {
    areSessionAddressesEqual,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';

export type VoiceSessionLifecycleController = Readonly<{
    observeSyncedConversationMessages: (address: SessionAddress, messages: readonly Message[]) => void;
    bargeIn: (sessionId: string) => Promise<void>;
    dispose: () => Promise<void>;
    getConfiguredProviderId: () => VoiceAdapterId | 'off' | null;
    getSnapshot: () => VoiceSessionSnapshot;
    getAttemptTargetSessionAddress: () => SessionAddress | null;
    interrupt: (sessionId: string) => Promise<void>;
    commitInput: (sessionId: string) => Promise<void>;
    beginHoldToTalk: (sessionId: string) => VoiceHeldInput | null;
    finishHoldToTalk: (sessionId: string, outcome: 'release' | 'cancel') => Promise<boolean>;
    rearmAfterCredentialAuthorityChange: (options?: Readonly<{
        exactSessionAccountScopeChanged?: boolean;
        globalBindingAuthorityChanged?: boolean;
    }>) => void;
    sendContextUpdate: (sessionId: string, update: string) => void;
    setConfiguredProviderId: (providerId: VoiceAdapterId | 'off' | null) => void;
    setCurrentUiContextToolSetEnabled: (enabled: boolean) => void;
    setMuted: (sessionId: string, muted: boolean) => Promise<void>;
    suspendInput: (sessionId: string) => Promise<Readonly<{
        release(): Promise<void>;
    }> | null>;
    retry: (sessionId: string) => Promise<void>;
    dismissFailedAttempt: (sessionId: string | null) => Promise<void>;
    setOutputFocusState?: (
        sessionId: string,
        state: VoiceOutputFocusState,
    ) => Promise<VoiceOutputFocusApplication>;
    stop: (sessionId: string, reason?: Exclude<VoiceSessionEndReason, { kind: 'disconnected' }>) => Promise<void>;
    subscribe: (listener: () => void) => () => void;
    toggle: (targetSessionAddress: SessionAddress | null) => Promise<void>;
}>;

type PendingAdapterSwitch = Readonly<{
    sourceAdapterId: string;
    sessionId: string;
    requestedTargetSessionAddress: SessionAddress | null;
    targetAdapterId: string | null;
    startRequested: boolean;
    sourceDisconnectObserved: boolean;
    restartForCurrentUiContextTools: boolean;
    startedCurrentUiContextToolSetEnabled: boolean | null;
}>;

type StartingAdapter = {
    adapter: VoiceAdapterController;
    sessionId: string;
    requestedTargetSessionAddress: SessionAddress | null;
    expectedSnapshotSessionId: string;
    observedActiveTransition: boolean;
};

type VoiceRecoveryBinding = Readonly<{
    providerId: VoiceAdapterId;
    sessionId: string;
    requestedTargetSessionAddress: SessionAddress | null;
}>;

type MuteAttemptOwner = {
    adapter: VoiceAdapterController;
    sessionId: string;
    userMuted: boolean;
    appliedMuted: boolean;
    userRevision: number;
    suspensions: Set<object>;
    tail: Promise<void>;
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

function createUnavailableConfiguredProviderSnapshot(
    providerId: VoiceAdapterId,
    sessionId: string,
): VoiceSessionSnapshot {
    const failure = createVoiceMachineError({
        kind: 'service_temporarily_unavailable',
        reason: 'voice_provider_adapter_not_registered',
    });
    return {
        adapterId: providerId,
        sessionId,
        status: 'error',
        mode: 'idle',
        canStop: false,
        errorCode: failure.kind,
        errorMessage: failure.reason,
        errorRecoveryAction: failure.recoveryAction,
        errorPresentation: failure.presentation,
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

function requiresCurrentUiContextToolSetReplacement(adapter: VoiceAdapterController): boolean {
    // Realtime tool definitions are frozen for a connection. Local Agent Voice
    // seeds its model session once, so either tool-catalog boundary needs to
    // replace it. Local direct lacks the Agent text-turn capability, hence no
    // model-session tool catalog to retire.
    return adapter.engineKind === 'realtime' || typeof adapter.sendTextTurn === 'function';
}

export function createVoiceSessionLifecycleController(deps?: Readonly<{
    onSyncedConversationMessages?: (address: SessionAddress, messages: readonly Message[]) => void;
    captureAdmission?: VoiceCaptureAdmissionController;
    acquireConnectivityLease?: () => () => void;
    getRegistry?: () => ReturnType<typeof getVoiceAdapterRegistry>;
}>): VoiceSessionLifecycleController {
    const getRegistry = deps?.getRegistry ?? getVoiceAdapterRegistry;
    const captureAdmissionOwner =
        deps?.captureAdmission ?? voiceCaptureAdmissionController;
    const acquireConnectivityLease = deps?.acquireConnectivityLease ?? (() => () => {});
    let configuredProviderId: VoiceAdapterId | 'off' | null = null;
    let currentUiContextToolSetEnabled: boolean | null = null;
    // Recovery intent outlives capture/connectivity, but never its Account or
    // explicit End/provider-selection authority. Home cannot be rebuilt from
    // a session id, including when two Homes contain that same id.
    let recoveryBinding: VoiceRecoveryBinding | null = null;
    let publishedSnapshot = getVoiceSessionSnapshot();
    let pendingAdapterSwitch: PendingAdapterSwitch | null = null;
    let suppressedTerminalFailureAdapterId: string | null = null;
    let startingAdapter: StartingAdapter | null = null;
    let realtimeCaptureAdmission: Readonly<{
        adapter: VoiceAdapterController;
        adapterId: string;
        sessionId: string;
        lease: VoiceCaptureAdmissionLease;
    }> | null = null;
    let attemptConnectivityLease: Readonly<{
        adapter: VoiceAdapterController;
        sessionId: string;
        requestedTargetSessionAddress: SessionAddress | null;
        release: () => void;
    }> | null = null;
    let retiredAttemptStopStarted = false;
    let muteAttemptOwner: MuteAttemptOwner | null = null;
    let heldInput: Readonly<{ sessionId: string; adapter: VoiceAdapterController; handle: VoiceHeldInput }> | null = null;
    let disposed = false;
    let disposePromise: Promise<void> | null = null;
    const listeners = new Set<() => void>();
    const adapterUnsubs = new Map<VoiceAdapterController, () => void>();
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
        if (!disposed) {
            refreshAdapterSubscriptions();
        }
    };

    const releaseAttemptConnectivityLease = (match?: Readonly<{
        adapter?: VoiceAdapterController;
        sessionId?: string;
    }>): void => {
        const lease = attemptConnectivityLease;
        if (!lease) return;
        if (match?.adapter && match.adapter !== lease.adapter) return;
        if (match?.sessionId && match.sessionId !== lease.sessionId) return;
        attemptConnectivityLease = null;
        lease.release();
    };

    const ensureAttemptConnectivityLease = (
        adapter: VoiceAdapterController,
        sessionId: string,
        requestedTargetSessionAddress: SessionAddress | null,
    ): void => {
        const current = attemptConnectivityLease;
        if (current?.adapter === adapter && current.sessionId === sessionId) return;
        releaseAttemptConnectivityLease();
        attemptConnectivityLease = {
            adapter,
            sessionId,
            requestedTargetSessionAddress,
            release: acquireConnectivityLease(),
        };
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
        requestedTargetSessionAddress: SessionAddress | null,
    ): StartingAdapter => {
        const ownedSessionId = sessionId.trim() ? sessionId : VOICE_AGENT_GLOBAL_SESSION_ID;
        return {
            adapter,
            sessionId: ownedSessionId,
            requestedTargetSessionAddress,
            expectedSnapshotSessionId: ownedSessionId,
            observedActiveTransition: false,
        };
    };

    const startAdapter = async (
        adapter: VoiceAdapterController,
        sessionId: string,
        requestedTargetSessionAddress: SessionAddress | null,
        startAttempt = createStartingAdapter(adapter, sessionId, requestedTargetSessionAddress),
    ): Promise<void> => {
        heldInput = null;
        const ownedSessionId = startAttempt.expectedSnapshotSessionId;
        if (adapter.engineKind !== 'realtime') {
            recoveryBinding = { providerId: adapter.id, sessionId: ownedSessionId, requestedTargetSessionAddress };
            ensureAttemptConnectivityLease(adapter, ownedSessionId, requestedTargetSessionAddress);
            startingAdapter = startAttempt;
            try {
                await adapter.start({ sessionId, requestedTargetSessionAddress });
                if (getRegistry().get(adapter.id) !== adapter) {
                    // Registration withdrawal is a synchronous authority
                    // boundary. A provider that finishes setup afterwards
                    // must be terminalized again so late Start settlement
                    // cannot regain media or tool authority.
                    await stopAdapter(adapter, ownedSessionId);
                }
                if (adapter.getSnapshot().status === 'disconnected') {
                    releaseAttemptConnectivityLease({ adapter, sessionId: ownedSessionId });
                }
            } catch (error) {
                releaseAttemptConnectivityLease({ adapter, sessionId: ownedSessionId });
                throw error;
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
        ensureAttemptConnectivityLease(adapter, ownedSessionId, requestedTargetSessionAddress);
        recoveryBinding = { providerId: adapter.id, sessionId: ownedSessionId, requestedTargetSessionAddress };
        realtimeCaptureAdmission = {
            adapter,
            adapterId: adapter.id,
            sessionId: ownedSessionId,
            lease: admission.lease,
        };
        retiredAttemptStopStarted = false;
        startingAdapter = startAttempt;
        try {
            await adapter.start({ sessionId, requestedTargetSessionAddress });
            if (getRegistry().get(adapter.id) !== adapter) {
                await stopAdapter(adapter, ownedSessionId);
                return;
            }
            if (adapter.getSnapshot().status === 'disconnected') {
                releaseRealtimeCaptureAdmission({
                    adapterId: adapter.id,
                    sessionId: ownedSessionId,
                });
                releaseAttemptConnectivityLease({ adapter, sessionId: ownedSessionId });
            }
        } catch (error) {
            releaseRealtimeCaptureAdmission({
                adapterId: adapter.id,
                sessionId: ownedSessionId,
            });
            releaseAttemptConnectivityLease({ adapter, sessionId: ownedSessionId });
            throw error;
        } finally {
            if (startingAdapter === startAttempt) {
                startingAdapter = null;
            }
        }
    };

    const adapterStopKey = (adapterId: string, sessionId: string): string => (
        `${adapterId}\u0000${sessionId}`
    );

    const stopAdapter = async (
        adapter: VoiceAdapterController,
        sessionId: string,
    ): Promise<void> => {
        const stopKey = adapterStopKey(adapter.id, sessionId);
        const existingStop = adapterStopPromises.get(stopKey);
        if (existingStop) {
            await existingStop;
            return;
        }
        const stop = (async () => {
            try {
                await adapter.stop({ sessionId });
            } finally {
                if (heldInput?.adapter === adapter && heldInput.sessionId === sessionId) heldInput = null;
                releaseRealtimeCaptureAdmission({
                    adapterId: adapter.id,
                    sessionId,
                });
                releaseAttemptConnectivityLease({ adapter, sessionId });
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

    const resolveMuteAttemptOwner = (
        owned: NonNullable<ReturnType<typeof resolveOwnedAdapter>>,
    ): MuteAttemptOwner => {
        const sessionId = owned.snapshot.sessionId ?? '';
        const current = muteAttemptOwner;
        if (current?.adapter === owned.adapter && current.sessionId === sessionId) {
            return current;
        }
        const muted = owned.snapshot.micMuted === true;
        const replacement: MuteAttemptOwner = {
            adapter: owned.adapter,
            sessionId,
            userMuted: muted,
            appliedMuted: muted,
            userRevision: 0,
            suspensions: new Set(),
            tail: Promise.resolve(),
        };
        muteAttemptOwner = replacement;
        return replacement;
    };

    const applyMuteAttemptOwner = (owner: MuteAttemptOwner): Promise<boolean> => {
        const operation = owner.tail.then(async () => {
            if (disposed || muteAttemptOwner !== owner) return false;
            const owned = resolveOwnedAdapter();
            if (
                owned?.adapter !== owner.adapter
                || (owned.snapshot.sessionId ?? '') !== owner.sessionId
            ) {
                return false;
            }
            const effectiveMuted = owner.userMuted || owner.suspensions.size > 0;
            // A hold can temporarily open capture even while user Mute remains true.
            // Retire that admission before the unchanged-policy fast path as well.
            if (effectiveMuted) {
                await owner.adapter.cancelHoldToTalk?.({ sessionId: owner.sessionId });
                if (muteAttemptOwner !== owner) return false;
            }
            if (effectiveMuted === owner.appliedMuted) return true;
            await owner.adapter.setMuted({ sessionId: owner.sessionId, muted: effectiveMuted });
            if (muteAttemptOwner !== owner) return false;
            owner.appliedMuted = effectiveMuted;
            return true;
        });
        owner.tail = operation.then(() => undefined, () => undefined);
        return operation;
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

        const unavailable = recoveryBinding;
        if (
            unavailable?.providerId === configuredProviderId
            && !getRegistry().get(unavailable.providerId)
        ) {
            return createUnavailableConfiguredProviderSnapshot(
                unavailable.providerId,
                unavailable.sessionId,
            );
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
                    snapshot.adapterId === suppressedTerminalFailureAdapterId
                    && canDismissVoiceSessionFailedAttempt(snapshot)
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
                    && requiresCurrentUiContextToolSetReplacement(targetAdapter);
                if (!toolSetChangedDuringRestart) {
                    pendingAdapterSwitch = null;
                    return;
                }
                pendingAdapterSwitch = {
                    sourceAdapterId: targetAdapter.id,
                    sessionId: pending.sessionId,
                    requestedTargetSessionAddress: pending.requestedTargetSessionAddress,
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

            // Adapters may publish `disconnected` before their Stop promise
            // settles. Keep this existing serialized hand-off behind that
            // exact Stop so capture/connectivity admission is released before
            // the replacement attempt starts.
            if (adapterStopPromises.has(adapterStopKey(pending.sourceAdapterId, pending.sessionId))) {
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
            void startAdapter(
                targetAdapter,
                pending.sessionId,
                pending.requestedTargetSessionAddress,
            )
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
            requestedTargetSessionAddress:
                attemptConnectivityLease?.adapter === sourceAdapter
                && attemptConnectivityLease.sessionId === publishedSnapshot.sessionId
                    ? attemptConnectivityLease.requestedTargetSessionAddress
                    : null,
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
        if (publishedSnapshot.status === 'disconnected' || publishedSnapshot.canStop !== true) {
            // Input preference and native suspension leases belong to one
            // admitted attempt. A later attempt, even through the same adapter
            // and control-session id, starts from its own runtime snapshot.
            muteAttemptOwner = null;
            // A Start owns connectivity before the adapter has an active
            // snapshot. Initial/retiring snapshot emissions during that
            // interval must not tear the lease out from under the pending
            // provider watch. Start failure/settlement owns that release.
            if (!startingAdapter) {
                releaseAttemptConnectivityLease();
            }
        }
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

    function refreshAdapterSubscriptions(): void {
        const adapters = listAttemptAdapters();
        const currentAdapters = new Set(adapters);
        for (const [adapter, unsubscribe] of adapterUnsubs) {
            if (currentAdapters.has(adapter)) continue;
            adapterUnsubs.delete(adapter);
            try { unsubscribe(); } catch { /* ignore teardown failures */ }
        }
        for (const adapter of adapters) {
            if (adapterUnsubs.has(adapter)) continue;
            const unsubscribe = adapter.subscribe?.(() => publishSnapshot());
            if (typeof unsubscribe === 'function') adapterUnsubs.set(adapter, unsubscribe);
        }
    }

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

    const toggle = async (requestedTargetSessionAddress: SessionAddress | null): Promise<void> => {
        if (disposed) return;
        const sessionId = requestedTargetSessionAddress?.sessionId ?? '';
        const cancelledRestartStart = cancelPendingCurrentUiContextToolSetRestart();
        const owned = resolveOwnedAdapter();
        if (owned) {
            recoveryBinding = null;
            recordVoiceSessionEndReason(owned.adapter.id, owned.snapshot.sessionId ?? sessionId, { kind: 'stopped' });
            await stopAdapter(
                owned.adapter,
                owned.snapshot.sessionId ?? sessionId,
            );
            return;
        }
        if (cancelledRestartStart) {
            recoveryBinding = null;
            await stopAdapter(cancelledRestartStart.adapter, cancelledRestartStart.sessionId);
            return;
        }
        const pendingStartAttempt = startingAdapter;
        if (pendingStartAttempt) {
            recoveryBinding = null;
            await stopAdapter(pendingStartAttempt.adapter, pendingStartAttempt.sessionId);
            return;
        }

        const adapter = resolveConfiguredAdapter();
        if (!adapter) {
            /*
             * A selected provider whose adapter is absent from the registry —
             * withdrawn while its plugin projection re-installs, or never
             * registered — must refuse Start before capture admission and name
             * that refusal through this lifecycle owner.
             */
            if (configuredProviderId !== null && configuredProviderId !== 'off') {
                const unavailable: VoiceRecoveryBinding = {
                    providerId: configuredProviderId,
                    sessionId: sessionId.trim() || VOICE_AGENT_GLOBAL_SESSION_ID,
                    requestedTargetSessionAddress,
                };
                if (
                    recoveryBinding?.providerId === unavailable.providerId
                    && recoveryBinding.sessionId === unavailable.sessionId
                    && (
                        recoveryBinding.requestedTargetSessionAddress
                            === unavailable.requestedTargetSessionAddress
                        || areSessionAddressesEqual(
                            recoveryBinding.requestedTargetSessionAddress,
                            unavailable.requestedTargetSessionAddress,
                        )
                    )
                ) {
                    return;
                }
                recoveryBinding = unavailable;
                recordVoiceRuntimeFailure(
                    configuredProviderId,
                    'unstarted',
                    'adapter_unavailable',
                    'voice_provider_adapter_not_registered',
                );
                publishSnapshot();
            }
            return;
        }
        if (suppressedTerminalFailureAdapterId === adapter.id) {
            suppressedTerminalFailureAdapterId = null;
        }
        const startAttempt = createStartingAdapter(adapter, sessionId, requestedTargetSessionAddress);
        try {
            await startAdapter(adapter, sessionId, requestedTargetSessionAddress, startAttempt);
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
    };
    refreshAdapterSubscriptions();
    const unsubscribeRegistry = getRegistry().subscribe?.(() => {
        refreshAdapterSubscriptions();
        const withdrawnStart = startingAdapter;
        if (
            withdrawnStart
            && getRegistry().get(withdrawnStart.adapter.id) !== withdrawnStart.adapter
        ) {
            // Stop immediately at withdrawal. The post-Start currentness check
            // above repeats Stop after a late successful settlement, which is
            // necessary when the provider's first cancellation settles before
            // its pending setup promise does.
            void stopAdapter(withdrawnStart.adapter, withdrawnStart.sessionId).finally(() => {
                publishSnapshot();
            });
        }
        publishSnapshot();
    });

    return {
        observeSyncedConversationMessages: (address, messages) => {
            if (!disposed) deps?.onSyncedConversationMessages?.(address, messages);
        },
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
            recoveryBinding = null;
            muteAttemptOwner = null;
            heldInput = null;
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
                    releaseAttemptConnectivityLease();
                    return;
                }
                await Promise.allSettled(
                    [...disposalTargets.values()].map(
                        async (target) => await stopAdapter(target.adapter, target.sessionId),
                    ),
                );
                releaseRealtimeCaptureAdmission();
                releaseAttemptConnectivityLease();
            })();
            disposePromise = disposal;
            return disposal;
        },
        getSnapshot: () => publishedSnapshot,
        getAttemptTargetSessionAddress: () => startingAdapter?.requestedTargetSessionAddress
            ?? attemptConnectivityLease?.requestedTargetSessionAddress
            ?? recoveryBinding?.requestedTargetSessionAddress ?? null,
        getConfiguredProviderId: () => configuredProviderId,
        interrupt: async (sessionId) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (!owned) return;
            await owned.adapter.interrupt({ sessionId: owned.snapshot.sessionId ?? sessionId });
        },
        commitInput: async (sessionId) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (!owned || owned.snapshot.sessionId !== sessionId
                || owned.snapshot.status !== 'connected'
                || owned.snapshot.canCommitInput !== true) return;
            await owned.adapter.commitInput?.({ sessionId });
        },
        beginHoldToTalk: (sessionId) => {
            if (disposed) return null;
            const owned = resolveOwnedAdapter();
            if (!owned || owned.snapshot.sessionId !== sessionId
                || owned.snapshot.status !== 'connected' || owned.snapshot.canHoldToTalk !== true
                || resolveMuteAttemptOwner(owned).suspensions.size > 0) return null;
            const handle = owned.adapter.beginHoldToTalk?.({ sessionId }) ?? null;
            if (!handle) return null;
            const finish = async (outcome: 'release' | 'cancel') => {
                try { await handle[outcome](); }
                finally { if (heldInput?.handle === wrapper) heldInput = null; }
            };
            const wrapper: VoiceHeldInput = Object.freeze({ ready: handle.ready, release: () => finish('release'), cancel: () => finish('cancel') });
            heldInput = { sessionId, adapter: owned.adapter, handle: wrapper };
            return wrapper;
        },
        finishHoldToTalk: async (sessionId, outcome) => {
            const held = heldInput;
            if (!held || held.sessionId !== sessionId || resolveOwnedAdapter()?.adapter !== held.adapter) return false;
            await held.handle[outcome]();
            return true;
        },
        rearmAfterCredentialAuthorityChange: (options) => {
            if (disposed) return;
            if (options?.exactSessionAccountScopeChanged === true) {
                // A queued provider/tool-set transition belongs to the Account
                // authority that admitted it. Retire that intent before an
                // in-flight source stop can settle and reconcile the target.
                pendingAdapterSwitch = null;
            }
            if (
                options?.exactSessionAccountScopeChanged === true
                || (
                    options?.globalBindingAuthorityChanged === true
                    && recoveryBinding?.sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
                )
            ) {
                recoveryBinding = null;
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
            suppressedTerminalFailureAdapterId = publishedSnapshot.adapterId;
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
                suppressedTerminalFailureAdapterId = null;
                recoveryBinding = null;
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
                    // Keep this serialized transition current. Realtime and
                    // Local Agent both retire a started stale tool catalog.
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
                        && requiresCurrentUiContextToolSetReplacement(pendingTargetAdapter)
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
                || !requiresCurrentUiContextToolSetReplacement(owned.adapter)
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
                requestedTargetSessionAddress:
                    attemptConnectivityLease?.adapter === owned.adapter
                    && attemptConnectivityLease.sessionId === owned.snapshot.sessionId
                        ? attemptConnectivityLease.requestedTargetSessionAddress
                        : null,
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
            if (!owned || owned.snapshot.sessionId !== sessionId) return;
            const owner = resolveMuteAttemptOwner(owned);
            const previousMuted = owner.userMuted;
            const revision = owner.userRevision + 1;
            owner.userRevision = revision;
            owner.userMuted = muted;
            try {
                await applyMuteAttemptOwner(owner);
            } catch (error) {
                // A rejected request must not become latent desired state that
                // a later reconnect silently applies. Preserve a newer user
                // choice and otherwise restore the last acknowledged intent.
                if (muteAttemptOwner === owner && owner.userRevision === revision) {
                    owner.userMuted = previousMuted;
                }
                throw error;
            }
        },
        suspendInput: async (sessionId) => {
            if (disposed) return null;
            const owned = resolveOwnedAdapter();
            if (!owned || owned.snapshot.sessionId !== sessionId) return null;
            const owner = resolveMuteAttemptOwner(owned);
            const token = Object.freeze({});
            owner.suspensions.add(token);
            try {
                const current = await applyMuteAttemptOwner(owner);
                if (!current) {
                    owner.suspensions.delete(token);
                    return null;
                }
            } catch {
                owner.suspensions.delete(token);
                await stopAdapter(owner.adapter, owner.sessionId || sessionId).catch(() => undefined);
                return null;
            }
            let released = false;
            return Object.freeze({
                async release(): Promise<void> {
                    if (released) return;
                    released = true;
                    owner.suspensions.delete(token);
                    if (muteAttemptOwner !== owner) return;
                    try {
                        await applyMuteAttemptOwner(owner);
                    } catch {
                        await stopAdapter(owner.adapter, owner.sessionId || sessionId).catch(() => undefined);
                    }
                },
            });
        },
        dismissFailedAttempt: async (sessionId) => {
            if (disposed || startingAdapter || pendingAdapterSwitch) return;
            const failed = publishedSnapshot;
            if (!canDismissVoiceSessionFailedAttempt(failed) || failed.sessionId !== sessionId || !failed.adapterId) return;
            const adapter = resolveAttemptAdapter(failed.adapterId);
            const failedBinding = recoveryBinding;
            // Reuse terminal rearming and Stop cleanup; acknowledgement does not fabricate a clean End.
            if (adapter) await stopAdapter(adapter, sessionId ?? '');
            // A later Start or authority change owns its own recovery; old cleanup cannot acknowledge it.
            if (disposed || recoveryBinding !== failedBinding) return;
            recoveryBinding = null;
            suppressedTerminalFailureAdapterId = failed.adapterId;
            publishSnapshot();
        },
        retry: async (sessionId) => {
            if (disposed) return;
            const owned = resolveOwnedAdapter();
            if (owned) {
                const ownedSessionId = owned.snapshot.sessionId ?? sessionId;
                const requestedTargetSessionAddress =
                    attemptConnectivityLease?.adapter === owned.adapter
                    && attemptConnectivityLease.sessionId === ownedSessionId
                        ? attemptConnectivityLease.requestedTargetSessionAddress
                        : null;
                if (owned.adapter.retry) {
                    await owned.adapter.retry({ sessionId: ownedSessionId, requestedTargetSessionAddress });
                    return;
                }
                await toggle(requestedTargetSessionAddress);
                return;
            }
            const binding = recoveryBinding;
            if (!binding || binding.providerId !== configuredProviderId) return;
            // The recovery surface's session id is a navigation hint, not
            // authority to retarget the failed attempt or change its Home.
            await toggle(binding.requestedTargetSessionAddress);
        },
        setOutputFocusState: async (sessionId, state) => {
            if (disposed) return 'unsupported';
            const owned = resolveOwnedAdapter();
            if (!owned) return 'unsupported';
            const ownedSessionId = owned.snapshot.sessionId ?? sessionId;
            const attemptAdmission =
                realtimeCaptureAdmission?.adapter === owned.adapter
                && realtimeCaptureAdmission.sessionId === ownedSessionId
                    ? realtimeCaptureAdmission
                    : null;
            if (!owned.adapter.setOutputFocusState) {
                // Local Voice output is not a realtime connection transport;
                // preserve its existing native playback ownership instead of
                // treating a connection-only capability as a second owner.
                if (owned.adapter.engineKind === 'local') return 'applied';
                await stopAdapter(owned.adapter, ownedSessionId).catch(() => undefined);
                return 'unsupported';
            }
            let application: VoiceOutputFocusApplication;
            try {
                application = await owned.adapter.setOutputFocusState({
                    sessionId: ownedSessionId,
                    state,
                });
            } catch {
                application = 'unsupported';
            }
            // A session id is reusable. The captured adapter object is the
            // lifecycle owner's exact incumbent, and capture admission is the
            // attempt identity when the same adapter object starts again. Never
            // let a stale focus result stop either kind of replacement.
            if (
                resolveOwnedAdapter()?.adapter !== owned.adapter
                || (attemptAdmission && realtimeCaptureAdmission !== attemptAdmission)
            ) return 'unsupported';
            if (application === 'applied') return 'applied';
            await stopAdapter(owned.adapter, ownedSessionId).catch(() => undefined);
            return 'unsupported';
        },
        stop: async (sessionId, reason = { kind: 'stopped' }) => {
            if (disposed) return;
            recoveryBinding = null;
            const cancelledRestartStart = cancelPendingCurrentUiContextToolSetRestart();
            const owned = resolveOwnedAdapter();
            if (!owned) {
                if (cancelledRestartStart) {
                    await stopAdapter(cancelledRestartStart.adapter, cancelledRestartStart.sessionId);
                    return;
                }
                const startAttempt = startingAdapter;
                if (startAttempt) {
                    await stopAdapter(startAttempt.adapter, startAttempt.sessionId);
                }
                return;
            }
            const ownedSessionId = owned.snapshot.sessionId ?? sessionId;
            recordVoiceSessionEndReason(owned.adapter.id, ownedSessionId, reason);
            try {
                await stopAdapter(owned.adapter, ownedSessionId);
            } catch (error) {
                recordVoiceSessionEndReason(owned.adapter.id, ownedSessionId, null);
                throw error;
            }
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        toggle,
    };
}
