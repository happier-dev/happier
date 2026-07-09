import { storage } from '@/sync/domains/state/storage';
import { disableVoiceBackgroundCallAudioMode, enableVoiceBackgroundCallAudioMode } from '@/voice/runtime/voiceAudioMode';
import { createRealtimeMicSession } from '@/voice/runtime/mic/createRealtimeMicSession';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import {
    getVoiceConversationRuntimeSnapshot,
    useVoiceConversationRuntimeStore,
} from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { applyVoiceSessionTargetSelection } from '@/voice/binding/applyVoiceSessionTargetSelection';
import { resolveDefaultRealtimeTransportProvider } from '@/voice/adapters/resolveDefaultRealtimeTransportProvider';
import { isPermissionDeniedMicrophoneError } from '@/utils/platform/microphonePermissions';
import { createRealtimeReconnectController } from './realtimeReconnectController';
import { createRealtimeInboundWatchdog } from './realtimeInboundWatchdog';
import { isNonRecoverableProviderAuthError } from './realtimeProviderAuthError';

import type { RealtimeReconnectController, RealtimeReconnectFailure } from './realtimeReconnectController';
import type { RealtimeInboundWatchdog } from './realtimeInboundWatchdog';

import type { VoiceSession, VoiceSessionConfig } from '@/realtime/types';
import type { VoiceSessionSnapshot } from '@/voice/session/types';
import type {
    CreateMicSessionOptions,
    MicSession,
    MicSessionFailure,
    MicSessionFailureKind,
} from '@/voice/runtime/mic/MicSession';
import type {
    RealtimeConversationHandle,
    RealtimeTransportProvider,
} from './realtimeTransportProvider';

type RealtimeTransportDeps = Readonly<{
    createMicSession: (options: CreateMicSessionOptions) => MicSession;
    getSettings: () => unknown;
    getStorageState: () => ReturnType<typeof storage.getState>;
    ensureBound: (args: Parameters<typeof voiceSessionBindingManager.ensureBound>[0]) => Promise<unknown>;
    applyVoiceSessionTargetSelection: typeof applyVoiceSessionTargetSelection;
    enableVoiceBackgroundCallAudioMode: typeof enableVoiceBackgroundCallAudioMode;
    disableVoiceBackgroundCallAudioMode: typeof disableVoiceBackgroundCallAudioMode;
    now: () => number;
}>;

function normalizeRequestedTargetSessionId(sessionId: string | null): string | null {
    const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!trimmed || trimmed === VOICE_AGENT_GLOBAL_SESSION_ID) return null;
    return trimmed;
}

/**
 * Only one realtime transport may mirror the machine snapshot into the legacy
 * `realtimeStatus`/`realtimeMode` storage state at a time. Production has a
 * single transport singleton; tests construct extra instances, and without this
 * guard every instance would double-write the shared global storage from the
 * single global machine. The most-recently-constructed transport owns the
 * mirror.
 */
let activeStorageMirrorOwner: RealtimeTransport | null = null;

function extractStatsEntries(report: unknown): unknown[] {
    if (Array.isArray(report)) {
        return report;
    }
    if (report && typeof report === 'object' && Symbol.iterator in report) {
        return Array.from(report as Iterable<unknown>).map((entry) =>
            Array.isArray(entry) && entry.length >= 2 ? entry[1] : entry,
        );
    }
    if (report && typeof report === 'object' && 'forEach' in report && typeof (report as { forEach?: unknown }).forEach === 'function') {
        const entries: unknown[] = [];
        (report as { forEach: (callback: (value: unknown) => void) => void }).forEach((value) => {
            entries.push(value);
        });
        return entries;
    }
    return [];
}

function resolveGetStatsReader(handle: RealtimeConversationHandle | null): (() => Promise<unknown>) | null {
    const conversation = handle as Record<string, unknown> | null;
    if (!conversation) return null;

    const candidates: unknown[] = [
        conversation,
        conversation.connection,
        (conversation.connection as Record<string, unknown> | undefined)?.peerConnection,
        (conversation.connection as Record<string, unknown> | undefined)?.pc,
        ((conversation.connection as Record<string, unknown> | undefined)?.publisher as Record<string, unknown> | undefined)?.pc,
    ];

    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const maybeGetStats = (candidate as { getStats?: unknown }).getStats;
        if (typeof maybeGetStats === 'function') {
            return () => Promise.resolve(maybeGetStats.call(candidate));
        }
    }

    return null;
}

async function readRealtimeConversationOutboundBytesSent(handle: RealtimeConversationHandle | null): Promise<number | null> {
    const getStats = resolveGetStatsReader(handle);
    if (!getStats) {
        return null;
    }

    const statsReport = await getStats();
    const entries = extractStatsEntries(statsReport);
    let bytesSent: number | null = null;
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const stat = entry as Record<string, unknown>;
        if (stat.type !== 'outbound-rtp') continue;
        const mediaKind = typeof stat.kind === 'string' ? stat.kind : stat.mediaType;
        if (mediaKind !== 'audio') continue;
        if (typeof stat.bytesSent !== 'number' || !Number.isFinite(stat.bytesSent)) continue;
        bytesSent = bytesSent === null ? stat.bytesSent : Math.max(bytesSent, stat.bytesSent);
    }
    return bytesSent;
}

class ConversationBackedVoiceSession implements VoiceSession {
    constructor(private readonly transport: RealtimeTransport) {}

    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        const wantsTextOnly = config.textOnly === true;
        const conversation =
            this.transport.resolveConversationHandle(wantsTextOnly)
            ?? await this.transport.waitForConversationHandle(
                wantsTextOnly,
                VOICE_RUNTIME_CONFIG_DEFAULTS.realtimeConversationHandleReadyTimeoutMs,
            );
        if (!conversation) {
            throw new Error('Realtime voice session not initialized');
        }

