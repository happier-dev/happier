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

type RuntimeCaptureError = Readonly<{
    controlSessionId: string;
    kind?: VoiceMachineErrorKind;
    reason: string;
}>;

type DeviceSttControllerDeps = Parameters<typeof createDeviceSttController>[0];
type SherpaStreamingSttControllerDeps = Parameters<typeof createSherpaStreamingSttController>[0];

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
}>;

type LocalVoiceCaptureOwnerOptions = Readonly<{
    createLiveMicSession?: (options?: Parameters<typeof createLiveMicSession>[0]) => MicSession;
    createRecordingMicSession?: () => RecordingMicSession;
    createDeviceSttController?: (deps: DeviceSttControllerDeps) => DeviceSttController;
    createSherpaSttController?: (deps: SherpaStreamingSttControllerDeps) => SherpaStreamingSttController;
    runtimeTurnPolicyController?: RuntimeTurnPolicyController;
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
    const normalizeSessionId = (sessionId: string | null | undefined): string | null =>
        typeof sessionId === 'string' && sessionId.trim().length > 0
            ? sessionId.trim()
            : null;
    const runtimeTurnPolicyController =
        options.runtimeTurnPolicyController
        ?? createRuntimeTurnPolicyController();
    const handleLiveMicFailure = (failure: MicSessionFailure): void => {
        const activeSessionId = activeCaptureSessionId;
        const activeProvider = activeCaptureProvider;
        if (!activeSessionId || (activeProvider !== 'device' && activeProvider !== 'local_neural')) {
            return;
        }

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
    const getLiveMicSession = (): MicSession => {
        liveMicSession ??=
            options.createLiveMicSession?.({
                onFailure: handleLiveMicFailure,
            })
            ?? createLiveMicSession({
                onFailure: handleLiveMicFailure,
            });
        return liveMicSession;
    };
    const getRecordingMicSession = (): RecordingMicSession => {
        recordingMicSession ??=
            options.createRecordingMicSession?.()
            ?? createDefaultRecordingMicSession();
        return recordingMicSession;
    };
    const createEndpointController = (): TurnEndpointController => createTurnEndpointController({
        onSignal: (signal) => {
            deps.onEndpointSignal?.(signal);
        },
    });
    const createOwnedNativeVadController = (): NativeVadController => createNativeVadController({
        onEndpointSignal: (signal) => {
            deps.onEndpointSignal?.(signal);
        },
    });
    const createOwnedWebVadController = (): WebVadController => createWebVadController({
        onEndpointSignal: (signal) => {
            deps.onEndpointSignal?.(signal);
        },
    });
    let deviceSttController: DeviceSttController | null = null;
    const getDeviceSttController = (): DeviceSttController => {
        deviceSttController ??= options.createDeviceSttController?.({
            endpointController: createEndpointController(),
            getSettings: deps.getSettings,
            onCaptureStarted: deps.onCaptureStarted,
            onCaptureError: deps.onCaptureError,
            onEndpointSignal: deps.onEndpointSignal,
            nativeVadController: createOwnedNativeVadController(),
            webVadController: createOwnedWebVadController(),
        })
        ?? createDefaultDeviceSttController({
            onCaptureStarted: deps.onCaptureStarted,
            onCaptureError: deps.onCaptureError,
            getSettings: deps.getSettings,
            onEndpointSignal: deps.onEndpointSignal,
            endpointController: createEndpointController(),
            nativeVadController: createOwnedNativeVadController(),
            webVadController: createOwnedWebVadController(),
        });
        return deviceSttController;
    };
    let sherpaSttController: SherpaStreamingSttController | null = null;
    const getSherpaSttController = (): SherpaStreamingSttController => {
        sherpaSttController ??= options.createSherpaSttController?.({
            endpointController: createEndpointController(),
            onCaptureStarted: deps.onCaptureStarted,
            onCaptureError: deps.onCaptureError,
            getSettings: deps.getSettings,
            onEndpointSignal: deps.onEndpointSignal,
        })
        ?? createDefaultSherpaStreamingSttController({
            onCaptureStarted: deps.onCaptureStarted,
            onCaptureError: deps.onCaptureError,
            getSettings: deps.getSettings,
            onEndpointSignal: deps.onEndpointSignal,
            endpointController: createEndpointController(),
        });
        return sherpaSttController;
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
        const stopped = await (async () => {
            switch (args.provider) {
                case 'device': {
                    const text = await getDeviceSttController().stop(args.sessionId);
                    return {
                        continueHandsFree: runtimeTurnPolicyController.isHandsFreeCaptureSession({
                            provider: args.provider,
                            sessionId: args.sessionId,
                        }),
                        text,
                    } as const;
                }
                case 'local_neural': {
                    const text = await getSherpaSttController().stop(args.sessionId);
                    return {
                        continueHandsFree: runtimeTurnPolicyController.isHandsFreeCaptureSession({
                            provider: args.provider,
                            sessionId: args.sessionId,
                        }),
                        text,
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
        startCapture: async ({ sessionId, provider, handsFree }) => {
            configureHandsFree({ sessionId, provider, handsFree });
            const normalizedSessionId = normalizeSessionId(sessionId) ?? sessionId;
            activeCaptureSessionId = normalizedSessionId;
            activeCaptureProvider = provider;
            switch (provider) {
                case 'device': {
                    const micSession = getLiveMicSession();
                    syncMutedStateForSession(normalizedSessionId);
                    await getDeviceSttController().start(sessionId, micSession);
                    return;
                }
                case 'local_neural': {
                    const micSession = getLiveMicSession();
                    syncMutedStateForSession(normalizedSessionId);
                    await getSherpaSttController().start(sessionId, micSession);
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
            switch (provider) {
                case 'device': {
                    const text = await getDeviceSttController().stop(sessionId);
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
                    const text = await getSherpaSttController().stop(sessionId);
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

            if (normalizedSessionId) {
                if (deviceSttController) {
                    await deviceSttController.stop(normalizedSessionId).catch(() => {});
                }
                if (sherpaSttController) {
                    await sherpaSttController.stop(normalizedSessionId).catch(() => {});
                }
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
