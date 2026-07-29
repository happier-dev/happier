/**
 * Adaptive streaming text pacer: converts bursty upstream text deltas into a
 * steady character reveal so streamed transcript text reads as continuous
 * typing instead of chunk jumps.
 *
 * Algorithm adapted from lobe-ui's useSmoothStreamContent (MIT), with local
 * pacing adjustments and the hold-back-reserve refinement observed in the
 * Codex desktop renderer: while input is actively arriving the reveal cursor
 * deliberately trails the arrived tail by a small adaptive buffer, so jitter
 * in delta arrival never reaches the screen; when input stops the remaining
 * backlog drains within a bounded settle window.
 *
 * This module is pure state + math (caller supplies all timestamps) so the
 * pacing contract is unit-testable without timers or animation frames.
 */

export type StreamingTextPacerConfig = Readonly<{
    /** A target update within this window means upstream is actively streaming. */
    activeInputWindowMs: number;
    /** Rate floor applied at the very edge of the hold-back reserve. */
    brakeMinFactor: number;
    /**
     * Glide window (chars) approaching the hold-back reserve: within it the
     * reveal rate scales down proportionally so the cursor eases into the
     * reserve instead of trickling at full frame-rate and halting abruptly.
     */
    brakeWindowChars: number;
    /** Seed for the reveal-rate EMA before any arrival has been measured (chars/s). */
    defaultCps: number;
    /** EMA smoothing factor for the measured arrival rate. */
    emaAlpha: number;
    /** Minimum drain rate once upstream has gone quiet (chars/s). */
    flushCps: number;
    /** A single append larger than this is shown immediately instead of paced. */
    largeAppendChars: number;
    /** Reveal-rate ceiling while input is active without backlog pressure (chars/s). */
    maxActiveCps: number;
    /** Ceiling for the smoothed base reveal rate (chars/s). */
    maxCps: number;
    /** Absolute reveal-rate ceiling, used for catch-up and drains (chars/s). */
    maxFlushCps: number;
    /** Floor for the reveal rate so progress never visually stalls (chars/s). */
    minCps: number;
    /** Quiet time after the last update before the settle drain engages. */
    settleAfterMs: number;
    /** Upper bound for draining the remaining backlog after upstream stops. */
    settleDrainMaxMs: number;
    /** Lower bound for the settle drain so the tail never snaps. */
    settleDrainMinMs: number;
    /** How far (in time) the reveal cursor trails the arrived tail while active. */
    targetBufferMs: number;
    /**
     * Reveals extend to the next word boundary (bounded by this many chars) so
     * every committed segment is a whole word — partial-word commits re-shape
     * kerning mid-word and make the web word-fade animate half words.
     */
    wordSnapMaxChars: number;
}>;

