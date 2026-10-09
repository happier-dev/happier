import { browserViewKey } from '@happier-dev/protocol/browser/view/key';

import type { BrowserSidecarContextCaptureSurface, BrowserSidecarCdpPageHandle } from '../sidecar/controlAdapter';
import type { SurfaceInputControl } from '../../surfaces/inputControl';

export type BrowserCaptureView = Readonly<{ browserSessionId: string; viewId: string }>;
export type BrowserCdpScreencastFrame = Readonly<{
    sessionId: number;
    dataBase64: string;
    timestampMs: number;
    width?: number;
    height?: number;
}>;
type Consumer = Readonly<{
    /** Only the separately admitted present-human stream uses this purpose. */
    purpose?: 'humanViewer';
    onFrame: (frame: BrowserCdpScreencastFrame) => void;
    onError?: (error: unknown) => void;
}>;
export type BrowserCdpScreencastSubscription = Readonly<{ stop(): Promise<void> }>;
export type BrowserCdpScreencastProducer = Readonly<{
    start(input: Consumer & Readonly<{ view: BrowserCaptureView }>): Promise<BrowserCdpScreencastSubscription | null>;
    closeView(view: BrowserCaptureView): Promise<void>;
    dispose(): Promise<void>;
}>;
type Capture = {
    handle: BrowserSidecarCdpPageHandle;
    consumers: Set<Consumer>;
    started: Promise<boolean>;
    stopping: Promise<void> | null;
    closed: boolean;
    unsubscribe: () => void;
};

/** One page screencast and one CDP ACK owner, shared by recording and live viewers. */
export function createBrowserCdpScreencastProducer(input: Readonly<{
    contextCapture: BrowserSidecarContextCaptureSurface;
    resolveInputControl?: (view: BrowserCaptureView) => SurfaceInputControl | undefined;
    nowMs?: () => number;
}>): BrowserCdpScreencastProducer {
    const captures = new Map<string, Capture>();
    const nowMs = input.nowMs ?? Date.now;
    const dispatch = input.contextCapture.transport.dispatchPageCommand;
    let disposed = false;

    function report(consumer: Consumer, error: unknown): void {
        try { consumer.onError?.(error); } catch { /* A failing subscriber cannot break other consumers. */ }
    }
    function close(key: string, capture: Capture): Promise<void> {
        if (capture.stopping) return capture.stopping;
        capture.closed = true;
        capture.unsubscribe();
        capture.stopping = (async () => {
            try {
                if (await capture.started) await dispatch({ ...capture.handle, method: 'Page.stopScreencast' });
            } finally {
                if (captures.get(key) === capture) captures.delete(key);
            }
        })();
        return capture.stopping;
    }

    function retire(key: string, capture: Capture): Promise<void> {
        if (capture.closed) return capture.stopping ?? Promise.resolve();
        const consumers = [...capture.consumers];
        const stopping = close(key, capture);
        for (const consumer of consumers) report(consumer, new Error('capture_source_unavailable'));
        return stopping;
    }
    const unsubscribeLifecycle = input.contextCapture.subscribeViewLifecycle?.((event) => {
        const key = browserViewKey(event);
        const capture = captures.get(key);
        if (!capture) return;
        const handle = input.contextCapture.resolvePageHandle(event);
        if (event.type === 'unbound' || handle?.targetId !== capture.handle.targetId || handle?.sessionId !== capture.handle.sessionId) {
            void retire(key, capture).catch(() => undefined);
        }
    });

    return {
        async start(consumer) {
            if (disposed) return null;
            const control = input.resolveInputControl?.(consumer.view);
            if (consumer.purpose !== 'humanViewer' && control?.isObservationHeld()) return null;
            const key = browserViewKey(consumer.view);
            let capture = captures.get(key);
            while (capture?.stopping) {
                await capture.stopping.catch(() => undefined);
                capture = captures.get(key);
            }
            if (disposed) return null;
            if (!capture) {
                const handle = input.contextCapture.resolvePageHandle(consumer.view);
                const subscribe = input.contextCapture.subscribeCdpEvents;
                // The shared CDP connection identifies page notifications by attached session.
                if (!handle?.sessionId || !subscribe) return null;
                const created: Capture = {
                    handle, consumers: new Set(), started: Promise.resolve(false), stopping: null,
                    closed: false, unsubscribe: () => undefined,
                };
                capture = created;
                captures.set(key, created);
                created.consumers.add(consumer);
                created.unsubscribe = subscribe((notification) => {
                    if (created.closed || notification.method !== 'Page.screencastFrame' || notification.sessionId !== handle.sessionId) return;
                    const params = notification.params;
                    const sessionId = params?.sessionId;
                    if (typeof sessionId !== 'number' || !Number.isInteger(sessionId)) return;
                    try {
                        if (typeof params?.data !== 'string' || !params.data) return;
                        const metadata = params.metadata;
                        const dimensions = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
                            ? metadata as Record<string, unknown> : {};
                        const frame: BrowserCdpScreencastFrame = {
                            sessionId, dataBase64: params.data, timestampMs: nowMs(),
                            ...(typeof dimensions.deviceWidth === 'number' && dimensions.deviceWidth > 0 ? { width: dimensions.deviceWidth } : {}),
                            ...(typeof dimensions.deviceHeight === 'number' && dimensions.deviceHeight > 0 ? { height: dimensions.deviceHeight } : {}),
                        };
                        for (const subscriber of [...created.consumers]) {
                            if (subscriber.purpose !== 'humanViewer' && control?.isObservationHeld()) continue;
                            try { subscriber.onFrame(frame); } catch (error) { report(subscriber, error); }
                        }
                    } finally {
                        void dispatch({ ...handle, method: 'Page.screencastFrameAck', params: { sessionId } })
                            .catch((error: unknown) => { for (const subscriber of created.consumers) report(subscriber, error); });
                    }
                });
                created.started = dispatch({ ...handle, method: 'Page.startScreencast', params: { format: 'jpeg' } })
                    .then(() => true, (error: unknown) => {
                        created.closed = true;
                        created.unsubscribe();
                        if (captures.get(key) === created) captures.delete(key);
                        for (const subscriber of created.consumers) report(subscriber, error);
                        return false;
                    });
            } else {
                capture.consumers.add(consumer);
            }
            const current = capture;
            if (!await current.started || current.closed) return null;
            if (consumer.purpose !== 'humanViewer' && control?.isObservationHeld()) {
                current.consumers.delete(consumer);
                if (!current.consumers.size) await close(key, current);
                return null;
            }
            let released = false;
            return {
                async stop() {
                    if (released) return;
                    released = true;
                    current.consumers.delete(consumer);
                    if (!current.consumers.size) await close(key, current);
                },
            };
        },
        async closeView(view) {
            const key = browserViewKey(view);
            const capture = captures.get(key);
            if (!capture) return;
            await retire(key, capture);
        },
        async dispose() {
            disposed = true;
            unsubscribeLifecycle?.();
            await Promise.all([...captures].map(([key, capture]) => retire(key, capture)));
        },
    };
}
