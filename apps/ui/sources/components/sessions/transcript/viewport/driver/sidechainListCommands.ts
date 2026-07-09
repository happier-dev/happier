export type SidechainListCommandRef = Readonly<{
    scrollToIndex?: (params: Readonly<{
        animated: boolean;
        index: number;
        viewPosition: number;
    }>) => unknown;
    scrollToOffset?: (params: Readonly<{
        animated: boolean;
        offset: number;
    }>) => unknown;
}>;

export function performSidechainIndexCommand(params: Readonly<{
    animated: boolean;
    estimatedItemSizePx: number;
    listRef: SidechainListCommandRef | null | undefined;
    targetIndex: number;
    viewPosition: number;
}>): boolean {
    const targetIndex = normalizeTargetIndex(params.targetIndex);
    if (targetIndex == null) return false;
    const listRef = params.listRef;
    if (!listRef || typeof listRef.scrollToIndex !== 'function') return false;

    try {
        const result = listRef.scrollToIndex({
            index: targetIndex,
            animated: params.animated,
            viewPosition: params.viewPosition,
        });
        if (isRejectable(result)) {
            result.catch(() => {
                applySidechainIndexCommandFallback({
                    animated: params.animated,
                    estimatedItemSizePx: params.estimatedItemSizePx,
                    listRef,
                    targetIndex,
                });
            });
        }
        return true;
    } catch {
        return false;
    }
}

function applySidechainIndexCommandFallback(params: Readonly<{
    animated: boolean;
    estimatedItemSizePx: number;
    listRef: SidechainListCommandRef;
    targetIndex: number;
}>): void {
    try {
        params.listRef.scrollToOffset?.({
            offset: Math.max(0, Math.trunc(normalizeEstimatedItemSize(params.estimatedItemSizePx) * params.targetIndex)),
            animated: params.animated,
        });
    } catch {
        // Best-effort only.
    }
}

function normalizeTargetIndex(value: number): number | null {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.trunc(value);
}

function normalizeEstimatedItemSize(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value;
}

type Rejectable = Readonly<{ catch: (onRejected: () => void) => unknown }>;

function isRejectable(value: unknown): value is Rejectable {
    return !!value && typeof value === 'object' && typeof (value as Partial<Rejectable>).catch === 'function';
}
