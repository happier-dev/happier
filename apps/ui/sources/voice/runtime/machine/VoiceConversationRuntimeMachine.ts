import { createAttemptGuard } from '@/utils/timing/attemptGuard';
import type { VoiceAdapterId } from '@/voice/session/types';

import {
    DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
    getVoiceConversationRuntimeSnapshot,
    setVoiceConversationRuntimeSnapshot,
} from './voiceConversationRuntimeStore';
import { createVoiceMachineError } from './voiceMachineError';
import type {
    VoiceConversationRuntimeSnapshot,
    VoiceConversationRuntimeState,
    VoiceMachineError,
} from './voiceConversationRuntimeTypes';

type StartListeningFn = (signal?: AbortSignal) => Promise<void>;

type RearmListeningArgs = Readonly<{
    controlSessionId: string;
    startListening: StartListeningFn;
}>;

type TransitionArgs = Readonly<{
    controlSessionId: string;
    /**
     * Owning adapter for an entry transition. Local engine adapters leave this
     * undefined (they share one ownerless machine slot, modeled as `null`);
     * non-local adapters (e.g. realtime) pass their id so a non-owning adapter
     * projects a disconnected snapshot.
     */
    adapterId?: VoiceAdapterId | null;
    /**
     * Existing controller attempt identity. Realtime callers supply it so a
     * delayed terminal/mute settlement from a replaced attempt cannot mutate
     * the current owner. Local engine callers intentionally use the `null`
     * owner slot.
     */
    attemptId?: number | null;
}>;

type MuteArgs = Readonly<{
    controlSessionId: string;
    adapterId: VoiceAdapterId | null;
    attemptId: number | null;
    micMuted: boolean;
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
    transitionToThinking: (args: TransitionArgs) => void;
    transitionToSpeaking: (args: TransitionArgs) => void;
    transitionToDisconnected: (args: TransitionArgs & { error?: VoiceMachineError | null }) => void;
    setReconnecting: (args: TransitionArgs & { reconnecting: boolean }) => void;
    setMuted: (args: MuteArgs) => void;
    setError: (args: TransitionArgs & { error: VoiceMachineError }) => void;
    reset: () => void;
}>;

/**
 * Source-state -> legal target-state map. A transition issued from a live
 * (non-`disconnected`) state is rejected (no-op + dev warning) when the target
 * is not reachable from the current state, so the single machine can never be
 * driven into an illegal lifecycle jump (e.g. `ending` -> `speaking`).
 * `disconnected` is the idle/entry state and intentionally permits any
 * transition (fresh starts, including typed-turn `thinking`).
 */
const LEGAL_TRANSITIONS: Record<VoiceConversationRuntimeState, ReadonlySet<VoiceConversationRuntimeState>> = {
    disconnected: new Set([
        'connecting', 'connected', 'acquiring_mic', 'listening', 'transcribing', 'thinking',
        'speaking', 'interrupted', 'ending', 'mic_error', 'error', 'disconnected',
    ]),
    connecting: new Set(['connecting', 'connected', 'acquiring_mic', 'listening', 'speaking', 'ending', 'disconnected', 'error', 'mic_error']),
    connected: new Set(['connected', 'acquiring_mic', 'listening', 'transcribing', 'thinking', 'speaking', 'interrupted', 'ending', 'disconnected', 'error', 'mic_error']),
    acquiring_mic: new Set(['acquiring_mic', 'connecting', 'connected', 'listening', 'transcribing', 'thinking', 'speaking', 'interrupted', 'ending', 'disconnected', 'error', 'mic_error']),
    listening: new Set(['listening', 'connected', 'acquiring_mic', 'transcribing', 'thinking', 'speaking', 'interrupted', 'ending', 'disconnected', 'error', 'mic_error']),
    transcribing: new Set(['transcribing', 'thinking', 'speaking', 'listening', 'connected', 'ending', 'disconnected', 'error', 'mic_error']),
    thinking: new Set(['thinking', 'speaking', 'transcribing', 'listening', 'connected', 'ending', 'disconnected', 'error', 'mic_error']),
    speaking: new Set(['speaking', 'interrupted', 'listening', 'connected', 'acquiring_mic', 'thinking', 'ending', 'disconnected', 'error', 'mic_error']),
    interrupted: new Set(['interrupted', 'acquiring_mic', 'listening', 'connected', 'ending', 'disconnected', 'error', 'mic_error']),
    ending: new Set(['ending', 'disconnected', 'connected', 'listening', 'error']),
    mic_error: new Set(['mic_error', 'acquiring_mic', 'listening', 'connected', 'ending', 'disconnected', 'error']),
    error: new Set(['error', 'disconnected', 'connected', 'acquiring_mic', 'connecting', 'listening', 'ending']),
};