        // The machine is the single lifecycle source: this transition drives the
        // machine-derived `connecting` snapshot consumed by the adapter; no
        // separate session-snapshot publish is needed.
        voiceConversationRuntimeMachine.transitionToConnecting({
            controlSessionId: config.sessionId,
            adapterId: this.transport.provider.adapterId,
        });

        const settings = this.transport.getSettings();
        const sessionConfig = this.transport.provider.buildConversationStartConfig({
            config,
            settings,
        });

        const rawConversationId = await conversation.startSession(sessionConfig);
        if (rawConversationId === null) {
            return null;
        }
        const conversationId = this.transport.provider.resolveConversationId({
            handle: conversation,
            rawConversationId,
        });
        if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
            return null;
        }

        this.transport.setActiveConversationHandle(conversation);
        this.transport.setCurrentRealtimeControlSessionId(config.sessionId);
        return conversationId;
    }

    async endSession(): Promise<void> {
        const conversation = this.transport.getActiveConversationHandle();
        if (!conversation) return;

        await conversation.endSession();
        this.transport.setActiveConversationHandle(null);
        this.transport.setCurrentRealtimeControlSessionId(null);
        // The authoritative final snapshot is published by the caller
        // (stopRealtimeSession / surfaceRecoverableRealtimeFailure /
        // handleProviderComponentUnmounted). Do not publish a competing default
        // snapshot here: on the recoverable-failure path it would race after the
        // errorCode snapshot and wipe the user-visible notice.
    }

    sendTextMessage(message: string): void {
        this.transport.getActiveConversationHandle()?.sendUserMessage(message);
    }

    sendContextualUpdate(update: string): void {
        this.transport.getActiveConversationHandle()?.sendContextualUpdate(update);
    }
}

export class RealtimeTransport {
    readonly provider: RealtimeTransportProvider;
    private readonly deps: RealtimeTransportDeps;
    private readonly micSession: MicSession;
    private registeredVoiceSession: VoiceSession | null = null;
    private readonly conversationBackedVoiceSession: VoiceSession;
    private lastMirroredStorageKey: string | null = null;
    private wasRealtimeMachineOwner = false;
    private readonly disposeStorageMirror: () => void;
    private voiceConversationHandle: RealtimeConversationHandle | null = null;
    private textConversationHandle: RealtimeConversationHandle | null = null;
    private activeConversationHandle: RealtimeConversationHandle | null = null;
    private voiceSessionStarted = false;
    private startInFlight: Promise<void> | null = null;
    private startInFlightAbortController: AbortController | null = null;
    private currentControlSessionId: string | null = null;
    private latestRequestedTargetSessionId: string | null = null;
    private currentWatchdogTimer: ReturnType<typeof setInterval> | null = null;
    private currentWatchdogLastProgressAtMs: number | null = null;
    private currentWatchdogLastBytesSent: number | null = null;
    private currentWatchdogCheckInFlight = false;
    private currentWatchdogTriggered = false;
    private suppressUnexpectedDisconnectError = false;
    private readonly reconnectController: RealtimeReconnectController;
    private readonly inboundWatchdog: RealtimeInboundWatchdog;

    constructor(
        provider: RealtimeTransportProvider = resolveDefaultRealtimeTransportProvider(),
        deps: Partial<RealtimeTransportDeps> = {},
    ) {
        this.provider = provider;
        this.deps = {
            createMicSession: (options) => createRealtimeMicSession(options),
            getSettings: () => storage.getState().settings,
            getStorageState: () => storage.getState(),
            ensureBound: (args) => voiceSessionBindingManager.ensureBound(args),
            applyVoiceSessionTargetSelection,
            enableVoiceBackgroundCallAudioMode,
            disableVoiceBackgroundCallAudioMode,
            now: () => Date.now(),
            ...deps,
        };
        this.micSession = this.deps.createMicSession({
            onFailure: (failure) => {
                this.handleMicFailure(failure);
            },
        });
        this.conversationBackedVoiceSession = new ConversationBackedVoiceSession(this);
        // Single owner of transient-drop reconnect: surfaces the recoverable
        // failure (graceful disconnected+retry) and drives a bounded-backoff
        // reconnect that re-establishes the SAME control session (preserving
        // conversation/turn continuity); after the retry cap is exhausted the
        // drop is re-surfaced as non-recoverable. ElevenLabs specifics stay in
        // the provider; this controller is provider-agnostic timing/policy.
        this.reconnectController = createRealtimeReconnectController({
            attemptReconnect: (attempt) => this.attemptRealtimeReconnect(attempt.controlSessionId),
            surfaceRecoverable: (failure) => this.surfaceRecoverableDropForReconnect(failure),
            surfaceNonRecoverable: (failure) => this.surfaceNonRecoverableRealtimeFailure(failure),
        });
        // Single owner of inbound-liveness detection: an inbound stall while a
        // turn is active routes through the same recoverable reconnect path.
        // Complements the existing outbound-bytes watchdog (a dead mic), which it
        // does not duplicate.
        this.inboundWatchdog = createRealtimeInboundWatchdog({
            onStall: () => this.handleInboundStall(),
        });
        // The machine is the single lifecycle source; mirror its derived realtime
        // snapshot into the legacy `realtimeStatus`/`realtimeMode` storage state
        // (consumed by the system-status diagnostics bundle) off a machine
        // subscription instead of a private session snapshot.
        // Seed the mirror key from the current (disconnected) machine snapshot
        // WITHOUT writing storage, so construction is side-effect free and the
        // first real machine transition is the first storage write.
        this.lastMirroredStorageKey = this.computeStorageMirrorKey();
        activeStorageMirrorOwner = this;
        this.disposeStorageMirror = useVoiceConversationRuntimeStore.subscribe(() => {
            // Only the active mirror owner writes storage, so the single global
            // machine never produces duplicate storage writes from multiple
            // transports.
            if (activeStorageMirrorOwner === this) {
                this.mirrorMachineSnapshotToStorage();
            }
        });
    }

