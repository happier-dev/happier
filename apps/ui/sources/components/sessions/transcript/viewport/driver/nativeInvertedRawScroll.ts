export type NativeInvertedScrollGeometry = Readonly<{
    contentHeight: number;
    layoutHeight: number;
}>;

function resolveScrollableExtent(geometry: NativeInvertedScrollGeometry): number {
    return Math.max(0, geometry.contentHeight - geometry.layoutHeight);
}

export function toNativeInvertedCanonicalOffset(
    params: NativeInvertedScrollGeometry & Readonly<{ rawOffsetY: number }>,
): number {
    return resolveScrollableExtent(params) - params.rawOffsetY;
}

export function fromNativeInvertedCanonicalOffset(
    params: NativeInvertedScrollGeometry & Readonly<{ canonicalOffsetY: number }>,
): number {
    return resolveScrollableExtent(params) - params.canonicalOffsetY;
}

export function resolveNativeInvertedBottomRawOffset(): number {
    return 0;
}

export function resolveNativeInvertedBottomCommandOffset(): number {
    return 0;
}
