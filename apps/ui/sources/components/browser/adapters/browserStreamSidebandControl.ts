import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';

import { mapLiveStreamPointToContent, type LiveStreamInputGesture } from '@/sync/domains/machines/peer/mediation/stream/inputGesture';
import type { BrowserViewerInputEvent } from './BrowserStreamedTarget';

/** Browser's existing input contract carries wheel deltas and key modifiers losslessly. */
export function buildBrowserViewerInput(gesture: LiveStreamInputGesture): BrowserViewerInputEvent | null {
    if (gesture.kind === 'keyboard_key') {
        if (gesture.modifiers?.includes('fn')) return null;
        return { kind: 'key', key: gesture.key, modifiers: [...(gesture.modifiers ?? [])].filter(modifier => modifier !== 'fn') };
    }
    if (gesture.kind === 'pointer') {
        const point = mapLiveStreamPointToContent(gesture);
        return point ? { kind: 'pointer', action: gesture.phase, x: point.x, y: point.y } : null;
    }
    if (gesture.kind === 'wheel') {
        const point = mapLiveStreamPointToContent(gesture);
        return point ? { kind: 'wheel', x: point.x, y: point.y, deltaX: gesture.deltaX, deltaY: gesture.deltaY } : null;
    }
    return null;
}

/** A viewer gesture as the browser source's sideband control, normalized to the drawn page. */
export function buildBrowserStreamSidebandControl(input: Readonly<{
    sourceId: string;
    streamId: string;
    eventId: string;
    gesture: LiveStreamInputGesture;
}>): MachineLiveStreamControlSidebandV1 | null {
    const base = { v: 1 as const, streamId: input.streamId, sourceId: input.sourceId, eventId: input.eventId };
    const gesture = input.gesture;
    switch (gesture.kind) {
        case 'move':
        case 'tap': {
            const point = mapLiveStreamPointToContent(gesture);
            if (!point) return null;
            if (gesture.kind === 'move') return { ...base, kind: 'move', x: point.x, y: point.y };
            return { ...base, kind: 'tap', x: point.x, y: point.y,
                ...(gesture.button ? { button: gesture.button } : {}), ...(gesture.clickCount ? { clickCount: gesture.clickCount } : {}),
                ...(gesture.modifiers?.length ? { modifiers: [...gesture.modifiers] } : {}),
            };
        }
        case 'swipe':
        case 'drag': {
            const from = mapLiveStreamPointToContent({ ...gesture, point: gesture.from });
            const to = mapLiveStreamPointToContent({ ...gesture, point: gesture.to });
            if (!from || !to) return null;
            return { ...base, kind: gesture.kind, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
                ...(gesture.durationMs === undefined ? {} : { durationMs: gesture.durationMs }) };
        }
        case 'wheel': {
            const point = mapLiveStreamPointToContent(gesture);
            return point ? { ...base, kind: 'wheel', x: point.x, y: point.y, deltaX: gesture.deltaX, deltaY: gesture.deltaY } : null;
        }
        case 'keyboard_text':
            return { ...base, kind: 'keyboard_text', text: gesture.text };
        case 'keyboard_key':
            return { ...base, kind: 'keyboard_key', key: gesture.key,
                ...(gesture.modifiers?.length ? { modifiers: [...gesture.modifiers] } : {}) };
        default:
            return null;
    }
}