/**
 * Entry transitions can start a fresh session or retarget the single machine
 * slot to a different control session, so they bypass the owner guard. Every
 * other transition must come from the session that currently owns the machine.
 */
const ENTRY_STATES: ReadonlySet<VoiceConversationRuntimeState> = new Set(['acquiring_mic', 'connecting']);

function warnIllegalTransition(
    from: VoiceConversationRuntimeState,
    to: VoiceConversationRuntimeState,
    reason: string,
): void {
    if (__DEV__) {
        // eslint-disable-next-line no-console
        console.warn(`[voiceConversationRuntimeMachine] rejected illegal transition ${from} -> ${to} (${reason})`);
    }
}

function isTransitionAllowed(
    current: VoiceConversationRuntimeSnapshot,
    controlSessionId: string,
    toState: VoiceConversationRuntimeState,
): boolean {
    // From the idle state any transition is legal (fresh starts).
    if (current.state === 'disconnected') {
        return true;
    }

    // Entry transitions start (or retarget) a session and may run from any
    // state, so they bypass both the owner guard and the source-state table.
    if (ENTRY_STATES.has(toState)) {
        return true;
    }

    const ownerMismatch =
        current.controlSessionId !== null && current.controlSessionId !== controlSessionId;
    if (ownerMismatch) {
        warnIllegalTransition(current.state, toState, 'owner_mismatch');
        return false;
    }

    if (!LEGAL_TRANSITIONS[current.state].has(toState)) {
        warnIllegalTransition(current.state, toState, 'illegal_source_state');
        return false;
    }

    return true;
}

function createProviderError(reason: string): VoiceMachineError {
    return createVoiceMachineError({
        kind: reason.includes('permission_denied') ? 'mic_permission_denied' : 'provider_error',
        reason,
    });
}

