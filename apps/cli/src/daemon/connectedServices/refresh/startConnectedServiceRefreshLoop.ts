import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle, type SingleFlightLoopSchedule } from '@/daemon/lifecycle/singleFlightIntervalLoop';

export type ConnectedServiceRefreshLoopHandle = Readonly<{
    stop: () => Promise<void>;
    pause: () => void;
    resume: () => void;
    wake: () => void;
}>;

export function startConnectedServiceRefreshLoop(params: Readonly<{
    enabled: boolean;
    tickMs: number;
    coordinator: Readonly<{ tickOnce: (options?: Readonly<{ signal?: AbortSignal }>) => Promise<void | SingleFlightLoopSchedule> }>;
    subscribeWake?: (listener: () => void) => () => void;
    onTickError: (error: unknown) => void;
    runImmediately?: boolean;
}>): ConnectedServiceRefreshLoopHandle | null {
    if (!params.enabled) {
        return null;
    }

    const loop: SingleFlightIntervalLoopHandle = startSingleFlightIntervalLoop({
        intervalMs: params.tickMs,
        failureBackoffMs: Math.max(params.tickMs, 5_000),
        maxFailureBackoffMs: 60_000,
        task: signal => params.coordinator.tickOnce({ signal }),
        onError: params.onTickError,
        unref: true,
    });
    const unsubscribeWake = params.subscribeWake?.(loop.trigger);

    if (params.runImmediately === true) {
        loop.trigger();
    }

    return {
        stop: async () => { unsubscribeWake?.(); await loop.stop(); },
        pause: () => {
            loop.pause();
        },
        resume: () => {
            loop.trigger();
            loop.resume();
        },
        wake: loop.trigger,
    };
}
