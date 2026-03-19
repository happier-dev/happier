export type WebHotColdScrollDecision =
    | Readonly<{ kind: 'cold'; index: number }>
    | Readonly<{ kind: 'pin_to_bottom' }>;

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
