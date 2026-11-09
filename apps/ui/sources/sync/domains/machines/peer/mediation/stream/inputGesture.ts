import type { SimulatorPreviewRectV1 } from '@happier-dev/protocol/devices/simulator/inputV1';
import type { HappierLiveStreamPoint } from '@happier-dev/plugin-ui/presentation';

export type {
    HappierLiveStreamGestureGeometry as LiveStreamGestureGeometry,
    HappierLiveStreamPoint as LiveStreamPoint,
    HappierLiveStreamInputGesture as LiveStreamInputGesture,
} from '@happier-dev/plugin-ui/presentation';

/**
 * A viewport-normalized point (0..1 of the viewer surface) re-expressed in the drawn content rect
 * (0..1 of the picture), or `null` when it falls outside the picture.
 */
export function mapLiveStreamPointToContent(input: Readonly<{
    point: HappierLiveStreamPoint;
    viewport: Readonly<{ width: number; height: number }>;
    content: SimulatorPreviewRectV1;
}>): HappierLiveStreamPoint | null {
    const { viewport, content } = input;
    if (!(viewport.width > 0 && viewport.height > 0 && content.width > 0 && content.height > 0)) return null;
    const x = (input.point.x * viewport.width - content.x) / content.width;
    const y = (input.point.y * viewport.height - content.y) / content.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
}
