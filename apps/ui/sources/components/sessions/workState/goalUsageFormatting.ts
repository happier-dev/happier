/**
 * Formats elapsed goal time for the compact active-goal readout. Seconds are kept at the
 * sub-hour scale (e.g. `3m 10s`, `45s`) so the inline metadata line reads like a live timer;
 * at the hour scale seconds are dropped for brevity (`2h 5m`). Exact zero-second minutes render
 * without the trailing `0s` (`2m`, not `2m 0s`).
 */
export function formatGoalTimeUsed(seconds: number | undefined): string {
    const safeSeconds = Math.max(0, Math.trunc(seconds ?? 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remainingSeconds = safeSeconds % 60;
    if (minutes <= 0) return `${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours <= 0) {
        return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
    return `${hours}h ${remainingMinutes}m`;
}
