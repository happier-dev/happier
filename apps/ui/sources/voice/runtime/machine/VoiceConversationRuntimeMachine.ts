import {
    DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
    getVoiceConversationRuntimeSnapshot,
    setVoiceConversationRuntimeSnapshot,
} from './voiceConversationRuntimeStore';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import type {
    VoiceConversationRuntimeSnapshot,
    VoiceMachineError,
} from './voiceConversationRuntimeTypes';

type StartListeningFn = () => Promise<void>;

type RearmListeningArgs = Readonly<{
    controlSessionId: string;
    startListening: StartListeningFn;
}>;

type TransitionArgs = Readonly<{
    controlSessionId: string;
}>;

export type VoiceConversationRuntimeMachine = Readonly<{
    getSnapshot: () => VoiceConversationRuntimeSnapshot;
    transitionToAcquiringMic: (args: TransitionArgs) => void;
    transitionToConnecting: (args: TransitionArgs) => void;
    transitionToInterrupted: (args: TransitionArgs) => void;
    transitionToEnding: (args: TransitionArgs) => void;
    rearmListening: (args: RearmListeningArgs) => Promise<void>;
    interruptAndRearmListening: (args: RearmListeningArgs) => Promise<void>;
    confirmListeningStarted: (args: TransitionArgs) => void;
    transitionToConnected: (args: TransitionArgs) => void;
    transitionToListening: (args: TransitionArgs) => void;
    transitionToTranscribing: (args: TransitionArgs) => void;
    transitionToSending: (args: TransitionArgs) => void;
    transitionToSpeaking: (args: TransitionArgs) => void;
    transitionToDisconnected: (args: TransitionArgs & { error?: VoiceMachineError | null }) => void;
    setMuted: (muted: boolean) => void;
    setError: (args: TransitionArgs & { error: VoiceMachineError }) => void;
    reset: () => void;
}>;

type CreateVoiceConversationRuntimeMachineOptions = Readonly<{
    listeningStartTimeoutMs?: number;
}>;

export function createVoiceMachineError(params: Readonly<{
    kind: VoiceMachineError['kind'];
    reason: string;
    recoverable: boolean;
}>): VoiceMachineError {
    return {
        kind: params.kind,
        reason: params.reason,
        recoverable: params.recoverable,
    };
}

function createSttTimeoutError(): VoiceMachineError {
    return {
        kind: 'stt_timeout',
        reason: 'listening_start_timeout',
        recoverable: true,
    };
}

function createProviderError(reason: string): VoiceMachineError {
    return createVoiceMachineError({
        kind: reason.includes('permission_denied') ? 'mic_permission_denied' : 'provider_error',
        reason,
        recoverable: true,
    });
}

export function createVoiceConversationRuntimeMachine(
    options: CreateVoiceConversationRuntimeMachineOptions = {},
): VoiceConversationRuntimeMachine {
    const listeningStartTimeoutMs = Math.max(
        1,
        options.listeningStartTimeoutMs ?? VOICE_RUNTIME_CONFIG_DEFAULTS.listeningStartTimeoutMs,
    );

    const patchSnapshot = (
        updater: (current: VoiceConversationRuntimeSnapshot) => VoiceConversationRuntimeSnapshot,
    ): VoiceConversationRuntimeSnapshot => {
        let nextSnapshot = getVoiceConversationRuntimeSnapshot();
        setVoiceConversationRuntimeSnapshot((current) => {
            nextSnapshot = updater(current);
            return nextSnapshot;
        });
        return nextSnapshot;
    };

    const setForSession = (
        controlSessionId: string,
        updater: (current: VoiceConversationRuntimeSnapshot) => VoiceConversationRuntimeSnapshot,
    ): VoiceConversationRuntimeSnapshot =>
        patchSnapshot((current) =>
            updater({
                ...current,
                controlSessionId,
            }),
        );

    const confirmListeningStarted = ({ controlSessionId }: TransitionArgs): void => {
        patchSnapshot((current) => {
            const isCurrentListeningOwner =
                current.controlSessionId === controlSessionId
                && (current.state === 'acquiring_mic' || current.state === 'listening');
            if (!isCurrentListeningOwner) {
                return current;
            }
            return {
                ...current,
                controlSessionId,
                state: 'listening',
                error: null,
            };
        });
    };

    const rearmListening = async ({ controlSessionId, startListening }: RearmListeningArgs): Promise<void> => {
        setForSession(controlSessionId, (current) => ({
            ...current,
            controlSessionId,
            state: 'acquiring_mic',
            error: null,
        }));

        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let timedOut = false;

        try {
            await Promise.race([
                startListening(),
                new Promise<void>((resolve) => {
                    timeoutId = setTimeout(() => {
                        timedOut = true;
                        resolve();
                    }, listeningStartTimeoutMs);
                }),
            ]);
        } catch (error) {
            const reason = error instanceof Error ? error.message : 'listening_start_failed';
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'mic_error',
                error: createProviderError(reason),
            }));
            return;
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }

        if (timedOut) {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'mic_error',
                error: createSttTimeoutError(),
            }));
            return;
        }

        confirmListeningStarted({ controlSessionId });
    };

    return {
        getSnapshot: () => getVoiceConversationRuntimeSnapshot(),
        transitionToAcquiringMic: ({ controlSessionId }) => {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'acquiring_mic',
                error: null,
            }));
        },
        transitionToConnecting: ({ controlSessionId }) => {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'connecting',
                error: null,
            }));
        },
        transitionToInterrupted: ({ controlSessionId }) => {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'interrupted',
            }));
        },
        transitionToEnding: ({ controlSessionId }) => {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'ending',
            }));
        },
        rearmListening,
        interruptAndRearmListening: async (args) => {
            setForSession(args.controlSessionId, (current) => ({
                ...current,
                controlSessionId: args.controlSessionId,
                state: 'interrupted',
            }));
            await rearmListening(args);
        },
        confirmListeningStarted,
        transitionToConnected: ({ controlSessionId }) => {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'connected',
                error: null,
            }));
        },
        transitionToListening: ({ controlSessionId }) => {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'listening',
                error: null,
            }));
        },
        transitionToTranscribing: ({ controlSessionId }) => {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'transcribing',
                error: null,
            }));
        },
        transitionToSending: ({ controlSessionId }) => {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'sending',
                error: null,
            }));
        },
        transitionToSpeaking: ({ controlSessionId }) => {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'speaking',
                error: null,
            }));
        },
        transitionToDisconnected: ({ controlSessionId, error = null }) => {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'disconnected',
                error,
            }));
        },
        setMuted: (micMuted) => {
            patchSnapshot((current) => ({
                ...current,
                micMuted,
            }));
        },
        setError: ({ controlSessionId, error }) => {
            setForSession(controlSessionId, (current) => ({
                ...current,
                controlSessionId,
                state: 'error',
                error,
            }));
        },
        reset: () => {
            setVoiceConversationRuntimeSnapshot(DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
        },
    };
}

export const voiceConversationRuntimeMachine = createVoiceConversationRuntimeMachine();
