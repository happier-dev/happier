import * as React from 'react';

export type RecordingClock = Readonly<{
    read: () => number;
    write: (timeMs: number) => void;
    subscribe: (listener: (timeMs: number) => void) => () => void;
}>;

/** The playhead's time. Playback and scrubbing write here; only the playhead and the read-out follow it. */
export function createRecordingClock(initialMs: number): RecordingClock {
    let timeMs = initialMs;
    const listeners = new Set<(timeMs: number) => void>();
    return {
        read: () => timeMs,
        write: (next) => {
            if (next === timeMs) return;
            timeMs = next;
            for (const listener of listeners) listener(next);
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

/** Whole seconds: the read-out re-renders once a second however fast the clock runs. */
export function useRecordingClockSeconds(clock: RecordingClock): number {
    const read = () => Math.floor(clock.read() / 1000);
    return React.useSyncExternalStore(clock.subscribe, read, read);
}
