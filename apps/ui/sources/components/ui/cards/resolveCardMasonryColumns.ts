export type CardMasonryEntry = Readonly<{
    key: string;
    weight: number;
}>;

export function resolveCardMasonryColumns(
    entries: readonly CardMasonryEntry[],
    columnCount: number,
): string[][] {
    const safeColumnCount = Math.max(1, Math.floor(columnCount));
    const columns = Array.from({ length: safeColumnCount }, () => [] as string[]);
    const heights = Array.from({ length: safeColumnCount }, () => 0);

    for (const entry of entries) {
        let targetIndex = 0;

        for (let index = 1; index < safeColumnCount; index += 1) {
            if (heights[index] < heights[targetIndex]) {
                targetIndex = index;
            }
        }

        columns[targetIndex].push(entry.key);
        heights[targetIndex] += Math.max(1, entry.weight);
    }

    return columns;
}
