export function resolveDevicePetGridColumns(width: number, tileCount: number): number {
    if (tileCount <= 1) return 1;
    if (width >= 860) return Math.min(tileCount, 6);
    if (width >= 700) return Math.min(tileCount, 5);
    if (width >= 560) return Math.min(tileCount, 4);
    if (width >= 420) return Math.min(tileCount, 3);
    if (width >= 300) return Math.min(tileCount, 2);
    return 1;
}
