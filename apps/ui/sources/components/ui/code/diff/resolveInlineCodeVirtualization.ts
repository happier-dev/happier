import { countTextLinesUpTo } from '@/utils/strings/countTextLinesUpTo';

export function resolveInlineCodeVirtualization(params: Readonly<{
    text: string | null;
    lineThreshold: number;
    byteThreshold?: number;
}>): boolean {
    const text = typeof params.text === 'string' ? params.text : null;
    if (!text) return false;

    const lineThreshold = params.lineThreshold;
    const byteThreshold = params.byteThreshold;

    const hasLineThreshold = Number.isFinite(lineThreshold) && lineThreshold > 0;
    const hasByteThreshold = Number.isFinite(byteThreshold) && (byteThreshold ?? 0) > 0;
    if (!hasLineThreshold && !hasByteThreshold) return false;

    if (hasByteThreshold && text.length > (byteThreshold as number)) return true;
    if (hasLineThreshold && countTextLinesUpTo(text, lineThreshold + 1) > lineThreshold) return true;
    return false;
}
