import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

/**
 * Inbound-stall watchdog for a STALLED-but-"open" realtime connection.
 *
 * While a turn is active a timer expects a steady stream of inbound
 * audio/events; each inbound event resets it. If nothing arrives within
 * `stallTimeoutMs` the connection is classified as stalled and `onStall` fires,
 * which the conversation controller routes through its existing reconnect path.
 *
 * It is the SINGLE owner of inbound-liveness detection. It never false-fires
 * during legitimate between-turn silence: the timer is only armed while a turn
 * is active or a response is awaited. It fires at most once per stall until
 * re-armed by a fresh inbound event or a new active window, so one stall cannot
 * spam reconnects.
 *
 * Provider-agnostic: its owner feeds it validated inbound control envelopes and
 * canonical turn edges, so no provider leaf owns a second liveness decision.
 */
export type RealtimeInboundWatchdog = Readonly<{
    /** Enable the watchdog (idempotent). While stopped, all signals are inert. */
    start: () => void;
    /** Disable + clear any pending stall timer (teardown boundary). */
    stop: () => void;
    /**
     * Arm (true) or disarm (false) the stall timer for the active turn. Arming
     * starts a fresh timeout; disarming clears it so between-turn silence is
     * never a stall.
     */
    markTurnActive: (active: boolean) => void;
    /**
     * Arm (true) or disarm (false) the AWAITING-RESPONSE window — the gap between
     * the user finishing their turn and the agent emitting its first audio
     * (`speaking`). The agent is "thinking": an inbound stream that dies here is
     * not caught by the (agent-audio-anchored) active-turn arm. This window uses
     * its own, more generous timeout (response generation legitimately takes
     * longer than an inter-chunk gap). Superseded by `markTurnActive(true)` once
     * the agent starts speaking. Disarming clears it (back to idle/listening).
     */
    markAwaitingResponse: (active: boolean) => void;
    /** Reset the stall timer on every inbound audio/event (no-op while inactive). */
    noteInboundEvent: () => void;
}>;

type CreateRealtimeInboundWatchdogOptions = Readonly<{
    onStall: () => void;
    stallTimeoutMs?: number;
    awaitingResponseTimeoutMs?: number;
}>;

export function createRealtimeInboundWatchdog(
    options: CreateRealtimeInboundWatchdogOptions,
): RealtimeInboundWatchdog {
    const stallTimeoutMs = Math.max(
        1,
        options.stallTimeoutMs ?? VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.inboundWatchdog.stallTimeoutMs,
    );
    const awaitingResponseTimeoutMs = Math.max(
        stallTimeoutMs,
        options.awaitingResponseTimeoutMs
            ?? VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.inboundWatchdog.awaitingResponseTimeoutMs,
    );

    let enabled = false;
    let turnActive = false;
    let awaitingResponse = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = (): void => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    /**
     * (Re)arm the stall timer. Only an active turn (agent speaking) OR the
     * awaiting-response (thinking) window arms it, so prolonged silence while the
     * session is genuinely idle (listening for the user) is legitimate and never
     * fires. The active-turn arm uses the tighter inter-chunk timeout; the
     * thinking window uses the more generous response-generation timeout. A
     * single firing does not auto-rearm — it waits for a fresh inbound event or a
     * new active/awaiting window — so one stall produces exactly one reconnect
     * signal.
     */
    const arm = (): void => {
        clearTimer();
        if (!enabled) {
            return;
        }
        // The active-turn window (agent already speaking) takes precedence and
        // uses the tighter timeout; otherwise the awaiting-response window uses
        // the generous timeout. Neither active → no arm.
        const timeoutMs = turnActive ? stallTimeoutMs : awaitingResponse ? awaitingResponseTimeoutMs : null;
        if (timeoutMs === null) {
            return;
        }
        timer = setTimeout(() => {
            timer = null;
            options.onStall();
        }, timeoutMs);
    };

    return {
        start: () => {
            enabled = true;
            if (turnActive || awaitingResponse) {
                arm();
            }
        },
        stop: () => {
            enabled = false;
            turnActive = false;
            awaitingResponse = false;
            clearTimer();
        },
        markTurnActive: (active) => {
            turnActive = active;
            if (active) {
                // The agent is now producing audio: the awaiting-response window
                // is over; the tighter active-turn arm takes over.
                awaitingResponse = false;
                arm();
            } else if (awaitingResponse) {
                // Leaving an active turn but still awaiting (rare): keep armed.
                arm();
            } else {
                clearTimer();
            }
        },
        markAwaitingResponse: (active) => {
            awaitingResponse = active;
            if (active && !turnActive) {
                arm();
            } else if (!active && !turnActive) {
                clearTimer();
            }
        },
        noteInboundEvent: () => {
            // An inbound event only matters while a turn is active or a response
            // is awaited; outside those windows it must not arm a stall timer
            // (idle/listening silence is legitimate).
            if (!enabled || (!turnActive && !awaitingResponse)) {
                return;
            }
            arm();
        },
    };
}
