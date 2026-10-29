import { logger } from '@/ui/logger';

/**
 * Observe-only turn stall watch for interactive sessions: when a turn is in flight
 * and the provider message stream goes completely silent for longer than the
 * threshold, write exactly one structured file-log notice per silence episode.
 *
 * Deliberately zero recovery actions (no failTurn, no kill, no state change): in a
 * documented incident the provider recovered by itself after 91 minutes, and
 * automatic termination would have destroyed a still-alive turn. This is an
 * observation surface, not a control surface.
 */
export const DEFAULT_TURN_STALL_WARN_MS = 15 * 60_000;
// Node timers overflow above the signed 32-bit delay range on all platforms.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type TurnStallNotice = Readonly<{
    /** Configured silence threshold that this episode exceeded. */
    stallMs: number;
    /** Age of the last provider message event, measured at notice time. */
    lastEventAgeMs: number;
    /** Owning session, so multi-session daemon logs attribute the episode. */
    sessionId?: string;
    /** Session-owned turn id in flight during the silent episode. */
    turnId?: string;
    provider?: string;
    providerTurnId?: string;
}>;

/**
 * Single owner of the HAPPIER_TURN_STALL_WARN_MS contract: default 15 min, `0`
 * disables the watch entirely (no timer is ever installed), and absent or
 * unparsable values fall back to the default.
 */
export function readTurnStallWarnThresholdMs(raw: string | undefined): number {
    const normalized = typeof raw === 'string' ? raw.trim() : '';
    if (normalized === '') return DEFAULT_TURN_STALL_WARN_MS;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TURN_STALL_WARN_MS;
    return Math.trunc(parsed);
}

function logTurnStallNotice(notice: TurnStallNotice): void {
    // File-only by design: agent-session paths must not write to stdout/stderr.
    logger.infoFile('turn stall noticed', notice);
}

export type TurnStallWatch = Readonly<{
    /** A fresh turn began: start a new silence episode. */
    armTurnStallWatch(): void;
    /**
     * Any provider message event arrived: restart the silence window. Also the
     * only way a fired episode re-arms — silence in between must not re-report.
     */
    observeProviderTurnEvent(): void;
    /** The turn reached a terminal state: stop watching entirely. */
    disarmTurnStallWatch(): void;
}>;

export function createTurnStallWatchdog(params: Readonly<{
    stallWarnMs?: number;
    now: () => number;
    describeActiveTurn: () => Readonly<{
        sessionId?: string;
        turnId?: string;
        provider?: string;
        providerTurnId?: string;
    }> | null;
    onStallNotice?: (notice: TurnStallNotice) => void;
}>): TurnStallWatch {
    const stallWarnMs = params.stallWarnMs !== undefined
        ? Math.max(0, Math.trunc(params.stallWarnMs))
        : readTurnStallWarnThresholdMs(process.env.HAPPIER_TURN_STALL_WARN_MS);
    const onStallNotice = params.onStallNotice ?? logTurnStallNotice;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Non-null only while a turn is being watched (armed or already fired);
    // distinguishes "resettable" from "no active turn" without a second flag.
    let lastEventAtMs: number | null = null;

    function clearTimer(): void {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
    }

    function scheduleRemaining(delayMs: number): void {
        timer = setTimeout(() => {
            timer = null;
            const described = params.describeActiveTurn();
            if (!described) return;
            const nowMs = params.now();
            const lastEventAt = lastEventAtMs ?? nowMs;
            const remainingMs = stallWarnMs - (nowMs - lastEventAt);
            if (remainingMs > 0) {
                scheduleRemaining(remainingMs);
                return;
            }
            onStallNotice({
                stallMs: stallWarnMs,
                lastEventAgeMs: Math.max(0, nowMs - lastEventAt),
                ...(described.sessionId ? { sessionId: described.sessionId } : {}),
                ...(described.turnId ? { turnId: described.turnId } : {}),
                ...(described.provider ? { provider: described.provider } : {}),
                ...(described.providerTurnId ? { providerTurnId: described.providerTurnId } : {}),
            });
        }, Math.min(MAX_TIMER_DELAY_MS, delayMs));
        timer.unref?.();
    }

    function schedule(atMs: number): void {
        clearTimer();
        lastEventAtMs = atMs;
        scheduleRemaining(stallWarnMs);
    }

    return {
        armTurnStallWatch() {
            if (stallWarnMs <= 0) return;
            schedule(params.now());
        },
        observeProviderTurnEvent() {
            if (stallWarnMs <= 0 || lastEventAtMs === null) return;
            schedule(params.now());
        },
        disarmTurnStallWatch() {
            clearTimer();
            lastEventAtMs = null;
        },
    };
}
