export type IndexWindow = Readonly<{ startIndex: number; endIndex: number }>;

export function resolveIndexWindow(input: Readonly<{
    viewableIndices: readonly number[];
    aheadCount: number;
    behindCount: number;
    maxIndex: number;
}>): IndexWindow | null {
    const maxIndex = Math.max(0, Math.floor(input.maxIndex));
    if (!Number.isFinite(maxIndex) || maxIndex < 0) return null;

    const indices = Array.isArray(input.viewableIndices) ? input.viewableIndices : [];
    if (indices.length === 0) return null;

    const first = indices[0];
    const last = indices[indices.length - 1];
    if (typeof first !== 'number' || typeof last !== 'number') return null;

    const ahead = Math.max(0, Math.floor(input.aheadCount));
    const behind = Math.max(0, Math.floor(input.behindCount));

    const startIndex = Math.max(0, Math.min(maxIndex, Math.floor(first) - behind));
    const endIndex = Math.max(startIndex, Math.min(maxIndex, Math.floor(last) + ahead));
    return { startIndex, endIndex };
}
