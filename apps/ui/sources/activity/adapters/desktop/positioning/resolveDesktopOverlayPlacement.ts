import type { DesktopOverlayAnchor } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';

export type DesktopOverlayRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

export type DesktopOverlaySize = Readonly<{
    width: number;
    height: number;
}>;

export type DesktopOverlayMonitorBounds = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function resolveAnchorOrigin(
    monitor: DesktopOverlayMonitorBounds,
    overlaySize: DesktopOverlaySize,
    anchor: DesktopOverlayAnchor,
    padding: number,
): Readonly<{ x: number; y: number }> {
    const centerX = monitor.x + (monitor.width - overlaySize.width) / 2;
    const centerY = monitor.y + (monitor.height - overlaySize.height) / 2;

    switch (anchor) {
        case 'top_left':
            return { x: monitor.x + padding, y: monitor.y + padding };
        case 'top_right':
            return { x: monitor.x + monitor.width - overlaySize.width - padding, y: monitor.y + padding };
        case 'top_center':
            return { x: centerX, y: monitor.y + padding };
        case 'bottom_left':
            return { x: monitor.x + padding, y: monitor.y + monitor.height - overlaySize.height - padding };
        case 'bottom_center':
            return { x: centerX, y: monitor.y + monitor.height - overlaySize.height - padding };
        case 'bottom_right':
            return { x: monitor.x + monitor.width - overlaySize.width - padding, y: monitor.y + monitor.height - overlaySize.height - padding };
        case 'left_center':
            return { x: monitor.x + padding, y: centerY };
        case 'right_center':
            return { x: monitor.x + monitor.width - overlaySize.width - padding, y: centerY };
        default:
            return { x: centerX, y: monitor.y + padding };
    }
}

export function resolveDesktopOverlayPlacement(params: Readonly<{
    monitor: DesktopOverlayMonitorBounds;
    overlaySize: DesktopOverlaySize;
    anchor: DesktopOverlayAnchor;
    offsetX: number;
    offsetY: number;
    padding?: number;
}>): DesktopOverlayRect {
    const padding = typeof params.padding === 'number' && Number.isFinite(params.padding) ? Math.max(0, params.padding) : 12;
    const width = Math.max(1, params.overlaySize.width);
    const height = Math.max(1, params.overlaySize.height);

    const origin = resolveAnchorOrigin(
        params.monitor,
        { width, height },
        params.anchor,
        padding,
    );

    const rawX = origin.x + params.offsetX;
    const rawY = origin.y + params.offsetY;

    const minX = params.monitor.x + padding;
    const minY = params.monitor.y + padding;
    const maxX = params.monitor.x + params.monitor.width - width - padding;
    const maxY = params.monitor.y + params.monitor.height - height - padding;

    return {
        x: Math.round(clamp(rawX, minX, Math.max(minX, maxX))),
        y: Math.round(clamp(rawY, minY, Math.max(minY, maxY))),
        width: Math.round(width),
        height: Math.round(height),
    };
}
