import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';

/** Distinct matches on one line are distinct jumps; equivalent decoration refreshes are not. */
export function codeLineScrollTargetKey(lineId: string | undefined, ranges: readonly FindTextRange[] | undefined, requestId?: number): string | null {
    if (!lineId) return null;
    const current = ranges?.find(range => range.current);
    return JSON.stringify([lineId, current?.start ?? null, current?.end ?? null, requestId ?? null]);
}