    getSettings(): unknown {
        return this.deps.getSettings();
    }

    /**
     * Project the runtime machine into this adapter's session snapshot. The
     * adapter consumes the same projection; the transport reads it only for
     * internal control-flow decisions (e.g. is a realtime session live).
     */
    private deriveSessionSnapshot(): VoiceSessionSnapshot {
        return deriveLocalVoiceSessionSnapshot(this.provider.adapterId, getVoiceConversationRuntimeSnapshot());
    }

    dispose(): void {
        this.disposeStorageMirror();
        if (activeStorageMirrorOwner === this) {
            activeStorageMirrorOwner = null;
        }
    }

    registerVoiceSession(session: VoiceSession): void {
        this.registeredVoiceSession = session;
    }

    registerConversationHandle(params: Readonly<{ textOnly: boolean; handle: RealtimeConversationHandle | null }>): void {
        if (params.textOnly) {
            const previousHandle = this.textConversationHandle;
            this.textConversationHandle = params.handle;
            if (this.activeConversationHandle && !params.handle && this.activeConversationHandle === previousHandle) {
                this.activeConversationHandle = null;
            }
            return;
        }
        const previousHandle = this.voiceConversationHandle;
        this.voiceConversationHandle = params.handle;
        if (this.activeConversationHandle && !params.handle && this.activeConversationHandle === previousHandle) {
            this.activeConversationHandle = null;
        }
    }

    /**
     * Mirror the machine-derived realtime snapshot into the legacy
     * `realtimeStatus`/`realtimeMode` storage state. This is the only writer of
     * that storage slice; it derives from the single machine source rather than
     * a private session snapshot. Idempotent: only writes when the derived
     * status/mode actually change so a disconnect resets the mode (and clears the
     * debounce) exactly once.
     */
    private computeStorageMirrorKey(): string {
        const snapshot = this.deriveSessionSnapshot();
        const shouldResetMode = snapshot.status === 'disconnected' || snapshot.status === 'error';
        const nextStatus = snapshot.status === 'error' ? 'disconnected' : snapshot.status;
        const nextMode = shouldResetMode ? 'idle' : (snapshot.mode === 'speaking' ? 'speaking' : 'idle');
        return `${nextStatus}:${nextMode}:${shouldResetMode ? '1' : '0'}`;
    }

    private mirrorMachineSnapshotToStorage(): void {
        // The `realtimeStatus`/`realtimeMode` storage slice reflects realtime
        // sessions only. Ignore machine changes that don't belong to the realtime
        // adapter (e.g. a live local-engine session, which owns the same machine
        // slot ownerless) — except the single trailing transition that finalizes a
        // realtime session back to disconnected, so the slice resets exactly once.
        const isRealtimeOwned = getVoiceConversationRuntimeSnapshot().adapterId === this.provider.adapterId;
        if (!isRealtimeOwned && !this.wasRealtimeMachineOwner) {
            return;
        }
        this.wasRealtimeMachineOwner = isRealtimeOwned;

        const snapshot = this.deriveSessionSnapshot();
        const shouldResetMode = snapshot.status === 'disconnected' || snapshot.status === 'error';
        const nextStatus = snapshot.status === 'error' ? 'disconnected' : snapshot.status;
        const nextMode = shouldResetMode ? 'idle' : (snapshot.mode === 'speaking' ? 'speaking' : 'idle');

        // Only write when the mirrored (status, mode) pair actually changes so a
        // disconnect resets the mode and clears the debounce exactly once, and
        // machine changes that don't affect the realtime status/mode (e.g. mute
        // toggles, control-session retargets) don't re-fire storage writes.
        const mirrorKey = `${nextStatus}:${nextMode}:${shouldResetMode ? '1' : '0'}`;
        if (this.lastMirroredStorageKey === mirrorKey) {
            return;
        }
        this.lastMirroredStorageKey = mirrorKey;

        const state = this.deps.getStorageState();
        state.setRealtimeStatus(nextStatus);
        state.setRealtimeMode(nextMode, shouldResetMode);
        if (shouldResetMode) {
            state.clearRealtimeModeDebounce();
        }
    }

    resolveConversationHandle(textOnly: boolean): RealtimeConversationHandle | null {
        if (textOnly) {
            return this.textConversationHandle ?? this.voiceConversationHandle;
        }
        return this.voiceConversationHandle;
    }