export function createVoiceConversationRuntimeMachine(): VoiceConversationRuntimeMachine {
    // Latest-wins guard over the rearm lifecycle: a newer rearm (or a `cancel`)
    // invalidates any in-flight start so its late completion can't write a stale
    // `mic_error`/`stt_timeout` onto whatever owns the snapshot now.
    const listeningAttemptGuard = createAttemptGuard();
    let activeListeningAbortController: AbortController | null = null;
    // The controller already owns realtime attempt allocation. Keep only its
    // current identity alongside this machine's single snapshot so delayed
    // provider completions are rejected at the canonical projection owner.
    let activeAttemptId: number | null = null;

    const cancelActiveListeningAttempt = (): void => {
        listeningAttemptGuard.cancel();
        activeListeningAbortController?.abort();
        activeListeningAbortController = null;
    };

    const cancelActiveListeningAttemptIfOwned = ({
        controlSessionId,
        adapterId,
        attemptId,
    }: TransitionArgs): void => {
        const current = getVoiceConversationRuntimeSnapshot();
        if (
            current.controlSessionId === controlSessionId
            && current.adapterId === (adapterId ?? null)
            && (attemptId === undefined || activeAttemptId === attemptId)
        ) {
            cancelActiveListeningAttempt();
        }
    };

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

    type StateTransition = Readonly<{
        controlSessionId: string;
        toState: VoiceConversationRuntimeState;
        /** `undefined` preserves the current error; otherwise the error is set. */
        error?: VoiceMachineError | null;
        clearError?: boolean;
        /** Owning adapter for entry transitions; `undefined` preserves the owner. */
        adapterId?: VoiceAdapterId | null;
        /** Existing controller attempt identity; `undefined` preserves it outside entry. */
        attemptId?: number | null;
    }>;

    const applyStateTransition = (transition: StateTransition): void => {
        let accepted = false;
        let nextActiveAttemptId = activeAttemptId;
        patchSnapshot((current) => {
            if (!isTransitionAllowed(current, transition.controlSessionId, transition.toState)) {
                return current;
            }

            const isEntryTransition = ENTRY_STATES.has(transition.toState);
            const nextAdapterId =
                transition.toState === 'disconnected' || isEntryTransition
                    ? (transition.adapterId ?? null)
                    : (transition.adapterId ?? current.adapterId);

            const adapterMismatch = !isEntryTransition
                && transition.toState !== 'disconnected'
                && transition.adapterId !== undefined
                && current.adapterId !== (transition.adapterId ?? null);
            if (adapterMismatch) {
                warnIllegalTransition(current.state, transition.toState, 'adapter_mismatch');
                return current;
            }

            const attemptMismatch = !isEntryTransition
                && transition.attemptId !== undefined
                && activeAttemptId !== transition.attemptId;
            if (attemptMismatch) {
                warnIllegalTransition(current.state, transition.toState, 'attempt_mismatch');
                return current;
            }

            const clearsAttempt = transition.toState === 'disconnected'
                || transition.toState === 'error'
                || transition.toState === 'mic_error';
            const ownerAttemptId = clearsAttempt
                ? null
                : isEntryTransition
                    ? (transition.attemptId ?? null)
                    : (transition.attemptId ?? activeAttemptId);

            const nextError = transition.clearError
                ? null
                : transition.error !== undefined
                    ? transition.error
                    : current.error;

            const sameOwner = current.controlSessionId === transition.controlSessionId
                && current.adapterId === nextAdapterId
                && activeAttemptId === ownerAttemptId;
            const terminalState = transition.toState === 'disconnected'
                || transition.toState === 'ending'
                || transition.toState === 'error'
                || transition.toState === 'mic_error';
            const nextReconnecting = terminalState
                ? false
                : ENTRY_STATES.has(transition.toState) && !sameOwner
                    ? false
                    : current.reconnecting;

            accepted = true;
            nextActiveAttemptId = ownerAttemptId;
            return {
                ...current,
                adapterId: nextAdapterId,
                controlSessionId: transition.controlSessionId,
                state: transition.toState,
                reconnecting: nextReconnecting,
                micMuted: clearsAttempt || (isEntryTransition && !sameOwner)
                    ? false
                    : current.micMuted,
                error: nextError,
            };
        });
        if (accepted) {
            activeAttemptId = nextActiveAttemptId;
        }
    };

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

    /**
     * Write a `mic_error` for a rearm failure only when this attempt still owns
     * the snapshot: the attempt token is current AND the snapshot is still the
     * `acquiring_mic` state for the same control session. A slow start that
     * resolves/rejects after the user disconnected, switched sessions, or began a
     * newer rearm must not stomp `mic_error` onto the live snapshot.
     */
    const failRearmIfStillOwner = (
        token: number,
        controlSessionId: string,
        error: VoiceMachineError,
    ): void => {
        if (!listeningAttemptGuard.isCurrent(token)) {
            return;
        }
        patchSnapshot((current) => {
            const isCurrentRearmOwner =
                current.controlSessionId === controlSessionId
                && current.state === 'acquiring_mic';
            if (!isCurrentRearmOwner) {
                return current;
            }
            return {
                ...current,
                controlSessionId,
                state: 'mic_error',
                error,
            };
        });
    };

    const rearmListening = async ({ controlSessionId, startListening }: RearmListeningArgs): Promise<void> => {
        const token = listeningAttemptGuard.next();
        applyStateTransition({
            controlSessionId,
            toState: 'acquiring_mic',
            clearError: true,
        });

        // Provider and carrier owners bound their own admission/start phases.
        // This machine owns lifecycle cancellation and stale completion, not an
        // overlapping elapsed-time deadline for the whole composed start.
        activeListeningAbortController?.abort();
        const abortController = new AbortController();
        activeListeningAbortController = abortController;

        try {
            await startListening(abortController.signal);
        } catch (error) {
            const reason = error instanceof Error ? error.message : 'listening_start_failed';
            failRearmIfStillOwner(token, controlSessionId, createProviderError(reason));
            return;
        } finally {
            if (activeListeningAbortController === abortController) {
                activeListeningAbortController = null;
            }
        }

        if (!listeningAttemptGuard.isCurrent(token)) {
            return;
        }
        confirmListeningStarted({ controlSessionId });
    };

    return {
        getSnapshot: () => getVoiceConversationRuntimeSnapshot(),
        transitionToAcquiringMic: ({ controlSessionId, adapterId, attemptId }) => {
            applyStateTransition({ controlSessionId, toState: 'acquiring_mic', clearError: true, adapterId, attemptId });
        },
        transitionToConnecting: ({ controlSessionId, adapterId, attemptId }) => {
            applyStateTransition({ controlSessionId, toState: 'connecting', clearError: true, adapterId, attemptId });
        },
        transitionToInterrupted: ({ controlSessionId, adapterId, attemptId }) => {
            applyStateTransition({ controlSessionId, toState: 'interrupted', adapterId, attemptId });
        },
        transitionToEnding: ({ controlSessionId, adapterId, attemptId }) => {
            cancelActiveListeningAttemptIfOwned({ controlSessionId, adapterId, attemptId });
            applyStateTransition({ controlSessionId, toState: 'ending', adapterId, attemptId });
        },
        rearmListening,
        interruptAndRearmListening: async (args) => {
            applyStateTransition({ controlSessionId: args.controlSessionId, toState: 'interrupted' });
            await rearmListening(args);
        },
        confirmListeningStarted,
        transitionToConnected: ({ controlSessionId, adapterId, attemptId }) => {
            applyStateTransition({ controlSessionId, toState: 'connected', clearError: true, adapterId, attemptId });
        },
        transitionToListening: ({ controlSessionId, adapterId, attemptId }) => {
            applyStateTransition({ controlSessionId, toState: 'listening', clearError: true, adapterId, attemptId });
        },
        transitionToTranscribing: ({ controlSessionId, adapterId, attemptId }) => {
            applyStateTransition({ controlSessionId, toState: 'transcribing', clearError: true, adapterId, attemptId });
        },
        transitionToThinking: ({ controlSessionId, adapterId, attemptId }) => {
            applyStateTransition({ controlSessionId, toState: 'thinking', clearError: true, adapterId, attemptId });
        },
        transitionToSpeaking: ({ controlSessionId, adapterId, attemptId }) => {
            applyStateTransition({ controlSessionId, toState: 'speaking', clearError: true, adapterId, attemptId });
        },
        transitionToDisconnected: ({ controlSessionId, adapterId, attemptId, error = null }) => {
            cancelActiveListeningAttemptIfOwned({ controlSessionId, adapterId, attemptId });
            applyStateTransition({ controlSessionId, toState: 'disconnected', error, adapterId: adapterId ?? null, attemptId });
        },
        setReconnecting: ({ controlSessionId, adapterId, attemptId, reconnecting }) => {
            patchSnapshot((current) => {
                const ownsSnapshot = current.controlSessionId === controlSessionId
                    && current.adapterId === (adapterId ?? null)
                    && (attemptId === undefined || activeAttemptId === attemptId)
                    && current.state !== 'disconnected'
                    && current.state !== 'ending'
                    && current.state !== 'error'
                    && current.state !== 'mic_error';
                if (!ownsSnapshot || current.reconnecting === reconnecting) {
                    return current;
                }
                return { ...current, reconnecting };
            });
        },
        setMuted: ({ controlSessionId, adapterId, attemptId, micMuted }) => {
            patchSnapshot((current) => {
                const ownsSnapshot = current.controlSessionId === controlSessionId
                    && current.adapterId === adapterId
                    && activeAttemptId === attemptId
                    && current.state !== 'disconnected'
                    && current.state !== 'ending'
                    && current.state !== 'error'
                    && current.state !== 'mic_error';
                if (!ownsSnapshot || current.micMuted === micMuted) {
                    return current;
                }
                return { ...current, micMuted };
            });
        },
        setError: ({ controlSessionId, adapterId, attemptId, error }) => {
            applyStateTransition({ controlSessionId, toState: 'error', error, adapterId, attemptId });
        },
        reset: () => {
            // Invalidate any in-flight rearm so a late completion cannot revive a
            // stale listening/error state after the runtime has been reset.
            cancelActiveListeningAttempt();
            activeAttemptId = null;
            setVoiceConversationRuntimeSnapshot(DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
        },
    };
}

export const voiceConversationRuntimeMachine = createVoiceConversationRuntimeMachine();
