export type CompanionPoint = Readonly<{ x: number; y: number }>;
export type CompanionDragBounds = Readonly<{ minX: number; maxX: number; minY: number; maxY: number }>;
export type CompanionDragMotionPolicy = 'animate' | 'snap';

export function clampCompanionPoint(point: CompanionPoint, bounds: CompanionDragBounds): CompanionPoint {
    'worklet';
    return {
        x: Math.min(bounds.maxX, Math.max(bounds.minX, point.x)),
        y: Math.min(bounds.maxY, Math.max(bounds.minY, point.y)),
    };
}

export function pointIntersectsCompanionNoDragRegions(
    point: CompanionPoint,
    regions: readonly Readonly<{ x: number; y: number; width: number; height: number }>[],
): boolean {
    'worklet';
    return regions.some((region) => (
        point.x >= region.x && point.x <= region.x + region.width
        && point.y >= region.y && point.y <= region.y + region.height
    ));
}
