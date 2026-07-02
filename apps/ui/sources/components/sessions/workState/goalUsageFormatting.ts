export function formatGoalTimeUsed(seconds: number | undefined): string {
    const safeSeconds = Math.max(0, Math.trunc(seconds ?? 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remainingSeconds = safeSeconds % 60;
    if (minutes <= 0) return `${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours <= 0) return `${minutes}m`;
    return `${hours}h ${remainingMinutes}m`;
}
