import {
    createTurnEndpointController,
    type TurnEndpointController,
    type TurnEndpointSignal,
} from '@/voice/runtime/input/TurnEndpointController';
import {
    createNativeVadController,
    type NativeVadController,
} from '@/voice/runtime/input/NativeVadController';
import {
    createWebVadController,
    type WebVadController,
} from '@/voice/runtime/input/WebVadController';
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
    createRuntimeTurnPolicyController,
    type RuntimeTurnCaptureProvider,
    type RuntimeTurnPolicyController,
    type RuntimeTurnStatus,
} from '@/voice/runtime/input/createRuntimeTurnPolicyController';
import type { VoiceMachineErrorKind } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import type { SttSink } from '@/voice/input/sttController';

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
        handsFree: boolean;
        localNeuralExecution?: LocalNeuralCaptureExecution;
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
    runtimeTurnPolicyController?: RuntimeTurnPolicyController;
    /** Silent-capture watchdog window; no audio within it surfaces `mic_plateau`. */
    micPlateauTimeoutMs?: number;
    /** Minimum spacing between forwarded partial-transcript snapshots. */
    partialThrottleMs?: number;
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
    let recordingMicSession: RecordingMicSession | null = null;
    let activeCaptureSessionId: string | null = null;
    let activeCaptureProvider: LocalVoiceCaptureProvider | null = null;
    let mutedSessionId: string | null = null;
    let muted = false;
    // Per-capture streaming state (single capture active at a time).
    let activeAbortController: AbortController | null = null;
    let activeCaptureErrored = false;
    let micPlateauTimer: ReturnType<typeof setTimeout> | null = null;
    let latestPartialTranscript: string | null = null;
    let lastPublishedPartial: string | null = null;
    let lastPartialAt = 0;
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
    const runtimeTurnPolicyController =
        options.runtimeTurnPolicyController
        ?? createRuntimeTurnPolicyController();
    const clearMicPlateauWatchdog = (): void => {
        if (micPlateauTimer !== null) {
            clearTimer(micPlateauTimer);
            micPlateauTimer = null;
        }
    };
    // Single owner-side handler for any failure of the active capture source:
    // tears the capture down and surfaces a typed, recoverable error. Used by
    // both the live-mic failure callback and the silent-capture watchdog so the
    // failure is bound to the actual capture source, not an unused stream.
    const failActiveCapture = (failure: MicSessionFailure): void => {
        const activeSessionId = activeCaptureSessionId;
        const activeProvider = activeCaptureProvider;
        if (!activeSessionId || (activeProvider !== 'device' && activeProvider !== 'local_neural')) {
            return;
        }

        clearMicPlateauWatchdog();
        activeCaptureErrored = true;
        activeCaptureSessionId = null;
        activeCaptureProvider = null;
        runtimeTurnPolicyController.clearHandsFreeCaptureSession({
            provider: activeProvider,
            sessionId: activeSessionId,
        });

        const activeLiveMicSession = liveMicSession;
        liveMicSession = null;
        if (activeLiveMicSession) {
            activeLiveMicSession.setMuted(false);
            void activeLiveMicSession.teardown().catch(() => {});
        }

        deps.onCaptureError({
            controlSessionId: activeSessionId,
            kind: failure.kind,
            reason: failure.reason,
        });
    };
    const handleLiveMicFailure = (failure: MicSessionFailure): void => {
        failActiveCapture(failure);
    };
    // Single mic-release path for a FAILED endpoint-driven capture startup. The
    // mic is activated (`ensureActive`) before the STT recognizer/stream setup, so
    // any startup failure — a thrown error OR a silent `sink.onError` — must
    // release the live mic + clear hands-free ownership so nothing leaks. Safe to
    // call when no mic is active (idempotent best-effort teardown).
    const releaseLiveMicAfterFailedStartup = async (
        sessionId: string,
        provider: Extract<LocalVoiceCaptureProvider, 'device' | 'local_neural'>,
    ): Promise<void> => {
        clearMicPlateauWatchdog();
        runtimeTurnPolicyController.clearHandsFreeCaptureSession({ provider, sessionId });
        if (activeCaptureSessionId === sessionId && activeCaptureProvider === provider) {
            activeCaptureSessionId = null;
            activeCaptureProvider = null;
        }
        const activeLiveMicSession = liveMicSession;
        liveMicSession = null;
        if (activeLiveMicSession) {
            activeLiveMicSession.setMuted(false);
            await activeLiveMicSession.teardown().catch(() => {});
        }
    };
    const forwardEndpointSignal = (signal: TurnEndpointSignal): void => {
        // Correlate the controller's internal capture key to the live control
        // session before forwarding; also clears the watchdog (audio was heard).
        clearMicPlateauWatchdog();
        const controlSessionId = activeCaptureSessionId ?? signal.sessionId;
        deps.onEndpointSignal?.({ ...signal, sessionId: controlSessionId });
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
    ): Readonly<{ sink: SttSink; signal: AbortSignal; unlinkExternalAbort: () => void }> => {
        clearMicPlateauWatchdog();
        activeCaptureErrored = false;
        latestPartialTranscript = null;
        lastPublishedPartial = null;
        lastPartialAt = 0;
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
        micPlateauTimer = setTimer(() => {
            micPlateauTimer = null;
            if (activeCaptureSessionId !== controlSessionId || activeCaptureErrored) {
                return;
            }
            failActiveCapture({ kind: 'mic_plateau', reason: 'mic_audio_plateau' });
        }, micPlateauTimeoutMs);
        const sink: SttSink = {
            onAudioStarted: () => {
                clearMicPlateauWatchdog();
            },
            onPartial: (text) => {
                emitThrottledPartial(controlSessionId, text, false);
            },
            onFinal: (text) => {
                emitThrottledPartial(controlSessionId, text, true);
            },
            onEndpoint: () => {
                clearMicPlateauWatchdog();
            },
            onError: (error) => {
                activeCaptureErrored = true;
                clearMicPlateauWatchdog();
                deps.onCaptureError({
                    controlSessionId,
                    kind: error.kind,
                    reason: error.reason,
                });
            },
        };
        return { sink, signal: abortController.signal, unlinkExternalAbort };
    };
    const getLiveMicSession = (): MicSession => {
        const micSessionOptions = {
            onFailure: handleLiveMicFailure,
            ...(deps.onLevel ? { onLevel: deps.onLevel } : {}),
        };
        liveMicSession ??=
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
    const createOwnedNativeVadController = (): NativeVadController => createNativeVadController({
        onEndpointSignal: forwardEndpointSignal,
        getLatestPartialTranscript,
    });
    const createOwnedWebVadController = (): WebVadController => createWebVadController({
        onEndpointSignal: forwardEndpointSignal,
        getLatestPartialTranscript,
    });
    let deviceSttController: DeviceSttController | null = null;
    const getDeviceSttController = (): DeviceSttController => {
        const deviceDeps: DeviceSttControllerDeps = {
            endpointController: createEndpointController(),
            getSettings: deps.getSettings,
            nativeVadController: createOwnedNativeVadController(),
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
            getSettings: deps.getSettings,
        };
        sherpaSttController ??= options.createSherpaSttController?.(sherpaDeps)
            ?? createDefaultSherpaStreamingSttController(sherpaDeps);
        return sherpaSttController;
    };
    const getDaemonStreamingSttController = (): DaemonStreamingSttController => {
        const daemonDeps: DaemonStreamingSttControllerDeps = {
            getSettings: deps.getSettings,
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
        const stopped = await (async () => {
            switch (args.provider) {
                case 'device': {
                    const { finalText } = await getDeviceSttController().stop();
                    return {
                        continueHandsFree: runtimeTurnPolicyController.isHandsFreeCaptureSession({
                            provider: args.provider,
                            sessionId: args.sessionId,
                        }),
                        text: finalText,
                    } as const;
                }
                case 'local_neural': {
                    const { finalText } = await getLocalNeuralSttController(activeLocalNeuralExecution).stop();
                    return {
                        continueHandsFree: runtimeTurnPolicyController.isHandsFreeCaptureSession({
                            provider: args.provider,
                            sessionId: args.sessionId,
                        }),
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
        startCapture: async ({ sessionId, provider, handsFree, localNeuralExecution, signal: externalSignal }) => {
            configureHandsFree({ sessionId, provider, handsFree });
            const normalizedSessionId = normalizeSessionId(sessionId) ?? sessionId;
            activeCaptureSessionId = normalizedSessionId;
            activeCaptureProvider = provider;
            switch (provider) {
                case 'device': {
                    const micSession = getLiveMicSession();
                    syncMutedStateForSession(normalizedSessionId);
                    const { sink, signal, unlinkExternalAbort } = beginSttCapture(normalizedSessionId, externalSignal);
                    try {
                        await getDeviceSttController().start({ micSession, sink, signal });
                    } catch (error) {
                        unlinkExternalAbort();
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider);
                        throw error;
                    }
                    unlinkExternalAbort();
                    if (signal.aborted) {
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider);
                        return;
                    }
                    // A silent startup failure surfaces via `sink.onError`
                    // (activeCaptureErrored) rather than a throw; release the mic too.
                    if (activeCaptureErrored) {
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider);
                        return;
                    }
                    deps.onCaptureStarted(normalizedSessionId);
                    return;
                }
                case 'local_neural': {
                    activeLocalNeuralExecution = localNeuralExecution ?? 'device';
                    const micSession = getLiveMicSession();
                    syncMutedStateForSession(normalizedSessionId);
                    const { sink, signal, unlinkExternalAbort } = beginSttCapture(normalizedSessionId, externalSignal);
                    try {
                        await getLocalNeuralSttController(activeLocalNeuralExecution).start({ micSession, sink, signal });
                    } catch (error) {
                        unlinkExternalAbort();
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider);
                        throw error;
                    }
                    unlinkExternalAbort();
                    if (signal.aborted) {
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider);
                        return;
                    }
                    if (activeCaptureErrored) {
                        await releaseLiveMicAfterFailedStartup(normalizedSessionId, provider);
                        return;
                    }
                    deps.onCaptureStarted(normalizedSessionId);
                    return;
                }
                default: {
                    const micSession = getRecordingMicSession();
                    syncMutedStateForSession(normalizedSessionId);
                    await micSession.beginRecording();
                }
            }
        },
        stopCapture: async ({ sessionId, provider }) => {
            const normalizedSessionId = normalizeSessionId(sessionId);
            clearMicPlateauWatchdog();
            switch (provider) {
                case 'device': {
                    const { finalText } = await getDeviceSttController().stop();
                    const text = finalText;
                    if (activeCaptureProvider === provider && activeCaptureSessionId === normalizedSessionId) {
                        activeCaptureProvider = null;
                        activeCaptureSessionId = null;
                    }
                    return {
                        provider,
                        text,
                        continueHandsFree: runtimeTurnPolicyController.isHandsFreeCaptureSession({
                            provider,
                            sessionId,
                        }),
                    } as const;
                }
                case 'local_neural': {
                    const { finalText } = await getLocalNeuralSttController(activeLocalNeuralExecution).stop();
                    const text = finalText;
                    if (activeCaptureProvider === provider && activeCaptureSessionId === normalizedSessionId) {
                        activeCaptureProvider = null;
                        activeCaptureSessionId = null;
                    }
                    return {
                        provider,
                        text,
                        continueHandsFree: runtimeTurnPolicyController.isHandsFreeCaptureSession({
                            provider,
                            sessionId,
                        }),
                    } as const;
                }
                default: {
                    if (activeCaptureProvider === provider && activeCaptureSessionId === normalizedSessionId) {
                        activeCaptureProvider = null;
                        activeCaptureSessionId = null;
                    }
                    return {
                        provider,
                        uri: recordingMicSession
                            ? await recordingMicSession.stopRecording()
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
            mutedSessionId = normalizedSessionId;
            muted = nextMuted;
            if (activeCaptureSessionId === normalizedSessionId) {
                syncMutedStateForSession(normalizedSessionId);
            }
        },
        clearHandsFree: ({ sessionId, provider }) => {
            runtimeTurnPolicyController.clearHandsFreeCaptureSession({ provider, sessionId });
        },
        stopSession: async (sessionId) => {
            const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
                ? sessionId.trim()
                : null;

            clearMicPlateauWatchdog();
            if (activeAbortController) {
                try {
                    activeAbortController.abort();
                } catch {
                    // ignore
                }
                activeAbortController = null;
            }

            if (deviceSttController) {
                await deviceSttController.stop().catch(() => {});
            }
            if (sherpaSttController) {
                await sherpaSttController.stop().catch(() => {});
            }
            if (daemonStreamingSttController) {
                await daemonStreamingSttController.stop().catch(() => {});
            }

            (['device', 'local_neural'] as const).forEach((provider) => {
                runtimeTurnPolicyController.clearHandsFreeCaptureSession({
                    provider,
                    sessionId: normalizedSessionId,
                });
            });

            if (recordingMicSession) {
                recordingMicSession.setMuted(false);
                await recordingMicSession.teardown();
                recordingMicSession = null;
            }
            if (liveMicSession) {
                liveMicSession.setMuted(false);
                await liveMicSession.teardown();
                liveMicSession = null;
            }
            activeCaptureSessionId = null;
            activeCaptureProvider = null;
            mutedSessionId = null;
            muted = false;
        },
    };
}
