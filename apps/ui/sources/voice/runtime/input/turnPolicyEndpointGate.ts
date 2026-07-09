import {
    createTurnPolicyMachine,
    type TurnPolicy,
    type TurnPolicyMachine,
} from '@/voice/runtime/input/turnPolicyMachine';

/**
 * Live-path adapter that layers the two-stage {@link createTurnPolicyMachine}
 * `confirmMs` false-start debounce over the acoustic endpoint stream.
 *
 * On the live capture path the acoustic VAD (or the heuristic finalizer) already
 * applies the trailing-silence hangover, so it surfaces a single
 * speech-end / candidate-endpoint edge. The capture owner, however, observes the
 * matching speech-START edge (first audio / first partial transcript). This gate
 * consumes both edges and replays them through the canonical state machine so a
 * sub-`confirmMs` speech blip is rejected as a false start and never opens a turn.
 *
 * Timing is driven by `now()` (monotonic wall clock), fed to the machine as
 * window-time — the machine itself stays pure and timer-free. The gate keeps the
 * machine private so callers only see the boolean "should this endpoint emit?".
 */
export type TurnPolicyEndpointGate = Readonly<{
    /** Mark the start (or continuation) of a detected speech segment. */
    noteSpeechDetected: () => void;
    /**
     * A candidate endpoint (VAD speech-end / heuristic finalize) arrived. Returns
     * `true` when the preceding speech was a confirmed turn (sustained past
     * `confirmMs`, or no start edge was observed at all — a VAD-only edge), and
     * `false` when it was a sub-`confirmMs` false start that must be suppressed.
     */
    shouldEmitEndpoint: () => boolean;
    /**
     * Duration (ms) of the speech segment that produced the most recent
     * {@link shouldEmitEndpoint} call, measured from the first observed
     * speech-start edge to that endpoint. Returns `null` when no speech-start was
     * observed for the segment (a VAD-only edge), so the duration is genuinely
     * unknown rather than reported as zero. Consumers forward this onto the
     * endpoint signal so the downstream backchannel duration gate can evaluate
     * real input instead of treating every barge-in as duration-unknown.
     */
    getLastSegmentDurationMs: () => number | null;
    /** Discard any in-flight confirming/speaking turn without emitting. */
    reset: () => void;
}>;

export function createTurnPolicyEndpointGate(args: Readonly<{
    policy?: Partial<TurnPolicy>;
    now?: () => number;
}> = {}): TurnPolicyEndpointGate {
    const now = args.now ?? (() => Date.now());
    const machine: TurnPolicyMachine = createTurnPolicyMachine({ policy: args.policy });
    // True once a speech-start edge has been observed for the current candidate
    // turn. When false, the endpoint is a VAD-only edge with no start signal and
    // must pass through unchanged (no regression for native/web VAD endpoints).
    let sawSpeechStart = false;
    // Window-time of the first speech-start edge for the current candidate, so the
    // segment duration (start → endpoint) can be reported on emission.
    let speechStartedAtMs: number | null = null;
    // Duration of the segment that produced the last `shouldEmitEndpoint` call.
    let lastSegmentDurationMs: number | null = null;

    return {
        noteSpeechDetected: () => {
            if (!sawSpeechStart) {
                speechStartedAtMs = now();
            }
            sawSpeechStart = true;
            machine.step({ detected: true, windowTimeMs: now() });
        },
        shouldEmitEndpoint: () => {
            const windowTimeMs = now();
            // No observed start edge → preserve the legacy single-stage contract:
            // the acoustic VAD/heuristic already decided this is an endpoint. The
            // segment duration is genuinely unknown (null), not zero.
            if (!sawSpeechStart) {
                lastSegmentDurationMs = null;
                machine.reset();
                return true;
            }

            lastSegmentDurationMs = speechStartedAtMs === null
                ? null
                : Math.max(0, windowTimeMs - speechStartedAtMs);

            // Advance the machine to the endpoint's window-time with detection
            // still high so `confirming → speaking` can fire iff confirmMs elapsed,
            // then drop detection to close the segment.
            machine.step({ detected: true, windowTimeMs });
            const confirmed = machine.phase() === 'speaking';
            machine.step({ detected: false, windowTimeMs });
            machine.reset();
            sawSpeechStart = false;
            speechStartedAtMs = null;
            return confirmed;
        },
        getLastSegmentDurationMs: () => lastSegmentDurationMs,
        reset: () => {
            machine.reset();
            sawSpeechStart = false;
            speechStartedAtMs = null;
            lastSegmentDurationMs = null;
        },
    };
}