    async waitForConversationHandle(
        textOnly: boolean,
        timeoutMs: number,
    ): Promise<RealtimeConversationHandle | null> {
        const startedAt = this.deps.now();
        while (this.deps.now() - startedAt < timeoutMs) {
            const handle = this.resolveConversationHandle(textOnly);
            if (handle) {
                return handle;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return this.resolveConversationHandle(textOnly);
    }

    setActiveConversationHandle(handle: RealtimeConversationHandle | null): void {
        this.activeConversationHandle = handle;
    }

    getActiveConversationHandle(): RealtimeConversationHandle | null {
        return this.activeConversationHandle ?? this.voiceConversationHandle ?? this.textConversationHandle;
    }

    getVoiceSession(): VoiceSession | null {
        return this.registeredVoiceSession ?? this.conversationBackedVoiceSession;
    }

    setMicMuted(muted: boolean): void {
        this.micSession.setMuted(muted);
        this.getActiveConversationHandle()?.setMicMuted?.(muted);
        // Mute state lives on the machine; the adapter projects `micMuted` from it.
        voiceConversationRuntimeMachine.setMuted(muted);
    }

    getConversationBackedVoiceSession(): VoiceSession {
        return this.conversationBackedVoiceSession;
    }

    isVoiceSessionStarted(): boolean {
        return this.voiceSessionStarted;
    }

    getCurrentRealtimeControlSessionId(): string | null {
        return this.currentControlSessionId;
    }

    setCurrentRealtimeControlSessionId(sessionId: string | null): void {
        this.currentControlSessionId = sessionId;
    }

    private stopWatchdog(): void {
        if (this.currentWatchdogTimer) {
            clearInterval(this.currentWatchdogTimer);
            this.currentWatchdogTimer = null;
        }
        this.currentWatchdogLastProgressAtMs = null;
        this.currentWatchdogLastBytesSent = null;
        this.currentWatchdogCheckInFlight = false;
        this.currentWatchdogTriggered = false;
    }

    private startWatchdog(): void {
        this.stopWatchdog();
        this.currentWatchdogTimer = setInterval(() => {
            void this.runWatchdogTick();
        }, VOICE_RUNTIME_CONFIG_DEFAULTS.realtimeWatchdogPollMs);
    }

    private async runWatchdogTick(): Promise<void> {
        if (this.currentWatchdogCheckInFlight || this.currentWatchdogTriggered || !this.voiceSessionStarted) {
            return;
        }

        this.currentWatchdogCheckInFlight = true;
        try {
            let bytesSent: number | null = null;
            try {
                bytesSent = await readRealtimeConversationOutboundBytesSent(this.getActiveConversationHandle());
            } catch {
                // If stats are unavailable, treat it as "no progress signal" and keep the session running.
                return;
            }
            if (typeof bytesSent !== 'number' || !Number.isFinite(bytesSent)) return;

            const now = this.deps.now();
            if (this.currentWatchdogLastBytesSent === null || bytesSent > this.currentWatchdogLastBytesSent) {
                this.currentWatchdogLastBytesSent = bytesSent;
                this.currentWatchdogLastProgressAtMs = now;
                return;
            }

            if (this.currentWatchdogLastProgressAtMs === null) {
                this.currentWatchdogLastProgressAtMs = now;
                return;
            }

            if (now - this.currentWatchdogLastProgressAtMs < VOICE_RUNTIME_CONFIG_DEFAULTS.realtimeWatchdogPlateauMs) {
                return;
            }

            this.currentWatchdogTriggered = true;
            await this.handleWatchdogPlateau();
        } catch {
            // This tick is always best-effort; never let the watchdog crash the app via an unhandled rejection.
        } finally {
            this.currentWatchdogCheckInFlight = false;
        }
    }

    private handleWatchdogPlateau(): void {
        // Route the plateau through the durable recoverable-failure path so the
        // user-visible `mic_plateau` notice survives on the consumed snapshot
        // (errorCode + machine error). The previous `setError` + `stopRealtimeSession`
        // sequence wiped the error during the ending->disconnected transition.
        this.surfaceRecoverableRealtimeFailure({
            controlSessionId: this.currentControlSessionId,
            kind: 'mic_plateau',
            reason: 'realtime_outbound_audio_plateau',
        });
    }

    handleProviderConnected(): void {
        this.suppressUnexpectedDisconnectError = false;
        this.voiceSessionStarted = true;
        // A live connection means any pending reconnect attempt has succeeded (or
        // a fresh session started): cancel a pending reconnect loop so a stale
        // backoff can't fire over a now-live session.
        this.reconnectController.cancel();
        const controlSessionId = this.currentControlSessionId;
        if (controlSessionId) {
            voiceConversationRuntimeMachine.transitionToConnected({
                controlSessionId,
                adapterId: this.provider.adapterId,
            });
        }
        this.startWatchdog();
        // Arm the inbound-liveness watchdog for the session; it only fires while a
        // turn is active (mode `speaking`), so between-turn silence is legitimate.
        this.inboundWatchdog.start();
        this.inboundWatchdog.markTurnActive(false);
        this.provider.handleProviderConnected();
    }

    handleProviderDisconnected(): void {
        const controlSessionId = this.currentControlSessionId;
        const shouldSurfaceUnexpectedDisconnect =
            this.voiceSessionStarted
            && !this.suppressUnexpectedDisconnectError
            && typeof controlSessionId === 'string'
            && controlSessionId.trim().length > 0;

        // If a start is still in flight, abort it so a late completion can't revive transport state
        // after we reset to disconnected.
        this.startInFlightAbortController?.abort();

        this.stopWatchdog();
        this.inboundWatchdog.stop();
        this.voiceSessionStarted = false;
        this.activeConversationHandle = null;
        if (!this.suppressUnexpectedDisconnectError) {
            // Unexpected transport drop: COMPLETE the happier lease (not a bare
            // `resetActiveSession()`, which orphans it). A reconnect mints a fresh
            // lease, so the prior one must be completed exactly once. When the
            // disconnect is suppressed (clean stop / component unmount), those
            // paths already own lease completion, so skip it here.
            this.completeProviderLeaseOnDrop();
        }
        this.currentControlSessionId = null;
        this.micSession.setMuted(false);
        this.suppressUnexpectedDisconnectError = false;
        if (shouldSurfaceUnexpectedDisconnect && controlSessionId) {
            // An UNEXPECTED transport drop is transient: route it through the
            // reconnect controller, which surfaces the recoverable
            // `transport_disconnect` (graceful disconnected+retry) AND drives a
            // bounded-backoff reconnect of the SAME control session. After the
            // retry cap it re-surfaces as a non-recoverable error.
            this.reconnectController.handleTransientDrop({
                controlSessionId,
                kind: 'transport_disconnect',
                reason: 'realtime_transport_disconnected',
            });
        } else if (controlSessionId) {
            voiceConversationRuntimeMachine.transitionToDisconnected({
                controlSessionId,
            });
        }
        this.provider.handleProviderDisconnected();
    }

    /**
     * Called when the React provider session component unmounts. Treat this as a local teardown
     * boundary: do not surface "unexpected disconnect" errors, and ensure we don't leave the UI
     * stuck in connecting/connected due to missing provider callbacks.
     */
    handleProviderComponentUnmounted(): void {
        const snapshot = this.deriveSessionSnapshot();
        const hasLiveRealtimeState =
            this.voiceSessionStarted
            || snapshot.status === 'connecting'
            || snapshot.status === 'connected'
            || Boolean(this.currentControlSessionId)
            || Boolean(this.activeConversationHandle)
            || Boolean(this.startInFlight);
        if (!hasLiveRealtimeState) {
            return;
        }

        const controlSessionId = this.currentControlSessionId;
        this.suppressUnexpectedDisconnectError = true;

        // Component unmount is a hard teardown boundary: abandon any pending
        // reconnect and stop the inbound watchdog.
        this.reconnectController.cancel();
        this.inboundWatchdog.stop();
        this.startInFlightAbortController?.abort();
        // Begin ending the live conversation BEFORE clearing active state (so the
        // ConversationBackedVoiceSession can still read the live handle), then
        // COMPLETE the happier lease via the shared finalize path instead of a
        // bare `resetActiveSession()` (which would orphan the lease on unmount).
        const voiceSession = this.getVoiceSession();
        const endSessionResult = voiceSession ? voiceSession.endSession() : null;

        this.stopWatchdog();
        this.voiceSessionStarted = false;
        this.latestRequestedTargetSessionId = null;
        this.activeConversationHandle = null;
        this.currentControlSessionId = null;
        this.micSession.setMuted(false);
        void this.finalizeProviderSessionBestEffort(endSessionResult);

        if (controlSessionId) {
            voiceConversationRuntimeMachine.transitionToDisconnected({
                controlSessionId,
            });
        }

        void this.micSession.teardown().catch(() => {});
        void this.deps.disableVoiceBackgroundCallAudioMode().catch(() => {});

        this.suppressUnexpectedDisconnectError = false;
    }

    handleProviderMessage(payload: unknown): void {
        // Every inbound message is liveness: reset the inbound-stall watchdog so a
        // live stream never false-fires.
        this.inboundWatchdog.noteInboundEvent();
        this.provider.handleProviderMessage({
            controlSessionId: this.currentControlSessionId,
            payload,
        });
    }

    handleProviderError(error: unknown): void {
        const failure = this.resolveProviderFailure(error);
        // Never log raw provider error messages here; in local-debug configurations console output may be shipped.
        if (__DEV__) {
            console.warn('Realtime voice not available:', failure.kind);
        }
        this.routeProviderFailure(this.currentControlSessionId, failure);
    }

    handleProviderModeChange(mode: string): void {
        // Provider mode changes drive the machine, the single lifecycle source.
        // The realtime provider reports only `speaking` vs `idle`; map those onto
        // the machine `speaking`/`connected` states, from which the adapter
        // derives the session mode. Without an active control session there is no
        // owned machine slot to retarget, so this is a no-op.
        const controlSessionId = this.currentControlSessionId ?? this.deriveSessionSnapshot().sessionId;
        if (!controlSessionId) {
            return;
        }
        const transitionArgs = {
            controlSessionId,
            adapterId: this.provider.adapterId,
        };
        // A mode change is itself an inbound event (resets the stall watchdog).
        // `speaking` means the agent is producing output, so a turn is active and
        // the inbound stream must keep flowing; any other mode (back to
        // `connected`/idle) ends the turn, disarming the watchdog so legitimate
        // between-turn silence never false-fires.
        this.inboundWatchdog.noteInboundEvent();
        if (this.provider.resolveProviderMode(mode) === 'speaking') {
            this.inboundWatchdog.markTurnActive(true);
            voiceConversationRuntimeMachine.transitionToSpeaking(transitionArgs);
        } else {
            // Leaving `speaking` returns to the AWAITING-RESPONSE / thinking gap:
            // the agent is expected to emit its next audio, so the inbound stream
            // must keep flowing. Arm the (more generous) awaiting watchdog so a
            // fully-dead inbound stream during the thinking gap is still caught —
            // a turn-active arm alone is blind to a pre-`speaking` stall (F2). It
            // resets on every inbound event, so a live connection (which keeps
            // streaming events while the user speaks / the agent thinks) never
            // false-fires; the tighter active-turn arm supersedes it on `speaking`.
            this.inboundWatchdog.markTurnActive(false);
            this.inboundWatchdog.markAwaitingResponse(true);
            voiceConversationRuntimeMachine.transitionToConnected(transitionArgs);
        }
    }

    private resolveProviderFailure(error: unknown): Readonly<{
        kind: MicSessionFailureKind | 'provider_error' | 'mic_permission_denied';
        reason: string;
        recoverable: boolean;
    }> {
        if (isPermissionDeniedMicrophoneError(error)) {
            // Mic permission denial: the user must re-grant access; retrying fails
            // identically. Non-recoverable.
            return {
                kind: 'mic_permission_denied',
                reason: 'realtime_mic_permission_denied',
                recoverable: false,
            };
        }
        if (isNonRecoverableProviderAuthError(error)) {
            // An invalid/forbidden provider credential (BYO 401/403): retrying the
            // same bad key is futile. Surface a hard dismiss-required error rather
            // than a recoverable reconnect loop. Provider-agnostic: keyed off the
            // typed auth error's HTTP status, not provider identity.
            return {
                kind: 'provider_error',
                reason: 'realtime_provider_auth_invalid',
                recoverable: false,
            };
        }
        return {
            kind: 'provider_error',
            reason: 'realtime_provider_error',
            recoverable: true,
        };
    }

    /**
     * Single owner of the recoverable/non-recoverable routing decision for a
     * resolved provider failure. A non-recoverable failure (mic permission
     * denial, invalid provider credential) surfaces a hard `error` immediately
     * and never reconnects; a recoverable failure routes through the
     * graceful-disconnected + bounded-backoff reconnect path.
     */
    private routeProviderFailure(
        controlSessionId: string | null,
        failure: Readonly<{
            kind: MicSessionFailureKind | 'provider_error' | 'mic_permission_denied';
            reason: string;
            recoverable: boolean;
        }>,
    ): void {
        if (!failure.recoverable) {
            this.reconnectController.handleNonRecoverableDrop({
                controlSessionId,
                kind: failure.kind,
                reason: failure.reason,
            });
            return;
        }
        this.surfaceRecoverableRealtimeFailure({
            controlSessionId,
            kind: failure.kind,
            reason: failure.reason,
        });
    }

    private clearActiveRealtimeState(): void {
        this.stopWatchdog();
        this.inboundWatchdog.stop();
        this.voiceSessionStarted = false;
        this.activeConversationHandle = null;
        this.startInFlightAbortController?.abort();
        // The provider's active-session reset is owned by `handleSessionEnded`
        // (which also completes the happier lease) in the recoverable-failure
        // finalize; resetting here first would null `activeSession` and skip the
        // lease completion.
        this.currentControlSessionId = null;
        this.micSession.setMuted(false);
        this.suppressUnexpectedDisconnectError = false;
    }

    /**
     * Finalize the live provider session + happier lease on the
     * recoverable-failure path, mirroring the clean-stop teardown
     * (`stopRealtimeSession`). Without this the ElevenLabs conversation stays
     * connected and the lease is never completed until the React component
     * unmounts. Best-effort: teardown failures must never crash the caller.
     *
     * `endSession()` is initiated synchronously by the caller (before local state
     * is cleared) so the `ConversationBackedVoiceSession` can read the still-live
     * active conversation handle; this method only awaits the in-flight teardown
     * and then completes the lease.
     */
    private async finalizeProviderSessionBestEffort(
        endSessionResult: Promise<void> | null,
    ): Promise<void> {
        if (endSessionResult) {
            try {
                await endSessionResult;
            } catch {
                // best-effort: an already-disconnected conversation can reject.
            }
        }
        try {
            await this.provider.handleSessionEnded();
        } catch {
            // best-effort: lease completion is fire-and-finalize.
        }
    }

    /**
     * Single lease-lifecycle teardown for a transport-drop boundary (an
     * unexpected disconnect or an inbound stall) where the underlying
     * conversation is already gone, so there is no live `endSession()` to await.
     *
     * Routes through `handleSessionEnded()` — the SAME completion path as the
     * clean stop — so the happier lease is COMPLETED exactly once instead of
     * being orphaned by a bare `resetActiveSession()` (which only nulls
     * `activeSession`/timers and never calls `completeHappierVoiceSession`).
     * `handleSessionEnded()` already resets the active session after completing,
     * so no separate reset is needed. Fire-and-finalize: best-effort, never
     * throws into the synchronous drop handler.
     */
    private completeProviderLeaseOnDrop(): void {
        void this.finalizeProviderSessionBestEffort(null);
    }

    private surfaceRecoverableRealtimeFailure(args: Readonly<{
        controlSessionId: string | null;
        kind: MicSessionFailureKind | 'provider_error' | 'mic_permission_denied';
        reason: string;
    }>): void {
        // Begin ending the live session BEFORE clearing local active-session state,
        // since clearing nulls the active conversation handle that the
        // ConversationBackedVoiceSession.endSession reads synchronously.
        const session = this.getVoiceSession();
        const endSessionResult = session ? session.endSession() : null;
        this.clearActiveRealtimeState();
        // The machine is the single lifecycle source: a recoverable error drives
        // the machine to a `disconnected` projection that carries the error
        // code/message (kind/reason), which the adapter consumes. No separate
        // session-snapshot publish is needed.
        if (args.controlSessionId) {
            voiceConversationRuntimeMachine.setError({
                controlSessionId: args.controlSessionId,
                adapterId: this.provider.adapterId,
                error: createVoiceMachineError({
                    kind: args.kind,
                    reason: args.reason,
                    recoverable: true,
                }),
            });
        }
        this.provider.handleProviderDiagnosticsError(args.reason);
        // Tear down the live conversation + happier lease (mirrors the clean-stop
        // path) so they do not leak on a recoverable mic/provider/plateau failure.
        void this.finalizeProviderSessionBestEffort(endSessionResult);
        void this.micSession.teardown().catch(() => {});
        void this.deps.disableVoiceBackgroundCallAudioMode().catch(() => {});
    }

    /**
     * Surface a transient drop's RECOVERABLE notice (graceful `disconnected` +
     * retry) without tearing down the live conversation/lease, so the
     * bounded-backoff reconnect can re-establish the SAME control session while
     * the React-owned conversation handle is preserved. This is the reconnect
     * loop's recoverable-surface; it is intentionally lighter than
     * `surfaceRecoverableRealtimeFailure` (which finalizes the provider session).
     */
    private surfaceRecoverableDropForReconnect(failure: RealtimeReconnectFailure): void {
        if (!failure.controlSessionId) {
            return;
        }
        voiceConversationRuntimeMachine.setError({
            controlSessionId: failure.controlSessionId,
            adapterId: this.provider.adapterId,
            error: createVoiceMachineError({
                kind: failure.kind,
                reason: failure.reason,
                recoverable: true,
            }),
        });
        this.provider.handleProviderDiagnosticsError(failure.reason);
    }

    /**
     * Surface a NON-recoverable realtime failure: a hard `error` the user must
     * dismiss (auth/quota/permission, or a transient drop whose retry budget is
     * exhausted). Tears down the live conversation + happier lease like the
     * clean-stop path so nothing leaks.
     */
    private surfaceNonRecoverableRealtimeFailure(failure: RealtimeReconnectFailure): void {
        const session = this.getVoiceSession();
        const endSessionResult = session ? session.endSession() : null;
        this.clearActiveRealtimeState();
        if (failure.controlSessionId) {
            voiceConversationRuntimeMachine.setError({
                controlSessionId: failure.controlSessionId,
                adapterId: this.provider.adapterId,
                error: createVoiceMachineError({
                    kind: failure.kind,
                    reason: failure.reason,
                    recoverable: false,
                }),
            });
        }
        this.provider.handleProviderDiagnosticsError(failure.reason);
        void this.finalizeProviderSessionBestEffort(endSessionResult);
        void this.micSession.teardown().catch(() => {});
        void this.deps.disableVoiceBackgroundCallAudioMode().catch(() => {});
    }

    /**
     * Re-establish the live provider session for a transient-drop reconnect,
     * reusing the SAME control session id (binding/target selection persist) and
     * the React-owned conversation handle, so conversation/turn continuity is
     * preserved. Resolves `true` only when the session is live again so the
     * reconnect controller knows to stop retrying.
     */
    private async attemptRealtimeReconnect(controlSessionId: string | null): Promise<boolean> {
        const trimmed = typeof controlSessionId === 'string' ? controlSessionId.trim() : '';
        if (!trimmed) {
            return false;
        }
        try {
            await this.startRealtimeSession(trimmed);
        } catch {
            return false;
        }
        return this.voiceSessionStarted;
    }

    /**
     * An inbound stall (no inbound audio/events while a turn is active) on an
     * otherwise-"open" connection: classify it as a transient failure and route
     * it through the same bounded-backoff recoverable reconnect path as a hard
     * transport drop (mirrors the FluidVoice route watchdog recovery).
     */
    private handleInboundStall(): void {
        const controlSessionId = this.currentControlSessionId;
        if (!controlSessionId || !this.voiceSessionStarted) {
            return;
        }
        // Stop the local watchdogs/session-live flag the same way a transport drop
        // does, then drive the recoverable reconnect loop.
        this.stopWatchdog();
        this.inboundWatchdog.stop();
        this.voiceSessionStarted = false;
        this.activeConversationHandle = null;
        // An inbound stall is a transient drop that drives a reconnect (which
        // mints a fresh lease): COMPLETE the prior happier lease exactly once
        // rather than orphaning it via a bare `resetActiveSession()`.
        this.completeProviderLeaseOnDrop();
        this.currentControlSessionId = null;
        this.micSession.setMuted(false);
        this.reconnectController.handleTransientDrop({
            controlSessionId,
            kind: 'transport_disconnect',
            reason: 'realtime_inbound_stall',
        });
    }

    private handleMicFailure(failure: MicSessionFailure): void {
        const snapshot = this.deriveSessionSnapshot();
        const isActiveRealtimeSession =
            this.voiceSessionStarted
            || snapshot.status === 'connecting'
            || snapshot.status === 'connected';
        if (!isActiveRealtimeSession) {
            return;
        }

        this.surfaceRecoverableRealtimeFailure({
            controlSessionId: this.currentControlSessionId,
            kind: failure.kind,
            reason: failure.reason,
        });
    }

    async startRealtimeSession(
        sessionId: string,
        initialContext?: string,
        retryAfterPaywall = false,
        options?: Readonly<{ textOnly?: boolean }>,
    ): Promise<void> {
        const session = this.getVoiceSession();
        if (!session) {
            return;
        }

        const settings = this.deps.getSettings();
        if (!this.provider.isSelectedProvider(settings)) {
            return;
        }

        const normalizedSessionId = String(sessionId ?? '').trim();
        const requestedTargetSessionId = normalizeRequestedTargetSessionId(normalizedSessionId);
        const controlSessionId = normalizedSessionId || VOICE_AGENT_GLOBAL_SESSION_ID;
        this.latestRequestedTargetSessionId = requestedTargetSessionId;
        if (requestedTargetSessionId) {
            this.deps.applyVoiceSessionTargetSelection({
                controlSessionId,
                targetSessionId: requestedTargetSessionId,
                updateLastFocused: true,
            });
        }

        if (this.startInFlight) {
            await this.startInFlight;
            return;
        }

        const abortController = new AbortController();
        this.startInFlightAbortController = abortController;

        const run = async () => {
            let micSessionActive = false;
            let providerSessionStarted = false;
            try {
                if (options?.textOnly !== true) {
                    voiceConversationRuntimeMachine.transitionToAcquiringMic({
                        controlSessionId,
                        adapterId: this.provider.adapterId,
                    });
                    await this.micSession.ensureActive();
                    micSessionActive = true;
                }

                if (abortController.signal.aborted) return;

                await this.deps.ensureBound({
                    adapterId: this.provider.adapterId,
                    controlSessionId,
                    requestedTargetSessionId,
                });

                const preparedStart = await this.provider.prepareSessionStart({
                    controlSessionId,
                    initialContext,
                    requestedTargetSessionId,
                    retryAfterPaywall,
                    settings,
                    signal: abortController.signal,
                    textOnly: options?.textOnly === true,
                });
                if (!preparedStart || abortController.signal.aborted) {
                    return;
                }

                await this.deps.enableVoiceBackgroundCallAudioMode();
                const conversationId = await session.startSession(preparedStart.sessionConfig);
                if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
                    // surfaceRecoverableRealtimeFailure owns the full teardown
                    // (endSession + lease finalize + mic teardown + audio mode off),
                    // so no separate cleanup is needed here.
                    this.surfaceRecoverableRealtimeFailure({
                        controlSessionId,
                        kind: 'provider_error',
                        reason: 'realtime_missing_conversation_id',
                    });
                    return;
                }
                if (abortController.signal.aborted) {
                    // The provider already returned a conversation id, so the
                    // lease is real even though the local abort won the next
                    // tick. Record it first, then complete via the canonical
                    // provider finalizer instead of doing ad-hoc cleanup.
                    this.provider.handleSessionStarted({
                        controlSessionId,
                        conversationId,
                        preparedStart,
                    });
                    let endSessionResult: Promise<void> | null = null;
                    try {
                        endSessionResult = session.endSession();
                    } catch {
                        // best-effort cleanup
                    }
                    await this.finalizeProviderSessionBestEffort(endSessionResult);
                    await this.deps.disableVoiceBackgroundCallAudioMode();
                    return;
                }

                this.currentControlSessionId = controlSessionId;
                this.voiceSessionStarted = true;
                providerSessionStarted = true;
                this.provider.handleSessionStarted({
                    controlSessionId,
                    conversationId,
                    preparedStart,
                });
                if (this.latestRequestedTargetSessionId && this.latestRequestedTargetSessionId !== requestedTargetSessionId) {
                    this.deps.applyVoiceSessionTargetSelection({
                        controlSessionId,
                        targetSessionId: this.latestRequestedTargetSessionId,
                        updateLastFocused: false,
                    });
                }
            } catch (error) {
                if (abortController.signal.aborted) return;
                // An invalid/forbidden BYO credential (401/403) thrown while
                // establishing the session is non-recoverable: retrying the same
                // bad key would fail identically, so surface a hard dismiss-required
                // error instead of the recoverable reconnect path. Every other
                // start failure stays on the recoverable path (the connect can be
                // retried), preserving the existing initial-connect UX.
                if (isNonRecoverableProviderAuthError(error)) {
                    this.reconnectController.handleNonRecoverableDrop({
                        controlSessionId,
                        kind: 'provider_error',
                        reason: 'realtime_provider_auth_invalid',
                    });
                } else {
                    const failure = this.resolveProviderFailure(error);
                    this.surfaceRecoverableRealtimeFailure({
                        controlSessionId,
                        kind: failure.kind,
                        reason: failure.reason,
                    });
                }
            } finally {
                if (micSessionActive && !providerSessionStarted) {
                    // Teardown must be best-effort: mic drivers / AudioContext teardown can fail in
                    // edge cases and should never crash the caller.
                    await this.micSession.teardown().catch(() => {});
                }
            }
        };

        const promise = run();
        this.startInFlight = promise;
        try {
            await promise;
        } finally {
            if (this.startInFlight === promise) {
                this.startInFlight = null;
                this.startInFlightAbortController = null;
            }
        }
    }

    async stopRealtimeSession(): Promise<void> {
        const session = this.getVoiceSession();
        if (!session) return;

        const controlSessionId = this.currentControlSessionId;
        let providerSessionFinalized = false;
        try {
            // A clean stop supersedes any pending reconnect/inbound watchdog so a
            // stale backoff can't revive a session the user explicitly ended.
            this.reconnectController.cancel();
            this.inboundWatchdog.stop();
            this.stopWatchdog();
            this.suppressUnexpectedDisconnectError = true;
            if (controlSessionId) {
                voiceConversationRuntimeMachine.transitionToEnding({
                    controlSessionId,
                    adapterId: this.provider.adapterId,
                });
            }
            this.startInFlightAbortController?.abort();
            const inFlight = this.startInFlight;
            if (inFlight) {
                await Promise.race([
                    inFlight.catch(() => {}),
                    new Promise<void>((resolve) =>
                        setTimeout(resolve, VOICE_RUNTIME_CONFIG_DEFAULTS.realtimeStartAbortGraceMs)),
                ]);
                if (this.startInFlight === inFlight) {
                    this.startInFlight = null;
                    this.startInFlightAbortController = null;
                }
            }
            await session.endSession();
            await this.provider.handleSessionEnded();
            providerSessionFinalized = true;

            if (controlSessionId) {
                voiceConversationRuntimeMachine.transitionToDisconnected({
                    controlSessionId,
                });
            }

            this.voiceSessionStarted = false;
            this.latestRequestedTargetSessionId = null;
            this.currentControlSessionId = null;
            this.activeConversationHandle = null;
            this.micSession.setMuted(false);
            this.suppressUnexpectedDisconnectError = false;
        } finally {
            if (!providerSessionFinalized) {
                // The clean-stop path threw before completing the lease (e.g. the
                // conversation `endSession()` rejected). Still COMPLETE the lease
                // via the shared finalize path so a clean stop never orphans it;
                // `handleSessionEnded()` resets the active session on completion.
                await this.finalizeProviderSessionBestEffort(null);
            }
            // Cleanup must be best-effort; stop should never reject due to teardown issues.
            await this.micSession.teardown().catch(() => {});
            await this.deps.disableVoiceBackgroundCallAudioMode().catch(() => {});
        }
    }
}

export type { RealtimeConversationHandle } from './realtimeTransportProvider';
export const realtimeTransport = new RealtimeTransport();
