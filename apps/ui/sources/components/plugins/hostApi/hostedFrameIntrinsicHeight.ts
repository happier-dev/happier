import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';

export type HostedFrameIntrinsicHeightReporter = Readonly<{
    report: (height: number) => boolean;
    /** The current physical document's last published layout fact, not queued work. */
    readPublishedHeight: () => number | null;
    dispose: () => void;
}>;

export function readHostedFrameIntrinsicHeight(payload: PluginUiJsonValueV1 | undefined): number | null {
    const height = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? Reflect.get(payload, 'height')
        : undefined;
    return typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : null;
}

/**
 * Collapse an arbitrary burst of frame measurements into one host layout update
 * per display frame. This protects the renderer's actual scarce resource — UI
 * layout/commit work — without imposing a document, item, mount, or time quota.
 */
export function createHostedFrameIntrinsicHeightReporter(input: Readonly<{
    publish: (height: number) => void;
    scheduleFrame: (callback: () => void) => number;
    cancelFrame: (handle: number) => void;
}>): HostedFrameIntrinsicHeightReporter {
    let pendingHeight: number | null = null;
    let publishedHeight: number | null = null;
    let scheduledHandle: number | null = null;
    let disposed = false;

    const flush = () => {
        scheduledHandle = null;
        if (disposed || pendingHeight === null) return;
        const height = pendingHeight;
        pendingHeight = null;
        publishedHeight = height;
        input.publish(height);
    };

    return Object.freeze({
        readPublishedHeight: () => disposed ? null : publishedHeight,
        report: (height: number): boolean => {
            if (disposed || !Number.isFinite(height) || height <= 0) return false;
            pendingHeight = height;
            if (scheduledHandle === null) scheduledHandle = input.scheduleFrame(flush);
            return true;
        },
        dispose: (): void => {
            if (disposed) return;
            disposed = true;
            pendingHeight = null;
            if (scheduledHandle !== null) input.cancelFrame(scheduledHandle);
            scheduledHandle = null;
        },
    });
}
