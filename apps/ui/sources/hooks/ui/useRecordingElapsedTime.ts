import type { NativeRecordingTiming } from '@/desktop/capture/nativeCapture';
import { useElapsedTime } from './useElapsedTime';

/** Mount in the elapsed leaf; native timing changes only on recording lifecycle transitions. */
export function useRecordingElapsedTime(timing: NativeRecordingTiming | null | undefined, visible = true): number {
    const anchor = timing && timing.activeSinceMs !== null ? timing.activeSinceMs - timing.durationMs : null;
    const elapsed = useElapsedTime(anchor, anchor !== null && visible);
    return anchor !== null ? elapsed : Math.floor((timing?.durationMs ?? 0) / 1000);
}
