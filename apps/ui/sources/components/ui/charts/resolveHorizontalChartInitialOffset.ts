export function resolveHorizontalChartInitialOffset(input: Readonly<{
    contentWidth: number;
    viewportWidth: number;
}>): number {
    const overflow = Math.max(0, input.contentWidth - input.viewportWidth);
    return overflow > 0 ? overflow : 0;
}
