import { countTextLinesUpTo } from '@/utils/strings/countTextLinesUpTo';

export function resolveInlineDiffVirtualization(params: Readonly<{
    unifiedDiff: string | null;
    oldText: string | null;
    newText: string | null;
    lineThreshold: number;
    byteThreshold?: number;
}>): boolean {
    const lineThreshold = params.lineThreshold;
    const byteThreshold = params.byteThreshold;

    const hasLineThreshold = Number.isFinite(lineThreshold) && lineThreshold > 0;
    const hasByteThreshold = Number.isFinite(byteThreshold) && (byteThreshold ?? 0) > 0;
    if (!hasLineThreshold && !hasByteThreshold) return false;

    const unified = typeof params.unifiedDiff === 'string' ? params.unifiedDiff : null;
    if (unified) {
        if (hasByteThreshold && unified.length > (byteThreshold as number)) return true;
        if (hasLineThreshold && countTextLinesUpTo(unified, lineThreshold + 1) > lineThreshold) return true;
        return false;
    }

    const oldText = typeof params.oldText === 'string' ? params.oldText : null;
    const newText = typeof params.newText === 'string' ? params.newText : null;
    if (oldText != null && newText != null) {
        if (hasByteThreshold && Math.max(oldText.length, newText.length) > (byteThreshold as number)) return true;
        if (hasLineThreshold && Math.max(
            countTextLinesUpTo(oldText, lineThreshold + 1),
            countTextLinesUpTo(newText, lineThreshold + 1),
        ) > lineThreshold) return true;
        return false;
    }

    return false;
}
