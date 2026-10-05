export type TranscriptFindRulerTick = Readonly<{ key: string; top: number; current: boolean }>;

/**
 * Maps the Find model's matched messages onto the scroll track (Find lab F1 `.fd-ruler`).
 *
 * Positions come from the list's own layout (`getLayout`: measured rows, estimated for rows it has
 * not mounted), so no row is mounted to place a mark. Marks that land on the same track pixel are
 * one mark; the current match wins that pixel.
 */
export function resolveTranscriptFindRulerTicks(input: Readonly<{
    messageIds: readonly string[];
    currentMessageId: string | null;
    contentHeight: number;
    trackHeight: number;
    measure: (messageId: string) => Readonly<{ y: number; height: number }> | null;
}>): readonly TranscriptFindRulerTick[] {
    if (!(input.contentHeight > 0) || !(input.trackHeight > 0)) return [];
    const byPixel = new Map<number, TranscriptFindRulerTick>();
    for (const messageId of input.messageIds) {
        const layout = input.measure(messageId);
        if (!layout || !Number.isFinite(layout.y)) continue;
        const ratio = Math.min(1, Math.max(0, layout.y / input.contentHeight));
        const top = Math.round(ratio * input.trackHeight);
        const current = messageId === input.currentMessageId;
        if (!byPixel.has(top) || current) byPixel.set(top, { key: messageId, top, current });
    }
    return [...byPixel.values()].sort((a, b) => a.top - b.top);
}