export const STREAMING_TEXT_PACER_CONFIG: StreamingTextPacerConfig = {
    activeInputWindowMs: 380,
    brakeMinFactor: 0.15,
    brakeWindowChars: 24,
    defaultCps: 26,
    emaAlpha: 0.12,
    flushCps: 64,
    largeAppendChars: 160,
    maxActiveCps: 56,
    maxCps: 44,
    maxFlushCps: 96,
    minCps: 12,
    settleAfterMs: 520,
    settleDrainMaxMs: 900,
    settleDrainMinMs: 300,
    targetBufferMs: 1000,
    wordSnapMaxChars: 24,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

// Don't park the reveal cursor on a markdown marker char — the literal symbol
// would hang on screen until the closing token is revealed.
const MAX_MARKER_LOOKAHEAD = 16;

function isMarkdownMarkerChar(char: string): boolean {
    switch (char.charCodeAt(0)) {
        case 0x21: // !
        case 0x24: // $
        case 0x28: // (
        case 0x29: // )
        case 0x2a: // *
        case 0x3c: // <
        case 0x3e: // >
        case 0x5b: // [
        case 0x5c: // \
        case 0x5d: // ]
        case 0x5f: // _
        case 0x60: // `
        case 0x7c: // |
        case 0x7e: // ~
            return true;
        default:
            return false;
    }
}

export type StreamingTextPacerTickResult = Readonly<{
    /** Whether the displayed text changed during this tick. */
    changed: boolean;
    /** Whether the reveal cursor has caught up with the arrived target. */
    drained: boolean;
    /**
     * When non-null, no reveal is currently allowed (the hold-back buffer is
     * satisfied); the caller may sleep this long instead of ticking frames.
     */
    wakeDelayMs: number | null;
}>;

export type StreamingTextPacer = Readonly<{
    /** Feed the latest upstream target text. Non-append or oversized deltas jump. */
    setTarget: (text: string, nowMs: number) => void;
    /** Advance the reveal cursor for one frame. */
    tick: (nowMs: number) => StreamingTextPacerTickResult;
    /** Immediately reveal everything (visibility loss, teardown, opt-out). */
    flush: () => void;
    getDisplayText: () => string;
    getTargetText: () => string;
    isDrained: () => boolean;
}>;

export function createStreamingTextPacer(params: Readonly<{
    initialText: string;
    nowMs: number;
    config?: StreamingTextPacerConfig;
}>): StreamingTextPacer {
    const config = params.config ?? STREAMING_TEXT_PACER_CONFIG;

    // Codepoint arrays keep the cursor from splitting surrogate pairs.
    let targetText = params.initialText;
    let targetChars: string[] = [...params.initialText];
    let targetCount = targetChars.length;

    let displayText = params.initialText;
    let displayedCount = targetCount;

    let emaCps = config.defaultCps;
    let chunkSizeEma = 1;
    let arrivalCpsEma = config.defaultCps;
    let lastInputAtMs = params.nowMs;
    let lastInputCount = targetCount;
    let lastTickAtMs: number | null = null;
    let settleDeadlineAtMs: number | null = null;
    // Fractional reveal budget carried across frames so braked sub-char-per-frame
    // rates still make steady progress instead of being floored away.
    let revealCarry = 0;

    const jumpToTarget = (nextText: string, nowMs: number): void => {
        targetText = nextText;
        targetChars = [...nextText];
        targetCount = targetChars.length;
        displayText = nextText;
        displayedCount = targetCount;
        lastInputCount = targetCount;
        lastInputAtMs = nowMs;
        emaCps = config.defaultCps;
        chunkSizeEma = 1;
        arrivalCpsEma = config.defaultCps;
        lastTickAtMs = null;
        settleDeadlineAtMs = null;
        revealCarry = 0;
    };

    const setTarget = (text: string, nowMs: number): void => {
        if (text === targetText) return;
        settleDeadlineAtMs = null;

        if (!text.startsWith(targetText)) {
            // Non-monotonic update (rewrite, truncation, restart): jump without
            // animating a diff that would replay already-read text.
            jumpToTarget(text, nowMs);
            return;
        }

        const appendedChars = [...text.slice(targetText.length)];
        const appendedCount = appendedChars.length;
        if (appendedCount > config.largeAppendChars) {
            // Paste-sized delta (resume replay, provider flush): pacing it would
            // queue seconds of backlog, so show it immediately.
            jumpToTarget(text, nowMs);
            return;
        }

        targetText = text;
        targetChars.push(...appendedChars);
        targetCount += appendedCount;

        const deltaChars = targetCount - lastInputCount;
        const deltaMs = Math.max(1, nowMs - lastInputAtMs);
        if (deltaChars > 0) {
            const instantCps = (deltaChars * 1000) / deltaMs;
            const chunkEmaAlpha = 0.35;
            chunkSizeEma = chunkSizeEma * (1 - chunkEmaAlpha) + appendedCount * chunkEmaAlpha;
            arrivalCpsEma =
                arrivalCpsEma * (1 - chunkEmaAlpha) +
                clamp(instantCps, config.minCps, config.maxFlushCps * 2) * chunkEmaAlpha;
            emaCps =
                emaCps * (1 - config.emaAlpha) +
                clamp(instantCps, config.minCps, config.maxActiveCps) * config.emaAlpha;
        }
        lastInputAtMs = nowMs;
        lastInputCount = targetCount;
    };

    const tick = (nowMs: number): StreamingTextPacerTickResult => {
        const backlog = targetCount - displayedCount;
        if (backlog <= 0) {
            lastTickAtMs = nowMs;
            return { changed: false, drained: true, wakeDelayMs: null };
        }

        const frameIntervalMs = lastTickAtMs == null ? 16 : Math.max(0, nowMs - lastTickAtMs);
        lastTickAtMs = nowMs;
        const dtSeconds = Math.max(0.001, Math.min(frameIntervalMs / 1000, 0.05));

        const idleMs = nowMs - lastInputAtMs;
        const inputActive = idleMs <= config.activeInputWindowMs;
        const settling = !inputActive && idleMs >= config.settleAfterMs;

        const baseCps = clamp(emaCps, config.minCps, config.maxCps);
        const baseLagChars = Math.max(1, Math.round((baseCps * config.targetBufferMs) / 1000));
        const lagUpperBound = Math.max(baseLagChars + 2, baseLagChars * 3);
        const targetLagChars = inputActive
            ? Math.round(clamp(baseLagChars + chunkSizeEma * 0.35, baseLagChars, lagUpperBound))
            : 0;

        let currentCps: number;
        if (inputActive) {
            const backlogPressure = targetLagChars > 0 ? backlog / targetLagChars : 1;
            const chunkPressure = targetLagChars > 0 ? chunkSizeEma / targetLagChars : 1;
            const arrivalPressure = arrivalCpsEma / Math.max(baseCps, 1);
            const combinedPressure = clamp(
                backlogPressure * 0.6 + chunkPressure * 0.25 + arrivalPressure * 0.15,
                1,
                4.5,
            );
            const activeCap = clamp(
                config.maxActiveCps + chunkSizeEma * 6,
                config.maxActiveCps,
                config.maxFlushCps,
            );
            currentCps = clamp(baseCps * combinedPressure, config.minCps, activeCap);
            // Deadline guard: sustained arrivals faster than the paced ceiling
            // must not grow the backlog without bound — keep the trail bounded
            // to roughly the target buffer window.
            if (backlog > config.largeAppendChars * 2) {
                currentCps = Math.max(currentCps, (backlog * 1000) / config.targetBufferMs);
            }
        } else if (settling) {
            // Upstream likely finished: the remaining tail must fully drain by a
            // deadline fixed when settling began, however large the backlog — a
            // bounded finish is the contract, so this rate is deliberately
            // uncapped and rises as the deadline approaches.
            if (settleDeadlineAtMs == null) {
                settleDeadlineAtMs =
                    nowMs + clamp(backlog * 8, config.settleDrainMinMs, config.settleDrainMaxMs);
            }
            const remainingMs = Math.max(1, settleDeadlineAtMs - nowMs);
            currentCps = Math.max((backlog * 1000) / remainingMs, config.flushCps);
        } else {
            const idleFlushCps = Math.max(config.flushCps, baseCps * 1.8, arrivalCpsEma * 0.8);
            currentCps = clamp(idleFlushCps, config.flushCps, config.maxFlushCps);
        }

        const urgentBacklog = inputActive && targetLagChars > 0 && backlog > targetLagChars * 2.2;
        const burstyInput = inputActive && chunkSizeEma >= targetLagChars * 0.9;
        let revealChars: number;

        if (inputActive) {
            const desiredDisplayed = Math.max(0, targetCount - targetLagChars);
            const shortfall = desiredDisplayed - displayedCount;
            if (shortfall <= 0) {
                // Hold-back buffer satisfied: nothing to reveal until either new
                // input arrives or the active window lapses into a drain.
                revealCarry = 0;
                return {
                    changed: false,
                    drained: false,
                    wakeDelayMs: Math.max(1, Math.ceil(config.activeInputWindowMs - idleMs)),
                };
            }
            // Proportional brake: ease into the hold-back reserve instead of
            // trickling at full frame cadence and stopping dead at the wall.
            const brake = clamp(shortfall / Math.max(1, config.brakeWindowChars), config.brakeMinFactor, 1);
            const minRevealChars = urgentBacklog || burstyInput ? 2 : 0;
            const revealBudget = currentCps * brake * dtSeconds + revealCarry;
            revealChars = Math.max(minRevealChars, Math.floor(revealBudget));
            revealCarry = clamp(revealBudget - Math.floor(revealBudget), 0, 3);
            if (revealChars <= 0) {
                return { changed: false, drained: false, wakeDelayMs: null };
            }
            revealChars = Math.min(revealChars, shortfall, backlog);
        } else {
            revealChars = Math.min(Math.max(2, Math.round(currentCps * dtSeconds)), backlog);
        }

        let nextCount = displayedCount + revealChars;
        // Word snap: extend the reveal to the next word boundary so every commit
        // is a whole word (bounded so a pathological token cannot run away).
        let wordLookahead = 0;
        while (
            nextCount < targetCount &&
            wordLookahead < config.wordSnapMaxChars &&
            !/\s/.test(targetChars[nextCount] ?? ' ')
        ) {
            nextCount += 1;
            wordLookahead += 1;
        }
        let lookahead = 0;
        while (
            nextCount < targetCount &&
            lookahead < MAX_MARKER_LOOKAHEAD &&
            isMarkdownMarkerChar(targetChars[nextCount - 1] ?? '')
        ) {
            nextCount += 1;
            lookahead += 1;
        }

        const segment = targetChars.slice(displayedCount, nextCount).join('');
        if (segment.length > 0) {
            displayText += segment;
            displayedCount = nextCount;
        } else {
            displayText = targetText;
            displayedCount = targetCount;
        }

        return { changed: true, drained: displayedCount >= targetCount, wakeDelayMs: null };
    };

    const flush = (): void => {
        displayText = targetText;
        displayedCount = targetCount;
        lastTickAtMs = null;
        settleDeadlineAtMs = null;
        revealCarry = 0;
    };

    return {
        setTarget,
        tick,
        flush,
        getDisplayText: () => displayText,
        getTargetText: () => targetText,
        isDrained: () => displayedCount >= targetCount,
    };
}
