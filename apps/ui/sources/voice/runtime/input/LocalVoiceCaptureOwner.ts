import {
    createTurnEndpointController,
    type TurnEndpointController,
    type TurnEndpointSignal,
} from '@/voice/runtime/input/TurnEndpointController';
import { normalizeTurnEndpointPolicy } from '@/voice/runtime/input/TurnEndpointDetector';
import {
    createNativeVadController,
    type NativeVadController,
} from '@/voice/runtime/input/NativeVadController';
import {
    createWebVadController,
    type WebVadController,
} from '@/voice/runtime/input/WebVadController';
import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/voice/adapters/local/settings';
import type { createDeviceSttController, DeviceSttController } from '@/voice/input/DeviceSttController';
import type {
    createSherpaStreamingSttController,
    SherpaStreamingSttController,
} from '@/voice/input/SherpaStreamingSttController';
import {
    createDaemonStreamingSttController,
    type DaemonStreamingSttController,
} from '@/voice/runtime/daemonInference/DaemonStreamingSttController';
import type { MicSession, MicSessionFailure } from '@/voice/runtime/mic/MicSession';
import type { RecordingMicSession } from '@/voice/runtime/mic/NativeMicSession';
import { createLiveMicSession } from '@/voice/runtime/mic/createLiveMicSession';
import {
    createRecordedAudioArtifactCleanup,
    deleteRecordedAudioArtifact,
} from '@/voice/runtime/input/recordedAudioArtifactCleanup';
import {
    createRuntimeTurnPolicyController,
    type RuntimeTurnCaptureProvider,
    type RuntimeTurnPolicyController,
    type RuntimeTurnStatus,
} from '@/voice/runtime/input/createRuntimeTurnPolicyController';
import type { VoiceMachineErrorKind } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import type { SttController, SttSink } from '@/voice/input/sttController';
import { resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';

type RuntimeCaptureError = Readonly<{
    controlSessionId: string;
    kind: VoiceMachineErrorKind;
    reason: string;
}>;

type RuntimeCapturePartial = Readonly<{
    controlSessionId: string;
    transcript: string;
}>;

type DeviceSttControllerDeps = Parameters<typeof createDeviceSttController>[0];
type SherpaStreamingSttControllerDeps = Parameters<typeof createSherpaStreamingSttController>[0];
type DaemonStreamingSttControllerDeps = Parameters<typeof createDaemonStreamingSttController>[0];
export type LocalNeuralCaptureExecution = 'device' | 'daemon';

export type LocalVoiceCaptureProvider = RuntimeTurnCaptureProvider;

export type StopLocalVoiceCaptureResult =
    | Readonly<{ provider: 'recorded_audio'; uri: string | null }>
    | Readonly<{ provider: 'device' | 'local_neural'; text: string; continueHandsFree: boolean }>;

export type LocalVoiceCaptureOwner = Readonly<{
    resolveManualBargeInAction: (args: Readonly<{
        bargeInEnabled: boolean;
        currentSessionId: string | null;
        currentStatus: RuntimeTurnStatus;
        handsFree: boolean;
        provider: LocalVoiceCaptureProvider;
        requestedSessionId: string;
    }>) => ReturnType<RuntimeTurnPolicyController['resolveManualBargeInAction']>;
    resolveEndpointSignalAction: (args: Readonly<{
        currentSessionId: string | null;
        currentStatus: RuntimeTurnStatus;
        handsFreeEnabled: boolean;
        inFlight: boolean;
        provider: LocalVoiceCaptureProvider;
        signal: TurnEndpointSignal;
    }>) => ReturnType<RuntimeTurnPolicyController['resolveEndpointSignalAction']>;
    isHandsFreeCaptureSession: (args: Readonly<{
        sessionId: string;
        provider: Extract<LocalVoiceCaptureProvider, 'device' | 'local_neural'>;
    }>) => boolean;
    startCapture: (args: Readonly<{
        sessionId: string;
        provider: LocalVoiceCaptureProvider;
        capturePurpose?: 'dictation' | 'conversation';
        handsFree: boolean;
        localNeuralExecution?: LocalNeuralCaptureExecution;
        settings?: any;
        signal?: AbortSignal;
    }>) => Promise<void>;
    stopCapture: (args: Readonly<{
        sessionId: string;
        provider: LocalVoiceCaptureProvider;
    }>) => Promise<StopLocalVoiceCaptureResult>;
    stopEndpointDrivenCapture: (args: Readonly<{
        adaptiveConfig: Parameters<RuntimeTurnPolicyController['resolveStoppedCaptureAction']>[0]['adaptiveConfig'];
        provider: Extract<LocalVoiceCaptureProvider, 'device' | 'local_neural'>;
        sessionId: string;
    }>) => Promise<ReturnType<RuntimeTurnPolicyController['resolveStoppedCaptureAction']>>;
    setMuted: (args: Readonly<{
        muted: boolean;
        sessionId: string;
    }>) => Promise<void>;
    clearHandsFree: (args: Readonly<{
        sessionId?: string;
        provider: Extract<LocalVoiceCaptureProvider, 'device' | 'local_neural'>;
    }>) => void;
    stopSession: (sessionId?: string | null) => Promise<void>;
}>;

type LocalVoiceCaptureOwnerDeps = Readonly<{
    onCaptureStarted: (controlSessionId: string) => void;
    onCaptureError: (error: RuntimeCaptureError) => void;
    getSettings: () => any;
    onEndpointSignal?: (signal: TurnEndpointSignal) => void;
    onSpeechCandidateStart?: (input: Readonly<{
        controlSessionId: string;
        source: Extract<TurnEndpointSignal['source'], 'native_vad' | 'web_vad' | 'device_recognizer'>;
    }>) => void;
    onSpeechCandidateFalseAlarm?: (input: Readonly<{
        controlSessionId: string;
        source: Extract<TurnEndpointSignal['source'], 'native_vad' | 'web_vad' | 'device_recognizer'>;
    }>) => void;
    /** Interim/committed transcript updates, equality-gated + throttled by the owner. */
    onPartialTranscript?: (partial: RuntimeCapturePartial) => void;
    /**
     * Continuous capture amplitude in [0,1] from the live mic, forwarded so the
     * engine can drive the UI-thread level visualizer. Reset to 0 on teardown by
     * the mic owner.
     */
    onLevel?: (level: number) => void;
}>;

type LocalVoiceCaptureOwnerOptions = Readonly<{
    createLiveMicSession?: (options?: Parameters<typeof createLiveMicSession>[0]) => MicSession;
    createRecordingMicSession?: () => RecordingMicSession;
    createDeviceSttController?: (deps: DeviceSttControllerDeps) => DeviceSttController;
    createSherpaSttController?: (deps: SherpaStreamingSttControllerDeps) => SherpaStreamingSttController;
    createDaemonStreamingSttController?: (
        deps: DaemonStreamingSttControllerDeps,
    ) => DaemonStreamingSttController;
    nativeVadController?: NativeVadController;
    runtimeTurnPolicyController?: RuntimeTurnPolicyController;
    /** Silent-capture watchdog window after provider startup; no audio within it surfaces `mic_plateau`. */
    micPlateauTimeoutMs?: number;
    /** Minimum spacing between forwarded partial-transcript snapshots. */
    partialThrottleMs?: number;
    /** Maximum time terminal teardown may wait for an uncooperative provider operation. */
    terminalAbandonmentMs?: number;
    setTimer?: (task: () => void, waitMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    now?: () => number;
}>;

function createDefaultDeviceSttController(deps: DeviceSttControllerDeps): DeviceSttController {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../input/DeviceSttController.ts') as typeof import('../../input/DeviceSttController');
    return mod.createDeviceSttController(deps);
}

function createDefaultSherpaStreamingSttController(
    deps: SherpaStreamingSttControllerDeps,
): SherpaStreamingSttController {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../input/SherpaStreamingSttController.ts') as typeof import('../../input/SherpaStreamingSttController');
    return mod.createSherpaStreamingSttController(deps);
}

function createDefaultDaemonStreamingSttController(
    deps: DaemonStreamingSttControllerDeps,
): DaemonStreamingSttController {
    return createDaemonStreamingSttController(deps);
}

function createDefaultRecordingMicSession(): RecordingMicSession {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../mic/NativeMicSession.ts') as typeof import('../mic/NativeMicSession');
    return mod.createExpoAudioRecordingMicSession();
}

export function createLocalVoiceCaptureOwner(
    deps: LocalVoiceCaptureOwnerDeps,
    options: LocalVoiceCaptureOwnerOptions = {},
): LocalVoiceCaptureOwner {
    let liveMicSession: MicSession | null = null;
    let liveMicGeneration = 0;
    let recordingMicSession: RecordingMicSession | null = null;
    let activeCaptureSessionId: string | null = null;
    let activeCaptureProvider: LocalVoiceCaptureProvider | null = null;
    let activeCaptureSettings: any | null = null;
    let mutedSessionId: string | null = null;
    let muted = false;
    // Per-capture streaming state (single capture active at a time).
    let activeAbortController: AbortController | null = null;
    let activeCaptureErrored = false;
    let pendingCaptureStart: Promise<void> | null = null;
    let pendingFailureCleanup: Promise<void> | null = null;
    let captureLifecycleGeneration = 0;
    const retiredMicSessions = new WeakSet<object>();
    let micPlateauTimer: ReturnType<typeof setTimeout> | null = null;
    let latestPartialTranscript: string | null = null;
    let lastPublishedPartial: string | null = null;
    let lastPartialAt = 0;
    let nativeVadController: NativeVadController | null = options.nativeVadController ?? null;
    const normalizeSessionId = (sessionId: string | null | undefined): string | null =>
        typeof sessionId === 'string' && sessionId.trim().length > 0
            ? sessionId.trim()
            : null;
    const setTimer = options.setTimer ?? ((task, waitMs) => setTimeout(task, waitMs));
    const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    const now = options.now ?? (() => Date.now());
    const micPlateauTimeoutMs = typeof options.micPlateauTimeoutMs === 'number' && options.micPlateauTimeoutMs >= 0
        ? options.micPlateauTimeoutMs
        : 8_000;
    const partialThrottleMs = typeof options.partialThrottleMs === 'number' && options.partialThrottleMs >= 0
        ? options.partialThrottleMs
        : 150;
    const terminalAbandonmentMs = typeof options.terminalAbandonmentMs === 'number' && options.terminalAbandonmentMs >= 0
        ? options.terminalAbandonmentMs
        : 1_000;
    const runtimeTurnPolicyController =
        options.runtimeTurnPolicyController
        ?? createRuntimeTurnPolicyController();
    const getCaptureSettings = (): any =>
        activeCaptureSettings ?? deps.getSettings();
    const clearMicPlateauWatchdog = (): void => {
        if (micPlateauTimer !== null) {
            clearTimer(micPlateauTimer);
            micPlateauTimer = null;
        }
    };
    const teardownMicSessionOnce = async (session: MicSession | RecordingMicSession): Promise<void> => {
        if (retiredMicSessions.has(session)) return;
        retiredMicSessions.add(session);
        session.setMuted(false);
        await session.teardown().catch(() => {});
    };
    const waitUntilTerminalBound = async (
        work: Promise<unknown> | null,
        deadlineAt = now() + terminalAbandonmentMs,
    ): Promise<boolean> => {
        if (!work) return true;
        const remainingMs = deadlineAt - now();
        if (remainingMs <= 0) {
            void work.catch(() => {});
            return false;
        }
        return await new Promise<boolean>((resolve) => {
            let settled = false;
            let timer!: ReturnType<typeof setTimeout>;
            const settle = (value: boolean): void => {
                if (settled) return;
                settled = true;
                clearTimer(timer);
                resolve(value);
            };
            timer = setTimer(() => settle(false), remainingMs);
            void work.then(() => settle(true), () => settle(true));
        });
    };
    // Single owner-side handler for any failure of the active capture source:
    // tears the capture down and surfaces a typed, recoverable error. Used by
    // both the live-mic failure callback and the silent-capture watchdog so the
    // failure is bound to the actual capture source, not an unused stream.
    const waitForPendingFailureCleanup = async (): Promise<void> => {
        const cleanup = pendingFailureCleanup;
        if (cleanup) {
            await cleanup.catch(() => {});
        }
    };
    const failActiveCapture = (failure: MicSessionFailure): Promise<void> => {
        const activeSessionId = activeCaptureSessionId;
        const activeProvider = activeCaptureProvider;
        if (!activeSessionId || (activeProvider !== 'device' && activeProvider !== 'local_neural')) {
            return Promise.resolve();
        }

        clearMicPlateauWatchdog();
        activeCaptureErrored = true;
        activeCaptureSessionId = null;
        activeCaptureProvider = null;
        activeCaptureSettings = null;
        const failedCaptureAbortController = activeAbortController;
        activeAbortController = null;
        failedCaptureAbortController?.abort();
        runtimeTurnPolicyController.clearHandsFreeCaptureSession({
            provider: activeProvider,
            sessionId: activeSessionId,
        });

        const activeLiveMicSession = liveMicSession;
        liveMicSession = null;
        const failedLocalNeuralExecution = activeLocalNeuralExecution;
        const cleanup = (async () => {
            if (activeProvider === 'local_neural' && nativeVadController) {
                await nativeVadController.stopSession(activeSessionId).catch(() => {});
            }
            if (activeProvider === 'device' && deviceSttController) {
                await deviceSttController.stop().catch(() => {});
            }
            if (activeProvider === 'local_neural') {
                const controller = failedLocalNeuralExecution === 'daemon'
                    ? daemonStreamingSttController
                    : sherpaSttController;
                await controller?.stop().catch(() => {});
            }
            if (activeLiveMicSession) {
                await teardownMicSessionOnce(activeLiveMicSession);
            }

            deps.onCaptureError({
                controlSessionId: activeSessionId,
                kind: failure.kind,
                reason: failure.reason,
            });
        })();
        pendingFailureCleanup = cleanup;
        void cleanup.finally(() => {
            if (pendingFailureCleanup === cleanup) {
                pendingFailureCleanup = null;
            }
        }).catch(() => {});
        return cleanup;
    };
    const handleLiveMicFailure = (failure: MicSessionFailure): void => {
        void failActiveCapture(failure);
    };
    // Single mic-release path for a FAILED endpoint-driven capture startup. The
    // mic is activated (`ensureActive`) before the STT recognizer/stream setup, so
    // any startup failure — a thrown error OR a silent `sink.onError` — must
    // release the live mic + clear hands-free ownership so nothing leaks. Safe to
    // call when no mic is active (idempotent best-effort teardown).
    const releaseLiveMicAfterFailedStartup = async (
        sessionId: string,
        provider: Extract<LocalVoiceCaptureProvider, 'device' | 'local_neural'>,
        capturedMicSession?: MicSession,
    ): Promise<void> => {
        await waitForPendingFailureCleanup();
        clearMicPlateauWatchdog();
        runtimeTurnPolicyController.clearHandsFreeCaptureSession({ provider, sessionId });
        if (activeCaptureSessionId === sessionId && activeCaptureProvider === provider) {
            activeCaptureSessionId = null;
            activeCaptureProvider = null;
            activeCaptureSettings = null;
        }
        if (provider === 'local_neural' && nativeVadController) {
            await nativeVadController.stopSession(sessionId).catch(() => {});
        }
        const activeLiveMicSession = capturedMicSession ?? liveMicSession;
        if (liveMicSession === activeLiveMicSession) liveMicSession = null;
        if (activeLiveMicSession) {
            await teardownMicSessionOnce(activeLiveMicSession);
        }
    };
    const forwardEndpointSignal = (signal: TurnEndpointSignal): void => {
        // Correlate the controller's internal capture key to the live control
        // session before forwarding; also clears the watchdog (audio was heard).
        clearMicPlateauWatchdog();
        const controlSessionId = activeCaptureSessionId ?? signal.sessionId;
        deps.onEndpointSignal?.({ ...signal, sessionId: controlSessionId });
    };
    const forwardSpeechCandidateStart = (input: Readonly<{
        sessionId: string;
        source: 'native_vad' | 'web_vad' | 'device_recognizer';
    }>): void => {
        deps.onSpeechCandidateStart?.({
            controlSessionId: activeCaptureSessionId ?? input.sessionId,
            source: input.source,
        });
    };
    const forwardSpeechCandidateFalseAlarm = (input: Readonly<{
        sessionId: string;
        source: 'native_vad' | 'web_vad' | 'device_recognizer';
    }>): void => {
        deps.onSpeechCandidateFalseAlarm?.({
            controlSessionId: activeCaptureSessionId ?? input.sessionId,
            source: input.source,
        });
    };
    const emitThrottledPartial = (controlSessionId: string, transcript: string, flush: boolean): void => {
        const trimmed = transcript.trim();
        if (trimmed.length === 0) {
            return;
        }
        latestPartialTranscript = trimmed;
        if (!deps.onPartialTranscript) {
            return;
        }
        // Equality-gated: skip identical snapshots regardless of cadence.
        if (trimmed === lastPublishedPartial) {
            return;
        }
        const timestamp = now();
        // Throttled: interim snapshots are spaced; committed text flushes immediately.
        if (!flush && lastPublishedPartial !== null && timestamp - lastPartialAt < partialThrottleMs) {
            return;
        }
        lastPublishedPartial = trimmed;
        lastPartialAt = timestamp;
        deps.onPartialTranscript({ controlSessionId, transcript: trimmed });
    };
    const beginSttCapture = (
        controlSessionId: string,
        externalSignal?: AbortSignal,
    ): Readonly<{
        armMicPlateauWatchdog: () => void;
        sink: SttSink;
        signal: AbortSignal;
        unlinkExternalAbort: () => void;
    }> => {
        clearMicPlateauWatchdog();
        activeCaptureErrored = false;
        latestPartialTranscript = null;
        lastPublishedPartial = null;
        lastPartialAt = 0;
        let audioStarted = false;
        const abortController = new AbortController();
        activeAbortController = abortController;
        let unlinkExternalAbort = (): void => {};
        if (externalSignal) {
            const abortFromExternalSignal = (): void => {
                abortController.abort();
            };
            if (externalSignal.aborted) {
                abortFromExternalSignal();
            } else {
                externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
                unlinkExternalAbort = () => {
                    externalSignal.removeEventListener('abort', abortFromExternalSignal);
                };
            }
        }
        const armMicPlateauWatchdog = (): void => {
            // Admission can legitimately outlive the silent-audio window (for
            // example, while a daemon stream negotiates its route). Start this
            // source-health timer only once the provider owns a live capture.
            if (audioStarted || activeCaptureErrored || abortController.signal.aborted) {
                return;
            }
            micPlateauTimer = setTimer(() => {
                micPlateauTimer = null;
                if (activeCaptureSessionId !== controlSessionId || activeCaptureErrored) {
                    return;
                }
                void failActiveCapture({ kind: 'mic_plateau', reason: 'mic_audio_plateau' });
            }, micPlateauTimeoutMs);
        };
        const sink: SttSink = {
            onAudioStarted: () => {
                audioStarted = true;
                clearMicPlateauWatchdog();
            },
            onPartial: (text) => {
                emitThrottledPartial(controlSessionId, text, false);
            },
            onFinal: (text) => {
                emitThrottledPartial(controlSessionId, text, true);
            },
            onEndpoint: () => {
                audioStarted = true;
                clearMicPlateauWatchdog();
            },
            onError: (error) => {
                void failActiveCapture(error);
            },
        };
        return {
            armMicPlateauWatchdog,
            sink,
            signal: abortController.signal,
            unlinkExternalAbort,
        };
    };
    const getLiveMicSession = (): MicSession => {
        if (liveMicSession) {
            return liveMicSession;
        }
        const generation = ++liveMicGeneration;
        const micSessionOptions = {
            onFailure: (failure: MicSessionFailure) => {
                if (generation !== liveMicGeneration || !liveMicSession) {
                    return;
                }
                handleLiveMicFailure(failure);
            },
            ...(deps.onLevel ? { onLevel: deps.onLevel } : {}),
        };
        liveMicSession =
            options.createLiveMicSession?.(micSessionOptions)
            ?? createLiveMicSession(micSessionOptions);
        return liveMicSession;
    };
    const getRecordingMicSession = (): RecordingMicSession => {
        recordingMicSession ??=
            options.createRecordingMicSession?.()
            ?? createDefaultRecordingMicSession();
        return recordingMicSession;
    };
    const createEndpointController = (): TurnEndpointController => createTurnEndpointController({
        onSignal: forwardEndpointSignal,
    });
    // Latest in-flight partial transcript for the active capture, so the acoustic
    // VAD endpoint signal carries the recognized text (and, via duration, lets the
    // downstream barge-in gate evaluate real input) instead of an empty string.
    const getLatestPartialTranscript = (): string | null => latestPartialTranscript;
    const getNativeVadController = (): NativeVadController => {
        nativeVadController ??= createNativeVadController({
            onEndpointSignal: forwardEndpointSignal,
            onSpeechCandidateStart: forwardSpeechCandidateStart,
            onSpeechCandidateFalseAlarm: forwardSpeechCandidateFalseAlarm,
            getLatestPartialTranscript,
        });
        return nativeVadController;
    };
    const resolveHandsFreeTurnEndpointPolicy = () => {
        const adapter = resolveLocalVoiceAdapterSettings(getCaptureSettings()).config;
        return normalizeTurnEndpointPolicy({
            silenceMs:
                adapter?.handsFree?.endpointing?.silenceMs
                ?? VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
            minSpeechMs:
                adapter?.handsFree?.endpointing?.minSpeechMs
                ?? VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
        });
    };
    const createOwnedWebVadController = (): WebVadController => createWebVadController({
        onEndpointSignal: forwardEndpointSignal,
        onSpeechCandidateStart: forwardSpeechCandidateStart,
        onSpeechCandidateFalseAlarm: forwardSpeechCandidateFalseAlarm,
        getLatestPartialTranscript,
    });
    let deviceSttController: DeviceSttController | null = null;
    const getDeviceSttController = (): DeviceSttController => {
        const deviceDeps: DeviceSttControllerDeps = {
            endpointController: createEndpointController(),
            getSettings: getCaptureSettings,
            onSpeechCandidateStart: forwardSpeechCandidateStart,
            onSpeechCandidateFalseAlarm: forwardSpeechCandidateFalseAlarm,
            webVadController: createOwnedWebVadController(),
        };
        deviceSttController ??= options.createDeviceSttController?.(deviceDeps)
            ?? createDefaultDeviceSttController(deviceDeps);
        return deviceSttController;
    };
    let sherpaSttController: SherpaStreamingSttController | null = null;
    let daemonStreamingSttController: DaemonStreamingSttController | null = null;
    let activeLocalNeuralExecution: LocalNeuralCaptureExecution = 'device';
    const getSherpaSttController = (): SherpaStreamingSttController => {
        const sherpaDeps: SherpaStreamingSttControllerDeps = {
            endpointController: createEndpointController(),
            getSettings: getCaptureSettings,
        };
        sherpaSttController ??= options.createSherpaSttController?.(sherpaDeps)
            ?? createDefaultSherpaStreamingSttController(sherpaDeps);
        return sherpaSttController;
    };
    const getDaemonStreamingSttController = (): DaemonStreamingSttController => {
        const daemonDeps: DaemonStreamingSttControllerDeps = {
            endpointController: createEndpointController(),
            getSettings: getCaptureSettings,
        };
        daemonStreamingSttController ??= options.createDaemonStreamingSttController?.(daemonDeps)
            ?? createDefaultDaemonStreamingSttController(daemonDeps);
        return daemonStreamingSttController;
    };
    const getLocalNeuralSttController = (
        execution: LocalNeuralCaptureExecution,
    ): SherpaStreamingSttController | DaemonStreamingSttController => (
        execution === 'daemon'
            ? getDaemonStreamingSttController()
            : getSherpaSttController()
    );
    const isCurrentSttStopAuthority = (args: Readonly<{
        controller: SttController;
        generation: number;
        localNeuralExecution?: LocalNeuralCaptureExecution;
        provider: Extract<LocalVoiceCaptureProvider, 'device' | 'local_neural'>;
        sessionId: string;
    }>): boolean => {
        if (
            captureLifecycleGeneration !== args.generation
            || activeCaptureProvider !== args.provider
            || activeCaptureSessionId !== args.sessionId
        ) {
            return false;
        }
        if (args.provider === 'device') {
            return deviceSttController === args.controller;
        }
        const currentController = args.localNeuralExecution === 'daemon'
            ? daemonStreamingSttController
            : sherpaSttController;
        return currentController === args.controller;
    };
    const stopSttController = async (
        controller: SttController,
        isCurrent: () => boolean,
    ): Promise<Readonly<{ finalText: string; failed: boolean }>> => {
        const result = await controller.stop();
        if ('error' in result) {
            if (isCurrent()) {
                await failActiveCapture({
                    kind: result.error.kind,
                    reason: result.error.reason,
                });
            }
            return { finalText: '', failed: true };
        }
        return { finalText: result.finalText, failed: false };
    };

    const configureHandsFree = (args: Readonly<{
        sessionId: string;
        provider: LocalVoiceCaptureProvider;
        handsFree: boolean;
    }>) => {
        (['device', 'local_neural'] as const).forEach((provider) => {
            runtimeTurnPolicyController.setHandsFreeCaptureSession({
                provider,
                sessionId: args.provider === provider && args.handsFree ? args.sessionId : null,
            });
        });
    };

    const syncMutedStateForSession = (sessionId: string): void => {
        const normalizedSessionId = normalizeSessionId(sessionId);
        const nextMuted = normalizedSessionId !== null && mutedSessionId === normalizedSessionId && muted;
        if (activeCaptureProvider === 'recorded_audio' && recordingMicSession) {
            recordingMicSession.setMuted(nextMuted);
            return;
        }
        liveMicSession?.setMuted(nextMuted);
    };

    const stopEndpointDrivenCapture = async (args: Readonly<{
        adaptiveConfig: Parameters<RuntimeTurnPolicyController['resolveStoppedCaptureAction']>[0]['adaptiveConfig'];
        provider: Extract<LocalVoiceCaptureProvider, 'device' | 'local_neural'>;
        sessionId: string;
    }>): Promise<ReturnType<RuntimeTurnPolicyController['resolveStoppedCaptureAction']>> => {
        clearMicPlateauWatchdog();
        const normalizedSessionId = normalizeSessionId(args.sessionId) ?? args.sessionId;
        const generation = captureLifecycleGeneration;
        const continueHandsFree = runtimeTurnPolicyController.isHandsFreeCaptureSession({
            provider: args.provider,
            sessionId: args.sessionId,
        });
        const stopped = await (async () => {
            switch (args.provider) {
                case 'device': {
                    const controller = getDeviceSttController();
                    const { finalText, failed } = await stopSttController(
                        controller,
                        () => isCurrentSttStopAuthority({
                            controller,
                            generation,
                            provider: args.provider,
                            sessionId: normalizedSessionId,
                        }),
                    );
                    return {
                        continueHandsFree: !failed && continueHandsFree,
                        text: finalText,
                    } as const;
                }
                case 'local_neural': {
                    const localNeuralExecution = activeLocalNeuralExecution;
                    const controller = getLocalNeuralSttController(localNeuralExecution);
                    if (nativeVadController) {
                        await nativeVadController.stopSession(args.sessionId).catch(() => {});
                    }
                    const { finalText, failed } = await stopSttController(
                        controller,
                        () => isCurrentSttStopAuthority({
                            controller,
                            generation,
                            localNeuralExecution,
                            provider: args.provider,
                            sessionId: normalizedSessionId,
                        }),
                    );
                    return {
                        continueHandsFree: !failed && continueHandsFree,
                        text: finalText,
                    } as const;
                }
            }
        })();

        return runtimeTurnPolicyController.resolveStoppedCaptureAction({
            adaptiveConfig: args.adaptiveConfig,
            continueHandsFree: stopped.continueHandsFree,
            provider: args.provider,
            sessionId: args.sessionId,
            transcript: stopped.text,
        });
    };

    return {
        resolveManualBargeInAction: (args) => runtimeTurnPolicyController.resolveManualBargeInAction(args),
        resolveEndpointSignalAction: (args) => runtimeTurnPolicyController.resolveEndpointSignalAction(args),
        isHandsFreeCaptureSession: ({ sessionId, provider }) =>
            runtimeTurnPolicyController.isHandsFreeCaptureSession({ sessionId, provider }),
        startCapture: async ({
            sessionId,
            provider,
            capturePurpose = 'conversation',
            handsFree,
            localNeuralExecution,
            settings,
            signal: externalSignal,
        }) => {
            const captureGeneration = ++captureLifecycleGeneration;
            let resolveCaptureStart!: () => void;
            const captureStart = new Promise<void>((resolve) => {
                resolveCaptureStart = resolve;
            });
            pendingCaptureStart = captureStart;
            try {
                await waitForPendingFailureCleanup();
                configureHandsFree({ sessionId, provider, handsFree });
                const normalizedSessionId = normalizeSessionId(sessionId) ?? sessionId;
                activeCaptureSessionId = normalizedSessionId;
                activeCaptureProvider = provider;
                activeCaptureSettings = settings ?? null;
                switch (provider) {
                case 'device': {
                    const micSession = getLiveMicSession();
                    syncMutedStateForSession(normalizedSessionId);
                    const {
                        armMicPlateauWatchdog,
                        sink,
                        signal,
                        unlinkExternalAbort,
                    } = beginSttCapture(normalizedSessionId, externalSignal);
                    try {
                        await getDeviceSttController().start({
                            capturePurpose,
                            sessionId: normalizedSessionId,
                            micSession,
                            sink,
                            signal,
                        });
                    } catch (error) {
                        unlinkExternalAbort();
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider, micSession);
                        throw error;
                    }
                    unlinkExternalAbort();
                    if (signal.aborted) {
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider, micSession);
                        return;
                    }
                    // A silent startup failure surfaces via `sink.onError`
                    // (activeCaptureErrored) rather than a throw; release the mic too.
                    if (activeCaptureErrored) {
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider, micSession);
                        return;
                    }
                    armMicPlateauWatchdog();
                    deps.onCaptureStarted(normalizedSessionId);
                    return;
                }
                case 'local_neural': {
                    activeLocalNeuralExecution = localNeuralExecution ?? 'device';
                    const micSession = getLiveMicSession();
                    syncMutedStateForSession(normalizedSessionId);
                    const {
                        armMicPlateauWatchdog,
                        sink,
                        signal,
                        unlinkExternalAbort,
                    } = beginSttCapture(normalizedSessionId, externalSignal);
                    if (signal.aborted) {
                        unlinkExternalAbort();
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider, micSession);
                        return;
                    }
                    if (activeLocalNeuralExecution === 'device' && handsFree) {
                        const endpointPolicy = resolveHandsFreeTurnEndpointPolicy();
                        const nativeVadStart = getNativeVadController().startSession({
                            minSpeechMs: endpointPolicy.minSpeechMs,
                            redemptionMs: endpointPolicy.silenceMs,
                            sessionId: normalizedSessionId,
                        });
                        const nativeVadSettledBeforeAbort = await new Promise<boolean>((resolve) => {
                            let settled = false;
                            const finish = (value: boolean): void => {
                                if (settled) {
                                    return;
                                }
                                settled = true;
                                signal.removeEventListener('abort', onAbort);
                                resolve(value);
                            };
                            const onAbort = (): void => finish(false);
                            if (signal.aborted) {
                                finish(false);
                                return;
                            }
                            signal.addEventListener('abort', onAbort, { once: true });
                            void nativeVadStart.then(
                                () => finish(true),
                                () => finish(true),
                            );
                        });
                        if (!nativeVadSettledBeforeAbort || signal.aborted) {
                            unlinkExternalAbort();
                            await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider, micSession);
                            return;
                        }
                    } else if (nativeVadController) {
                        await nativeVadController.stopSession().catch(() => {});
                    }
                    try {
                        await getLocalNeuralSttController(activeLocalNeuralExecution).start({ sessionId: normalizedSessionId, micSession, sink, signal });
                    } catch (error) {
                        unlinkExternalAbort();
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider, micSession);
                        throw error;
                    }
                    unlinkExternalAbort();
                    if (signal.aborted) {
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider, micSession);
                        return;
                    }
                    if (activeCaptureErrored) {
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider, micSession);
                        return;
                    }
                    armMicPlateauWatchdog();
                    deps.onCaptureStarted(normalizedSessionId);
                    return;
                }
                default: {
                    const micSession = getRecordingMicSession();
                    syncMutedStateForSession(normalizedSessionId);
                    await micSession.beginRecording(externalSignal);
                    if (
                        captureGeneration !== captureLifecycleGeneration
                        || externalSignal?.aborted
                    ) {
                        if (recordingMicSession === micSession) recordingMicSession = null;
                        await teardownMicSessionOnce(micSession);
                    }
                }
                }
            } finally {
                resolveCaptureStart();
                if (pendingCaptureStart === captureStart) {
                    pendingCaptureStart = null;
                }
            }
        },
        stopCapture: async ({ sessionId, provider }) => {
            const normalizedSessionId = normalizeSessionId(sessionId) ?? sessionId;
            const generation = captureLifecycleGeneration;
            clearMicPlateauWatchdog();
            switch (provider) {
                case 'device': {
                    const controller = getDeviceSttController();
                    const continueHandsFree = runtimeTurnPolicyController.isHandsFreeCaptureSession({
                        provider,
                        sessionId,
                    });
                    const isCurrent = (): boolean => isCurrentSttStopAuthority({
                        controller,
                        generation,
                        provider,
                        sessionId: normalizedSessionId,
                    });
                    const { finalText, failed } = await stopSttController(controller, isCurrent);
                    const text = finalText;
                    if (isCurrent()) {
                        activeCaptureProvider = null;
                        activeCaptureSessionId = null;
                        activeCaptureSettings = null;
                    }
                    return {
                        provider,
                        text,
                        continueHandsFree: !failed && continueHandsFree,
                    } as const;
                }
                case 'local_neural': {
                    const localNeuralExecution = activeLocalNeuralExecution;
                    const controller = getLocalNeuralSttController(localNeuralExecution);
                    const continueHandsFree = runtimeTurnPolicyController.isHandsFreeCaptureSession({
                        provider,
                        sessionId,
                    });
                    const isCurrent = (): boolean => isCurrentSttStopAuthority({
                        controller,
                        generation,
                        localNeuralExecution,
                        provider,
                        sessionId: normalizedSessionId,
                    });
                    if (nativeVadController) {
                        await nativeVadController.stopSession(normalizedSessionId).catch(() => {});
                    }
                    const { finalText, failed } = await stopSttController(controller, isCurrent);
                    const text = finalText;
                    if (isCurrent()) {
                        activeCaptureProvider = null;
                        activeCaptureSessionId = null;
                        activeCaptureSettings = null;
                    }
                    return {
                        provider,
                        text,
                        continueHandsFree: !failed && continueHandsFree,
                    } as const;
                }
                default: {
                    const controller = recordingMicSession;
                    const isCurrent = (): boolean => (
                        captureLifecycleGeneration === generation
                        && activeCaptureProvider === provider
                        && activeCaptureSessionId === normalizedSessionId
                        && recordingMicSession === controller
                    );
                    if (isCurrent()) {
                        activeCaptureProvider = null;
                        activeCaptureSessionId = null;
                        activeCaptureSettings = null;
                    }
                    return {
                        provider,
                        uri: controller
                            ? await controller.stopRecording()
                            : null,
                    } as const;
                }
            }
        },
        stopEndpointDrivenCapture,
        setMuted: async ({ muted: nextMuted, sessionId }) => {
            const normalizedSessionId = normalizeSessionId(sessionId);
            if (!normalizedSessionId) {
                return;
            }
            const previousMutedSessionId = mutedSessionId;
            const previousMuted = muted;
            const generation = captureLifecycleGeneration;
            const provider = activeCaptureProvider;
            const controller = deviceSttController;
            mutedSessionId = normalizedSessionId;
            muted = nextMuted;
            if (activeCaptureSessionId === normalizedSessionId) {
                syncMutedStateForSession(normalizedSessionId);
                if (provider === 'device' && controller) {
                    try {
                        await controller.setMuted(nextMuted);
                    } catch (error) {
                        if (
                            captureLifecycleGeneration === generation
                            && activeCaptureSessionId === normalizedSessionId
                            && activeCaptureProvider === provider
                            && deviceSttController === controller
                        ) {
                            mutedSessionId = previousMutedSessionId;
                            muted = previousMuted;
                            syncMutedStateForSession(normalizedSessionId);
                        }
                        throw error;
                    }
                }
            }
        },
        clearHandsFree: ({ sessionId, provider }) => {
            runtimeTurnPolicyController.clearHandsFreeCaptureSession({ provider, sessionId });
        },
        stopSession: async (sessionId) => {
            const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
                ? sessionId.trim()
                : null;
            const recordingCaptureSessionId = activeCaptureProvider === 'recorded_audio'
                ? activeCaptureSessionId
                : null;
            let terminalRecordingCleanupError: unknown;
            let terminalRecordingCleanupFailed = false;
            const terminalDeadlineAt = now() + terminalAbandonmentMs;

            clearMicPlateauWatchdog();
            captureLifecycleGeneration += 1;
            const captureStart = pendingCaptureStart;
            if (pendingCaptureStart === captureStart) pendingCaptureStart = null;
            if (activeAbortController) {
                try {
                    activeAbortController.abort();
                } catch {
                    // ignore
                }
                activeAbortController = null;
            }
            const stoppedNativeVadController = nativeVadController;
            const stoppedDeviceSttController = deviceSttController;
            const stoppedSherpaSttController = sherpaSttController;
            const stoppedDaemonStreamingSttController = daemonStreamingSttController;
            const activeRecordingMicSession = recordingMicSession;
            const activeLiveMicSession = liveMicSession;
            recordingMicSession = null;
            liveMicSession = null;
            deviceSttController = null;
            sherpaSttController = null;
            daemonStreamingSttController = null;
            activeCaptureSessionId = null;
            activeCaptureProvider = null;
            activeCaptureSettings = null;

            await waitUntilTerminalBound(captureStart, terminalDeadlineAt);
            await waitUntilTerminalBound(waitForPendingFailureCleanup(), terminalDeadlineAt);

            if (stoppedNativeVadController) {
                await waitUntilTerminalBound(
                    stoppedNativeVadController.stopSession(normalizedSessionId),
                    terminalDeadlineAt,
                );
            }
            if (stoppedDeviceSttController) {
                await waitUntilTerminalBound(stoppedDeviceSttController.stop(), terminalDeadlineAt);
            }
            if (stoppedSherpaSttController) {
                await waitUntilTerminalBound(stoppedSherpaSttController.stop(), terminalDeadlineAt);
            }
            if (stoppedDaemonStreamingSttController) {
                await waitUntilTerminalBound(
                    stoppedDaemonStreamingSttController.stop(),
                    terminalDeadlineAt,
                );
            }

            (['device', 'local_neural'] as const).forEach((provider) => {
                runtimeTurnPolicyController.clearHandsFreeCaptureSession({
                    provider,
                    sessionId: normalizedSessionId,
                });
            });

            if (activeRecordingMicSession) {
                if (recordingCaptureSessionId) {
                    // A normal recorded stop clears the active provider before
                    // transferring its URI to Local Voice's stop-and-send
                    // cleanup. Terminal teardown has no consumer, so it
                    // finalizes and consumes the artifact through that same
                    // attempt-local cleanup owner before releasing the session.
                    const artifactCleanup = createRecordedAudioArtifactCleanup(
                        deleteRecordedAudioArtifact,
                    );
                    const terminalArtifactCleanup = (async () => {
                        try {
                            artifactCleanup.admit(await activeRecordingMicSession.stopRecording());
                        } catch {
                            // `stopRecording` releases its lease in its own finally;
                            // preserve teardown's best-effort terminal behavior when
                            // the recorder cannot yield a finalized artifact.
                        }
                        return await artifactCleanup.cleanup();
                    })();
                    const artifactCleanupSettled = await waitUntilTerminalBound(
                        terminalArtifactCleanup,
                        terminalDeadlineAt,
                    );
                    if (artifactCleanupSettled) {
                        const cleanupResult = await terminalArtifactCleanup;
                        if (cleanupResult.kind === 'failed') {
                            terminalRecordingCleanupError = cleanupResult.error;
                            terminalRecordingCleanupFailed = true;
                        }
                    } else {
                        void terminalArtifactCleanup.then((cleanupResult) => {
                            if (cleanupResult.kind !== 'failed') return;
                            deps.onCaptureError({
                                controlSessionId: recordingCaptureSessionId,
                                kind: 'provider_error',
                                reason: 'recording_cleanup_failed',
                            });
                        });
                    }
                }
                await waitUntilTerminalBound(
                    teardownMicSessionOnce(activeRecordingMicSession),
                    terminalDeadlineAt,
                );
            }
            if (activeLiveMicSession) {
                await waitUntilTerminalBound(
                    teardownMicSessionOnce(activeLiveMicSession),
                    terminalDeadlineAt,
                );
            }
            mutedSessionId = null;
            muted = false;

            if (terminalRecordingCleanupFailed) {
                if (recordingCaptureSessionId) {
                    deps.onCaptureError({
                        controlSessionId: recordingCaptureSessionId,
                        kind: 'provider_error',
                        reason: 'recording_cleanup_failed',
                    });
                }
                throw terminalRecordingCleanupError;
            }
        },
    };
}
