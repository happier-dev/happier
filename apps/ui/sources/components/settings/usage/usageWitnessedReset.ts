/**
 * The one moment the kit celebrates (lab `kitmotion` reset): a window the viewer had used up is read
 * again, in a later cycle, with room in it — while they were looking. It compares two consecutive
 * admitted readings of the same window and decides nothing about quota itself.
 */
export type UsageWindowReading = Readonly<{
    /** The window's own identity (account and meter). */
    key: string;
    resetAtMs: number | null;
    /** 0–1 still available; null when the provider reported no comparable value. */
    remainingFraction: number | null;
}>;

/** Windows used up in `previous` that `next` shows in a later cycle with room again. A first read witnesses nothing. */
export function detectWitnessedResets(
    previous: readonly UsageWindowReading[] | null,
    next: readonly UsageWindowReading[],
): readonly UsageWindowReading[] {
    if (!previous) return [];
    const before = new Map(previous.map((entry) => [entry.key, entry]));
    return next.filter((entry) => {
        const was = before.get(entry.key);
        return was !== undefined
            && was.remainingFraction !== null && was.remainingFraction <= 0
            && was.resetAtMs !== null && entry.resetAtMs !== null && entry.resetAtMs > was.resetAtMs
            && entry.remainingFraction !== null && entry.remainingFraction > 0;
    });
}

/**
 * Remembers the last reading seen while the app was being looked at. A reading taken while hidden
 * clears it, so returning to the app is a first read: a reset nobody watched is not replayed.
 * Each reset is reported once, however many bodies or renders observe it.
 */
export function createWitnessedResetWatch() {
    let previous: readonly UsageWindowReading[] | null = null;
    const reported = new Set<string>();
    return {
        observe(next: readonly UsageWindowReading[], viewed: boolean): readonly UsageWindowReading[] {
            if (!viewed) {
                previous = null;
                return [];
            }
            const witnessed = detectWitnessedResets(previous, next).filter((entry) => {
                const id = `${entry.key}\u0000${entry.resetAtMs}`;
                if (reported.has(id)) return false;
                reported.add(id);
                return true;
            });
            previous = next;
            return witnessed;
        },
    };
}

/** One watch for the app session: every mounted Capacity body shares what was already celebrated. */
export const usageWitnessedResetWatch = createWitnessedResetWatch();
