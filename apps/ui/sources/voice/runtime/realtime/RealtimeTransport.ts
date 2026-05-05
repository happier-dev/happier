import { storage } from '@/sync/domains/state/storage';
import { disableVoiceBackgroundCallAudioMode, enableVoiceBackgroundCallAudioMode } from '@/voice/runtime/voiceAudioMode';
import { createRealtimeMicSession } from '@/voice/runtime/mic/createRealtimeMicSession';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { createVoiceMachineError, voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { applyVoiceSessionTargetSelection } from '@/voice/binding/applyVoiceSessionTargetSelection';
import { resolveDefaultRealtimeTransportProvider } from '@/voice/adapters/resolveDefaultRealtimeTransportProvider';
import { isPermissionDeniedMicrophoneError } from '@/utils/platform/microphonePermissions';

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

function buildDefaultRealtimeSessionSnapshot(adapterId: string): VoiceSessionSnapshot {
    return {
        adapterId,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
    };
}

function normalizeRequestedTargetSessionId(sessionId: string | null): string | null {
    const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!trimmed || trimmed === VOICE_AGENT_GLOBAL_SESSION_ID) return null;
    return trimmed;
}

function isVoiceSessionSnapshotEqual(a: VoiceSessionSnapshot, b: VoiceSessionSnapshot): boolean {
    return (
        a.adapterId === b.adapterId
        && a.sessionId === b.sessionId
        && a.status === b.status
        && a.mode === b.mode
        && a.canStop === b.canStop
        && a.micMuted === b.micMuted
        && a.errorCode === b.errorCode
        && a.errorMessage === b.errorMessage
    );
}

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

        voiceConversationRuntimeMachine.transitionToConnecting({
            controlSessionId: config.sessionId,
        });
        this.transport.publishSessionSnapshot({
            ...this.transport.getSessionSnapshot(),
            status: 'connecting',
            mode: 'idle',
            canStop: true,
            sessionId: config.sessionId,
            errorCode: undefined,
            errorMessage: undefined,
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
        this.transport.publishSessionSnapshot(buildDefaultRealtimeSessionSnapshot(this.transport.provider.adapterId));
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
    private sessionSnapshot: VoiceSessionSnapshot;
    private readonly sessionSnapshotListeners = new Set<() => void>();
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
        this.sessionSnapshot = buildDefaultRealtimeSessionSnapshot(provider.adapterId);
    }

    getSettings(): unknown {
        return this.deps.getSettings();
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

    getSessionSnapshot(): VoiceSessionSnapshot {
        return this.sessionSnapshot;
    }

    subscribe(listener: () => void): () => void {
        this.sessionSnapshotListeners.add(listener);
        return () => {
            this.sessionSnapshotListeners.delete(listener);
        };
    }

    publishSessionSnapshot(nextSnapshot: VoiceSessionSnapshot): void {
        if (isVoiceSessionSnapshotEqual(this.sessionSnapshot, nextSnapshot)) {
            return;
        }
        this.sessionSnapshot = nextSnapshot;
        this.mirrorSessionSnapshotToStorage(nextSnapshot);
        for (const listener of this.sessionSnapshotListeners) {
            listener();
        }
    }

    private mirrorSessionSnapshotToStorage(snapshot: VoiceSessionSnapshot): void {
        const state = this.deps.getStorageState();
        state.setRealtimeStatus(snapshot.status === 'error' ? 'disconnected' : snapshot.status);

        const shouldResetMode = snapshot.status === 'disconnected' || snapshot.status === 'error';
        const nextMode = shouldResetMode ? 'idle' : (snapshot.mode === 'speaking' ? 'speaking' : 'idle');
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
        const { micMuted: _previousMuted, ...currentSnapshot } = this.getSessionSnapshot();
        this.publishSessionSnapshot(muted ? { ...currentSnapshot, micMuted: true } : currentSnapshot);
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

    private async handleWatchdogPlateau(): Promise<void> {
        this.stopWatchdog();
        const controlSessionId = this.currentControlSessionId;
        if (controlSessionId) {
            voiceConversationRuntimeMachine.setError({
                controlSessionId,
                error: createVoiceMachineError({
                    kind: 'mic_plateau',
                    reason: 'realtime_outbound_audio_plateau',
                    recoverable: true,
                }),
            });
        }
        this.provider.handleProviderDiagnosticsError('realtime_outbound_audio_plateau');
        await this.stopRealtimeSession();
    }

    handleProviderConnected(): void {
        this.suppressUnexpectedDisconnectError = false;
        this.voiceSessionStarted = true;
        const controlSessionId = this.currentControlSessionId;
        if (controlSessionId) {
            voiceConversationRuntimeMachine.transitionToConnected({
                controlSessionId,
            });
        }
        this.publishSessionSnapshot({
            adapterId: this.provider.adapterId,
            sessionId: controlSessionId,
            status: 'connected',
            mode: 'idle',
            canStop: true,
        });
        this.startWatchdog();
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
        this.voiceSessionStarted = false;
        this.activeConversationHandle = null;
        if (!this.suppressUnexpectedDisconnectError) {
            this.provider.resetActiveSession();
        }
        this.currentControlSessionId = null;
        this.micSession.setMuted(false);
        this.suppressUnexpectedDisconnectError = false;
        if (shouldSurfaceUnexpectedDisconnect && controlSessionId) {
            voiceConversationRuntimeMachine.setError({
                controlSessionId,
                error: createVoiceMachineError({
                    kind: 'transport_disconnect',
                    reason: 'realtime_transport_disconnected',
                    recoverable: true,
                }),
            });
        } else if (controlSessionId) {
            voiceConversationRuntimeMachine.transitionToDisconnected({
                controlSessionId,
            });
        }
        this.publishSessionSnapshot(buildDefaultRealtimeSessionSnapshot(this.provider.adapterId));
        this.provider.handleProviderDisconnected();
    }

    /**
     * Called when the React provider session component unmounts. Treat this as a local teardown
     * boundary: do not surface "unexpected disconnect" errors, and ensure we don't leave the UI
     * stuck in connecting/connected due to missing provider callbacks.
     */
    handleProviderComponentUnmounted(): void {
        const snapshot = this.getSessionSnapshot();
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

        this.startInFlightAbortController?.abort();
        const voiceSession = this.getVoiceSession();
        if (voiceSession) {
            void voiceSession.endSession().catch(() => {});
        }

        this.stopWatchdog();
        this.voiceSessionStarted = false;
        this.latestRequestedTargetSessionId = null;
        this.activeConversationHandle = null;
        this.provider.resetActiveSession();
        this.currentControlSessionId = null;
        this.micSession.setMuted(false);

        if (controlSessionId) {
            voiceConversationRuntimeMachine.transitionToDisconnected({
                controlSessionId,
            });
        }

        this.publishSessionSnapshot(buildDefaultRealtimeSessionSnapshot(this.provider.adapterId));
        void this.micSession.teardown().catch(() => {});
        void this.deps.disableVoiceBackgroundCallAudioMode().catch(() => {});

        this.suppressUnexpectedDisconnectError = false;
    }

    handleProviderMessage(payload: unknown): void {
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
        this.surfaceRecoverableRealtimeFailure({
            controlSessionId: this.currentControlSessionId,
            kind: failure.kind,
            reason: failure.reason,
        });
    }

    handleProviderModeChange(mode: string): void {
        const currentSnapshot = this.getSessionSnapshot();
        this.publishSessionSnapshot({
            ...currentSnapshot,
            adapterId: this.provider.adapterId,
            sessionId: currentSnapshot.sessionId ?? this.currentControlSessionId,
            mode: this.provider.resolveProviderMode(mode),
            canStop: currentSnapshot.status === 'connected' || currentSnapshot.status === 'connecting',
        });
    }

    private resolveProviderFailure(error: unknown): Readonly<{
        kind: MicSessionFailureKind | 'provider_error' | 'mic_permission_denied';
        reason: string;
    }> {
        if (isPermissionDeniedMicrophoneError(error)) {
            return {
                kind: 'mic_permission_denied',
                reason: 'realtime_mic_permission_denied',
            };
        }
        return {
            kind: 'provider_error',
            reason: 'realtime_provider_error',
        };
    }

    private clearActiveRealtimeState(): void {
        this.stopWatchdog();
        this.voiceSessionStarted = false;
        this.activeConversationHandle = null;
        this.startInFlightAbortController?.abort();
        this.provider.resetActiveSession();
        this.currentControlSessionId = null;
        this.micSession.setMuted(false);
        this.suppressUnexpectedDisconnectError = false;
    }

    private surfaceRecoverableRealtimeFailure(args: Readonly<{
        controlSessionId: string | null;
        kind: MicSessionFailureKind | 'provider_error' | 'mic_permission_denied';
        reason: string;
    }>): void {
        this.clearActiveRealtimeState();
        if (args.controlSessionId) {
            voiceConversationRuntimeMachine.setError({
                controlSessionId: args.controlSessionId,
                error: createVoiceMachineError({
                    kind: args.kind,
                    reason: args.reason,
                    recoverable: true,
                }),
            });
        }
        this.publishSessionSnapshot({
            ...buildDefaultRealtimeSessionSnapshot(this.provider.adapterId),
            errorCode: args.kind,
            errorMessage: args.reason,
        });
        this.provider.handleProviderDiagnosticsError(args.reason);
        void this.micSession.teardown().catch(() => {});
        void this.deps.disableVoiceBackgroundCallAudioMode().catch(() => {});
    }

    private handleMicFailure(failure: MicSessionFailure): void {
        const snapshot = this.getSessionSnapshot();
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
                    try {
                        await session.endSession();
                    } catch {
                        // best-effort cleanup
                    }
                    this.surfaceRecoverableRealtimeFailure({
                        controlSessionId,
                        kind: 'provider_error',
                        reason: 'realtime_missing_conversation_id',
                    });
                    await this.deps.disableVoiceBackgroundCallAudioMode();
                    return;
                }
                if (abortController.signal.aborted) {
                    try {
                        await session.endSession();
                    } catch {
                        // best-effort cleanup
                    }
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
                const failure = this.resolveProviderFailure(error);
                this.surfaceRecoverableRealtimeFailure({ controlSessionId, ...failure });
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
            this.stopWatchdog();
            this.suppressUnexpectedDisconnectError = true;
            if (controlSessionId) {
                voiceConversationRuntimeMachine.transitionToEnding({
                    controlSessionId,
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
            this.publishSessionSnapshot(buildDefaultRealtimeSessionSnapshot(this.provider.adapterId));
        } finally {
            if (!providerSessionFinalized) {
                this.provider.resetActiveSession();
            }
            // Cleanup must be best-effort; stop should never reject due to teardown issues.
            await this.micSession.teardown().catch(() => {});
            await this.deps.disableVoiceBackgroundCallAudioMode().catch(() => {});
        }
    }
}

export type { RealtimeConversationHandle } from './realtimeTransportProvider';
export const realtimeTransport = new RealtimeTransport();
