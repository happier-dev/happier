export type HappierLiveStreamOrientation = 'portrait' | 'portraitUpsideDown' | 'landscapeLeft' | 'landscapeRight';
export type HappierLiveStreamRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type HappierLiveStreamInputControlKind = HappierLiveStreamInputGesture['kind'];

export type HappierLiveStreamGestureGeometry = Readonly<{
    orientation: HappierLiveStreamOrientation;
    viewport: Readonly<{ width: number; height: number }>;
    content: HappierLiveStreamRect;
}>;

export type HappierLiveStreamPoint = Readonly<{ x: number; y: number }>;
/** Platform gesture conventions shared by stream, document and editor input owners. */
export const HAPPIER_GESTURE_TIMING = {slopPx: 12, doubleTapMs: 300, longPressMs: 500} as const;
export type HappierLiveStreamKeyModifier = 'alt' | 'control' | 'meta' | 'shift' | 'fn';
export type HappierLiveStreamInputMode = 'direct' | 'trackpad';
/** Local picture transform in viewport pixels; it never changes the remote viewport. */
export type HappierLiveStreamViewTransform = Readonly<{ scale: number; x: number; y: number }>;

export type HappierLiveStreamInputGesture =
    | (Readonly<{ kind: 'tap'; point: HappierLiveStreamPoint; button?: 'left' | 'right'; clickCount?: 2; modifiers?: readonly HappierLiveStreamKeyModifier[] }> & HappierLiveStreamGestureGeometry)
    | (Readonly<{ kind: 'move'; point: HappierLiveStreamPoint }> & HappierLiveStreamGestureGeometry)
    | (Readonly<{ kind: 'pointer'; phase: 'down' | 'move' | 'up' | 'cancel'; point: HappierLiveStreamPoint }> & HappierLiveStreamGestureGeometry)
    | (Readonly<{ kind: 'long_press'; point: HappierLiveStreamPoint; durationMs?: number }> & HappierLiveStreamGestureGeometry)
    | (Readonly<{ kind: 'swipe' | 'drag'; from: HappierLiveStreamPoint; to: HappierLiveStreamPoint; durationMs?: number }> & HappierLiveStreamGestureGeometry)
    | (Readonly<{ kind: 'wheel'; point: HappierLiveStreamPoint; deltaX: number; deltaY: number }> & HappierLiveStreamGestureGeometry)
    | (Readonly<{
        kind: 'pinch';
        center: HappierLiveStreamPoint;
        startDistance: number;
        endDistance: number;
        angle?: number;
        durationMs?: number;
    }> & HappierLiveStreamGestureGeometry)
    | (Readonly<{
        kind: 'rotate';
        center: HappierLiveStreamPoint;
        radius: number;
        startAngle: number;
        endAngle: number;
        durationMs?: number;
    }> & HappierLiveStreamGestureGeometry)
    | Readonly<{ kind: 'keyboard_text'; text: string }>
    | Readonly<{ kind: 'keyboard_key'; key: string; modifiers?: readonly HappierLiveStreamKeyModifier[] }>;
