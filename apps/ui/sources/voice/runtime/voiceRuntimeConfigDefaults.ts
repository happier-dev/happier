import {
    VOICE_RUNTIME_STT_DEFAULTS,
    VOICE_RUNTIME_TTS_DEFAULTS,
    VOICE_RUNTIME_WARM_DEFAULTS,
} from '@happier-dev/protocol';

export const VOICE_RUNTIME_CONFIG_DEFAULTS = {
    realtimeConversationHandleReadyTimeoutMs: 500,
    realtimeStartAbortGraceMs: 1_000,
    realtimeWatchdogPollMs: 3_000,
    realtimeWatchdogPlateauMs: 10_000,
    /**
     * Realtime conversation hardening knobs — the single source of truth for the
     * transient-drop reconnect backoff and the inbound-audio/event stall
     * watchdog. The provider-neutral conversation runtime and the modules under
     * `runtime/realtime/**` derive their typed timers from these so call sites
     * carry no magic numbers and the values cannot drift. Provider-specific
     * behavior stays inside its own provider folder; only the timing/retry
     * policy lives here.
     */
    realtime: {
        /** Maximum time for a provider connection or its initial context handshake to settle. */
        connectionReadyTimeoutMs: 30_000,
        /**
         * Bounded-backoff reconnect on a TRANSIENT realtime WS/transport drop.
         * Each transient drop routes through the machine's recoverable-error path
         * (graceful `disconnected` + retry, not a hard `error`) while a backoff
         * timer schedules the next attempt; session/turn state is preserved
         * across attempts. After `maxRetries` exhausted attempts the failure is
         * surfaced as non-recoverable (`error`). A non-recoverable drop
         * (auth/quota/permission) skips reconnect entirely.
         */
        reconnect: {
            /** First backoff delay; doubled each attempt up to `maxBackoffMs`. */
            baseBackoffMs: 500,
            /** Upper bound on a single backoff delay. */
            maxBackoffMs: 8_000,
            /** Exponential growth factor applied to the backoff each attempt. */
            backoffFactor: 2,
            /** Reconnect attempts before the drop is surfaced as non-recoverable. */
            maxRetries: 5,
        },
        /**
         * Inbound stall watchdog — detects a STALLED-but-"open" connection where
         * no inbound audio/events arrive while a turn is active. Debounced,
         * re-entrancy-guarded, reset on every inbound event, and quiescent
         * during legitimate between-turn silence (only armed while a turn is
         * active or a response is awaited).
         */
        inboundWatchdog: {
            /** No inbound event within this window (while a turn is active) is a stall. */
            stallTimeoutMs: 6_000,
            /**
             * No inbound event within this (more generous) window during the
             * AWAITING-RESPONSE / "thinking" gap — after the user's turn ends but
             * before the agent emits its first audio — is a stall. Larger than
             * `stallTimeoutMs` because response generation legitimately takes
             * longer than an inter-chunk gap.
             */
            awaitingResponseTimeoutMs: 12_000,
        },
    },
    /**
     * Conversational turn-taking thresholds — the single source of truth for the
     * endpoint hysteresis machine, the backchannel / false-barge gate, and the
     * textual echo guard. Modules under `runtime/input/**` and `runtime/echo/**`
     * derive their `DEFAULT_*` typed constants from these so call sites carry no
     * magic numbers and the values cannot drift.
     */
    turnTaking: {
        interruption: {
            /** Hard bound for provisional duck/pause before fail-safe false-alarm restoration. */
            candidateMaxMs: 3_000,
            /** Maximum playable PCM tail retained while a candidate is evaluated. */
            retainedOutputMaxMs: 1_500,
            /** Audible acknowledgement without fully silencing duck-capable remote output. */
            duckGain: 0.18,
        },
        /** Two-stage endpointing debounce layered above the acoustic VAD. */
        endpointHysteresis: {
            /** Sustained detection required before a turn is confirmed (false-start debounce). */
            confirmMs: 800,
            /** Trailing silence required to end a confirmed turn (end-of-turn hangover). */
            silenceMs: 700,
        },
        /** Contextual backchannel / false-barge gate (min-words / min-duration). */
        backchannelGate: {
            /** Utterances with at most this many words are candidate backchannels. */
            maxWords: 3,
            /** Utterances no longer than this (when duration is known) are candidate backchannels. */
            maxDurationMs: 700,
            /** While the agent is speaking, the first window is non-interruptible. */
            protectedHeadMs: 800,
            /** Optional STT-confidence floor; below it a short utterance is treated as noise. */
            minConfidence: null as number | null,
        },
        /** Textual echo guard for open-speaker barge-in. */
        textualEchoGuard: {
            /** Drop when candidate↔TTS token overlap is at least this ratio. */
            overlapThreshold: 0.7,
            /** Drop any candidate arriving within this window after TTS start (AEC not converged). */
            justStartedGuardMs: 200,
        },
    },
    daemonInference: {
        warmIdleEvictMs: VOICE_RUNTIME_WARM_DEFAULTS.warmIdleEvictMs,
        warmOnVoiceHomeAttach: VOICE_RUNTIME_WARM_DEFAULTS.warmOnVoiceHomeAttach,
        perModelConcurrency: VOICE_RUNTIME_WARM_DEFAULTS.perModelConcurrency,
        statusPollMs: 750,
        tts: {
            defaultCodec: {
                codec: VOICE_RUNTIME_TTS_DEFAULTS.defaultCodec.codec,
                mimeType: VOICE_RUNTIME_TTS_DEFAULTS.defaultCodec.mimeType,
            },
            latencyBudgetMs: VOICE_RUNTIME_TTS_DEFAULTS.latencyBudgetMs,
            consecutiveSlowCallsBeforeDemotion: VOICE_RUNTIME_TTS_DEFAULTS.consecutiveSlowCallsBeforeDemotion,
        },
        stt: {
            maxUploadBytes: VOICE_RUNTIME_STT_DEFAULTS.maxUploadBytes,
            acceptedInputFormats: VOICE_RUNTIME_STT_DEFAULTS.acceptedInputFormats,
        },
    },
} as const;
