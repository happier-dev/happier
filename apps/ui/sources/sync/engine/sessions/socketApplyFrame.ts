import { isHostVisible } from '@/utils/runtime/isRuntimeActive';

/**
 * One 60 Hz frame. It is also the default transcript coalescing window, so the default window
 * means "apply at the next frame".
 */
const FRAME_INTERVAL_MS = 16;

type FrameTask = () => void;

type ScheduledTask = {
    readonly task: FrameTask;
    cancelled: boolean;
    windowTimer: ReturnType<typeof setTimeout> | null;
};

export type SocketApplyFrameScheduler = Readonly<{
    /**
     * Runs `task` once at the first frame that starts after `windowMs`; a window of one frame or
     * less means the next frame. Returns a cancel function.
     */
    schedule: (task: FrameTask, windowMs: number) => () => void;
    /** Runs every scheduled task now, in scheduling order, for boundaries that cannot wait. */
    flushNow: () => void;
}>;

/**
 * Owns the cadence at which socket-ingested Session and transcript updates reach the store.
 *
 * Every socket apply coalescer schedules its flush here, so all updates that arrive within one
 * frame are published from one task: the store is written once per coalescer, and React renders
 * once for that frame instead of once per arrival. A host that is not painting (a hidden tab, or a
 * platform without a frame source) gets no frames, so its flushes run on a one-frame timer
 * instead and data still reaches non-visual consumers.
 */
export function createSocketApplyFrameScheduler(deps: Readonly<{
    requestFrame: () => ((callback: () => void) => void) | null;
    isPainting: () => boolean;
}>): SocketApplyFrameScheduler {
    const scheduled: ScheduledTask[] = [];
    let frameRequested = false;

    function runDueTasks(includeWindowed: boolean): void {
        const due: ScheduledTask[] = [];
        for (let i = 0; i < scheduled.length;) {
            const entry = scheduled[i]!;
            if (entry.windowTimer !== null && !includeWindowed) {
                i += 1;
                continue;
            }
            if (entry.windowTimer !== null) {
                clearTimeout(entry.windowTimer);
                entry.windowTimer = null;
            }
            scheduled.splice(i, 1);
            due.push(entry);
        }
        let firstError: unknown = null;
        for (const entry of due) {
            if (entry.cancelled) continue;
            entry.cancelled = true;
            try {
                entry.task();
            } catch (error) {
                // Run every other due task before surfacing the failure: a dropped flush loses data.
                firstError ??= error;
            }
        }
        if (firstError !== null) throw firstError;
    }

    function onFrame(): void {
        frameRequested = false;
        runDueTasks(false);
    }

    function requestFrame(): void {
        if (frameRequested) return;
        frameRequested = true;
        const frame = deps.isPainting() ? deps.requestFrame() : null;
        if (frame) {
            frame(onFrame);
        } else {
            setTimeout(onFrame, FRAME_INTERVAL_MS);
        }
    }

    function schedule(task: FrameTask, windowMs: number): () => void {
        const entry: ScheduledTask = { task, cancelled: false, windowTimer: null };
        scheduled.push(entry);
        const holdMs = Math.trunc(windowMs) - FRAME_INTERVAL_MS;
        if (holdMs > 0) {
            entry.windowTimer = setTimeout(() => {
                entry.windowTimer = null;
                requestFrame();
            }, holdMs);
        } else {
            requestFrame();
        }
        return () => {
            entry.cancelled = true;
            if (entry.windowTimer !== null) {
                clearTimeout(entry.windowTimer);
                entry.windowTimer = null;
            }
            const index = scheduled.indexOf(entry);
            if (index >= 0) scheduled.splice(index, 1);
        };
    }

    return {
        schedule,
        flushNow: () => {
            try {
                runDueTasks(true);
            } finally {
                // Nothing is left for the outstanding frame: let the next schedule request its own.
                if (scheduled.length === 0) frameRequested = false;
            }
        },
    };
}

function readRequestAnimationFrame(): ((callback: () => void) => void) | null {
    const raf = (globalThis as { requestAnimationFrame?: (callback: () => void) => unknown }).requestAnimationFrame;
    return typeof raf === 'function' ? (callback) => { raf.call(globalThis, callback); } : null;
}

export const socketApplyFrame = createSocketApplyFrameScheduler({
    requestFrame: readRequestAnimationFrame,
    isPainting: isHostVisible,
});
