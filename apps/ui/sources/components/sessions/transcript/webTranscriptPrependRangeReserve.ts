export function resolveWebTranscriptPrependRangeReservePx(params: Readonly<{
    baselineScrollHeight: number;
    currentScrollHeight: number;
}>): number {
    const baseline = typeof params.baselineScrollHeight === 'number' && Number.isFinite(params.baselineScrollHeight)
        ? Math.max(0, Math.trunc(params.baselineScrollHeight))
        : 0;
    const current = typeof params.currentScrollHeight === 'number' && Number.isFinite(params.currentScrollHeight)
        ? Math.max(0, Math.trunc(params.currentScrollHeight))
        : 0;
    const reserve = baseline - current;
    return reserve > 1 ? reserve : 0;
}
