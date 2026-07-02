export function readRollbackEligibleTurnStarts(value: unknown): readonly number[] | null | undefined {
    if (value === null) return null;
    if (!Array.isArray(value)) return undefined;

    const starts: number[] = [];
    for (const entry of value) {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) continue;
        const seq = Math.trunc(entry);
        if (seq < 0 || starts.includes(seq)) continue;
        starts.push(seq);
    }
    return starts;
}
