export type WebHotColdScrollDecision =
    | Readonly<{ kind: 'cold'; index: number }>
    | Readonly<{ kind: 'pin_to_bottom' }>;

export type WebColdListScrollTargetReason =
    | 'jump-to-seq'
    | 'prepend-recovery'
    | 'restore-anchor';

export type WebColdListScrollTarget =
    | Readonly<{
        kind: 'cold';
        index: number;
        fullIndex: number;
        reason: WebColdListScrollTargetReason;
    }>
    | Readonly<{
        kind: 'pin_to_bottom';
        fullIndex: number;
        reason: WebColdListScrollTargetReason;
    }>;

export function resolveWebHotColdScrollDecision(params: Readonly<{ fullIndex: number; coldCount: number }>): WebHotColdScrollDecision {
    const fullIndex = Number.isFinite(params.fullIndex) ? Math.trunc(params.fullIndex) : -1;
    const coldCount = Number.isFinite(params.coldCount) ? Math.max(0, Math.trunc(params.coldCount)) : 0;

    if (coldCount <= 0) return { kind: 'pin_to_bottom' };
    if (fullIndex < 0) return { kind: 'cold', index: 0 };
    if (fullIndex < coldCount) return { kind: 'cold', index: fullIndex };

    // Hot-tail items render in a footer block; scroll to the last cold item to bring
    // the footer into view (and avoid out-of-bounds FlashList indices).
    return { kind: 'cold', index: Math.max(0, coldCount - 1) };
}

/**
 * Native inverted variant of the hot/cold scroll mapping. The command carries a FULL rendered
 * (newest-first) display index, but FlashList `data` is the COLD slice. This maps it to a COLD
 * RENDERED index by mirroring the web discipline: rendered → canonical (oldest-first) → cold
 * decision → cold rendered. A hot-tail target (or a degenerate/empty cold list) resolves to the
 * newest cold rendered row (index 0), which brings the live tail's edge slot into view.
 * Returns null when the inputs are out of range so the caller can keep its original index.
 */
export function resolveNativeInvertedColdScrollIndex(params: Readonly<{
    renderedFullIndex: number;
    fullCount: number;
    coldCount: number;
}>): number | null {
    const fullCount = Number.isFinite(params.fullCount) ? Math.max(0, Math.trunc(params.fullCount)) : 0;
    const coldCount = Number.isFinite(params.coldCount) ? Math.max(0, Math.trunc(params.coldCount)) : 0;
    const renderedFullIndex = Number.isFinite(params.renderedFullIndex) ? Math.trunc(params.renderedFullIndex) : -1;
    if (fullCount <= 0 || coldCount <= 0) return null;
    if (renderedFullIndex < 0 || renderedFullIndex >= fullCount) return null;
    // Inverted index involution: rendered ↔ canonical share `count - 1 - i`.
    const canonicalIndex = fullCount - 1 - renderedFullIndex;
    const decision = resolveWebHotColdScrollDecision({ fullIndex: canonicalIndex, coldCount });
    if (decision.kind !== 'cold') return 0;
    const renderedColdIndex = coldCount - 1 - decision.index;
    if (renderedColdIndex < 0 || renderedColdIndex >= coldCount) return null;
    return renderedColdIndex;
}

export function resolveWebColdListScrollTarget(params: Readonly<{
    fullIndex: number;
    coldCount: number;
    reason: WebColdListScrollTargetReason;
}>): WebColdListScrollTarget {
    const fullIndex = Number.isFinite(params.fullIndex) ? Math.trunc(params.fullIndex) : -1;
    const decision = resolveWebHotColdScrollDecision({
        fullIndex,
        coldCount: params.coldCount,
    });
    return decision.kind === 'cold'
        ? { ...decision, fullIndex, reason: params.reason }
        : { ...decision, fullIndex, reason: params.reason };
}
