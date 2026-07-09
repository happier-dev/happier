import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import type { MicSessionFailureKind } from '@/voice/runtime/mic/MicSession';

/**
 * Realtime failure kind taxonomy carried across the reconnect boundary. Mirrors
 * the subset surfaced by `RealtimeTransport` (mic failures + provider/permission
 * faults). Provider-agnostic: the controller never branches on ElevenLabs.
 */
export type RealtimeReconnectFailureKind =
    | MicSessionFailureKind
    | 'provider_error'
    | 'mic_permission_denied'
    | 'transport_disconnect';

export type RealtimeReconnectFailure = Readonly<{
    controlSessionId: string | null;
    kind: RealtimeReconnectFailureKind;
    reason: string;
}>;

export type RealtimeReconnectAttempt = Readonly<{
    controlSessionId: string | null;
    /** 1-based attempt number within the current drop's retry budget. */
    attempt: number;
}>;

/**
 * Bounded-backoff reconnect controller for a TRANSIENT realtime WS/transport
 * drop (plan snippet #15: debounced recovery + retry cap).
 *
 * SINGLE owner of realtime reconnect orchestration. On a transient drop it:
 *  1. surfaces the drop through the machine's RECOVERABLE-error path (graceful
 *     `disconnected` + retry, NOT a hard `error`) so session/turn continuity is
 *     preserved on the UI while reconnect runs;
 *  2. schedules a reconnect attempt after an exponential backoff (base → cap);
 *  3. on a failed attempt, doubles the backoff and retries up to `maxRetries`;
 *  4. once attempts are exhausted, surfaces the drop as NON-recoverable
 *     (`error`).
 *
 * A NON-recoverable drop (auth/quota/permission) skips reconnect entirely and
 * surfaces `error` immediately.
 *
 * The controller is timing-only and fully injectable, so reconnect mechanics
 * (re-establishing the ElevenLabs conversation) and machine state writes live in
 * the transport, keeping provider specifics out of this shared primitive.
 */
export type RealtimeReconnectController = Readonly<{
    /**
     * A transient drop: surface recoverable, then drive the bounded-backoff
     * reconnect loop. A new drop while a loop is pending resets the retry budget.
     */
    handleTransientDrop: (failure: RealtimeReconnectFailure) => void;
    /** A non-recoverable drop: surface `error` immediately, no reconnect. */
    handleNonRecoverableDrop: (failure: RealtimeReconnectFailure) => void;
    /** Cancel any pending reconnect (a clean stop / successful manual restart). */
    cancel: () => void;
}>;

type ReconnectBackoffConfig = Readonly<{
    baseBackoffMs: number;
    maxBackoffMs: number;
    backoffFactor: number;
    maxRetries: number;
}>;

type CreateRealtimeReconnectControllerOptions = Readonly<{
    /**
     * Re-establish the live provider session, preserving session/turn continuity.
     * Resolves `true` when the session is live again, `false` when the attempt
     * failed and the controller should back off and retry (or, if the budget is
     * exhausted, surface non-recoverable). Rejections are treated as `false`.
     */
    attemptReconnect: (attempt: RealtimeReconnectAttempt) => Promise<boolean>;
    /** Surface the drop as a recoverable failure (graceful disconnected + retry). */
    surfaceRecoverable: (failure: RealtimeReconnectFailure) => void;
    /** Surface the drop as a non-recoverable failure (hard error). */
    surfaceNonRecoverable: (failure: RealtimeReconnectFailure) => void;
    config?: Partial<ReconnectBackoffConfig>;
}>;

export function createRealtimeReconnectController(
    options: CreateRealtimeReconnectControllerOptions,
): RealtimeReconnectController {
    const defaults = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect;
    const config: ReconnectBackoffConfig = {
        baseBackoffMs: Math.max(1, options.config?.baseBackoffMs ?? defaults.baseBackoffMs),
        maxBackoffMs: Math.max(1, options.config?.maxBackoffMs ?? defaults.maxBackoffMs),
        backoffFactor: Math.max(1, options.config?.backoffFactor ?? defaults.backoffFactor),
        maxRetries: Math.max(0, options.config?.maxRetries ?? defaults.maxRetries),
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let attemptsMade = 0;
    /**
     * Latest-wins generation: a `cancel()` or a fresh `handleTransientDrop`
     * bumps it so a still-pending attempt from a stale drop can't resume the
     * loop after the world has moved on.
     */
    let generation = 0;

    const clearTimer = (): void => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const computeBackoffMs = (attemptIndex: number): number => {
        // attemptIndex is 0-based for the delay BEFORE attempt (attemptIndex+1).
        const raw = config.baseBackoffMs * config.backoffFactor ** attemptIndex;
        return Math.min(config.maxBackoffMs, raw);
    };

    const scheduleNextAttempt = (failure: RealtimeReconnectFailure, runGeneration: number): void => {
        if (runGeneration !== generation) {
            return;
        }
        if (attemptsMade >= config.maxRetries) {
            // Retry budget exhausted → the drop is now non-recoverable.
            options.surfaceNonRecoverable(failure);
            return;
        }

        const delayMs = computeBackoffMs(attemptsMade);
        clearTimer();
        timer = setTimeout(() => {
            timer = null;
            void runAttempt(failure, runGeneration);
        }, delayMs);
    };

    const runAttempt = async (failure: RealtimeReconnectFailure, runGeneration: number): Promise<void> => {
        if (runGeneration !== generation) {
            return;
        }
        attemptsMade += 1;
        const attempt = attemptsMade;
        let succeeded = false;
        try {
            succeeded = await options.attemptReconnect({
                controlSessionId: failure.controlSessionId,
                attempt,
            });
        } catch {
            // A throwing reconnect is treated as a failed attempt; back off + retry.
            succeeded = false;
        }

        if (runGeneration !== generation) {
            // A newer drop / cancel superseded this attempt while it was awaiting.
            return;
        }

        if (succeeded) {
            // Reconnected: stop the loop. The transport drives the machine back to
            // a connected projection on the provider's `onConnect`.
            clearTimer();
            return;
        }

        scheduleNextAttempt(failure, runGeneration);
    };

    return {
        handleTransientDrop: (failure) => {
            // A fresh drop resets the retry budget and supersedes any pending loop.
            generation += 1;
            const runGeneration = generation;
            clearTimer();
            attemptsMade = 0;

            // Surface recoverable FIRST so the UI shows graceful disconnected+retry
            // (continuity preserved) before the backoff begins.
            options.surfaceRecoverable(failure);
            scheduleNextAttempt(failure, runGeneration);
        },
        handleNonRecoverableDrop: (failure) => {
            // Permanent fault: abandon any pending reconnect and hard-error.
            generation += 1;
            clearTimer();
            attemptsMade = 0;
            options.surfaceNonRecoverable(failure);
        },
        cancel: () => {
            generation += 1;
            clearTimer();
            attemptsMade = 0;
        },
    };
}
