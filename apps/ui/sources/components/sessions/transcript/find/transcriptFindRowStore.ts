import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
export type TranscriptFindSourceRange = FindTextRange;
export type TranscriptFindRowSnapshot = Readonly<{
    blocks: readonly Readonly<{ id: string; sourceRanges: readonly TranscriptFindSourceRange[] }>[];
    reveal?: Readonly<{ blockId: string; requestId: number }>;
}>;

export type TranscriptFindRowStore = ReturnType<typeof createTranscriptFindRowStore>;

function equalRow(a: TranscriptFindRowSnapshot | undefined, b: TranscriptFindRowSnapshot | undefined): boolean {
    if (a === b) return true;
    if (!a || !b || a.blocks.length !== b.blocks.length) return false;
    if (a.reveal?.blockId !== b.reveal?.blockId || a.reveal?.requestId !== b.reveal?.requestId) return false;
    return a.blocks.every((block, index) => {
        const next = b.blocks[index];
        return next !== undefined && block.id === next.id && block.sourceRanges.length === next.sourceRanges.length
            && block.sourceRanges.every((range, i) => {
                const other = next.sourceRanges[i];
                return other !== undefined && range.start === other.start && range.end === other.end && range.current === other.current;
            });
    });
}

/** Ephemeral per-surface publication; only changed message subscribers are notified. */
export function createTranscriptFindRowStore() {
    let rows = new Map<string, TranscriptFindRowSnapshot>();
    const listeners = new Map<string, Set<() => void>>();
    const publish = (next: ReadonlyMap<string, TranscriptFindRowSnapshot>) => {
        const changed: string[] = [];
        const reconciled = new Map<string, TranscriptFindRowSnapshot>();
        for (const [id, row] of next) {
            const previous = rows.get(id);
            if (equalRow(previous, row)) reconciled.set(id, previous!);
            else { reconciled.set(id, row); changed.push(id); }
        }
        for (const id of rows.keys()) if (!next.has(id)) changed.push(id);
        rows = reconciled;
        for (const id of changed) for (const listener of listeners.get(id) ?? []) listener();
    };
    return {
        getSnapshot: (messageId: string): TranscriptFindRowSnapshot | null => rows.get(messageId) ?? null,
        subscribe: (messageId: string, listener: () => void) => {
            const set = listeners.get(messageId) ?? new Set<() => void>();
            set.add(listener); listeners.set(messageId, set);
            return () => { set.delete(listener); if (set.size === 0) listeners.delete(messageId); };
        },
        publish,
        clear: () => publish(new Map()),
    };
}
