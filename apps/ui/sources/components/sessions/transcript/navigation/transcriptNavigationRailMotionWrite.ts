import type { TranscriptNavigationRailMarkerMotion } from './resolveTranscriptNavigationRailMotion';

/**
 * Platform handle for a rail marker line. On native this is a host component
 * instance exposing `setNativeProps`; on react-native-web the ref is the DOM
 * element itself, whose inline `style` object accepts direct writes.
 */
export type TranscriptNavigationRailMarkerLineHandle = Readonly<{
    setNativeProps?: (props: Readonly<{ style?: unknown }>) => void;
    style?: unknown;
}>;

export type TranscriptNavigationRailMotionWriteResult = 'set-native-props' | 'dom' | 'unsupported';

type WritableInlineStyle = {
    opacity?: string | number;
    transform?: string;
    width?: string | number;
};

function resolveWritableInlineStyle(handle: TranscriptNavigationRailMarkerLineHandle): WritableInlineStyle | null {
    const style = handle.style;
    if (!style || typeof style !== 'object') return null;
    return style as WritableInlineStyle;
}

/**
 * Applies a resolved marker motion to a platform handle with explicit,
 * per-platform write paths. Never silently no-ops: callers must check for an
 * `unsupported` result and fall back to React-state-driven rendering.
 */
export function applyTranscriptNavigationRailMarkerMotionWrite(
    handle: TranscriptNavigationRailMarkerLineHandle | null | undefined,
    motion: TranscriptNavigationRailMarkerMotion,
): TranscriptNavigationRailMotionWriteResult {
    if (!handle || typeof handle !== 'object') return 'unsupported';

    if (typeof handle.setNativeProps === 'function') {
        handle.setNativeProps({
            style: {
                opacity: motion.opacity,
                transform: [{ translateY: motion.translateYPx }],
                width: motion.widthPx,
            },
        });
        return 'set-native-props';
    }

    const style = resolveWritableInlineStyle(handle);
    if (style) {
        style.opacity = String(motion.opacity);
        style.transform = `translateY(${motion.translateYPx}px)`;
        style.width = `${motion.widthPx}px`;
        return 'dom';
    }

    return 'unsupported';
}
