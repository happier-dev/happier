import { browserViewKey } from '@happier-dev/protocol/browser/view/key';

import type { BrowserSidecarContextCaptureSurface, BrowserSidecarCdpPageHandle } from '../sidecar/controlAdapter';
import type { SurfaceInputControl } from '../../surfaces/inputControl';
import type { BrowserViewportOwner } from '../sidecar/viewport';

// BR-STREAM-QUALITY's Chrome 155 encoding sweep: 0.75 / 65 used 66,793 B
// versus 150,298 B at the native default, retaining readable moving text.
// 80 matched native-default size/detail in that sweep for stills and recording.
const STILL_QUALITY = 80;
const MOTION_QUALITY = 65;
const MOTION_SCALE = 0.75;
// Three observed QA frame periods (~78 ms) plus a compositor tick. This is a
// one-shot quiet deadline, not a capture cadence or an operation timeout.
const MOTION_SETTLE_MS = 250;
type Encoding = Readonly<{ format: 'jpeg'; quality: number; maxWidth?: number; maxHeight?: number }>;

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
    lastFrame: BrowserCdpScreencastFrame | null;
    started: Promise<boolean>;
    stopping: Promise<void> | null;
    closed: boolean;
    unsubscribe: () => void;
    viewportOwner?: BrowserViewportOwner;
    encoding: Encoding;
    updating: Promise<void>;
    motion: boolean;
    previousFrameAt: number | null;
    settleTimer: ReturnType<typeof setTimeout> | null;
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
    function clearMotion(capture: Capture): void {
        if (capture.settleTimer !== null) clearTimeout(capture.settleTimer);
        capture.settleTimer = null;
        capture.motion = false;
        capture.previousFrameAt = null;
    }
    function needsNativeDetail(capture: Capture): boolean {
        for (const consumer of capture.consumers) if (consumer.purpose !== 'humanViewer') return true;
        return false;
    }
    function encodingFor(capture: Capture, view: BrowserCaptureView): Encoding {
        // Recording/observation consumes native detail, independently of viewers.
        const nativeDetail = needsNativeDetail(capture);
        const viewport = nativeDetail ? undefined : capture.viewportOwner?.getViewport(view);
        // Chrome's emulated high-DPR screencast can still be CSS-sized (measured
        // 1280x800 at DPR 2). Motion targets CSS detail so the cap actually shrinks
        // pixels there too; settled capture allows the entire viewer backing store.
        const scale = capture.motion && !nativeDetail ? MOTION_SCALE : (viewport?.deviceScaleFactor ?? 1);
        return { format: 'jpeg', quality: capture.motion && !nativeDetail ? MOTION_QUALITY : STILL_QUALITY,
            ...(viewport ? { maxWidth: Math.max(1, Math.round(viewport.width * scale)),
                maxHeight: Math.max(1, Math.round(viewport.height * scale)) } : {}) };
    }
    function updateEncoding(capture: Capture, view: BrowserCaptureView): void {
        // CDP has no in-place parameter update. Serialize stop/start with final stop;
        // read the geometry owner's latest applied value when this change takes effect.
        capture.updating = capture.updating.then(async () => {
            if (capture.closed || !await capture.started) return;
            const next = encodingFor(capture, view);
            const previous = capture.encoding;
            if (next.quality === previous.quality && next.maxWidth === previous.maxWidth && next.maxHeight === previous.maxHeight) return;
            await dispatch({ ...capture.handle, method: 'Page.stopScreencast' });
            if (capture.closed) return;
            capture.encoding = next;
            capture.previousFrameAt = null;
            await dispatch({ ...capture.handle, method: 'Page.startScreencast', params: next });
        }).catch((error: unknown) => {
            for (const subscriber of capture.consumers) report(subscriber, error);
        });
    }
    function observeMotion(capture: Capture, view: BrowserCaptureView, arrivedAt: number): void {
        if (needsNativeDetail(capture)) return;
        const previous = capture.previousFrameAt;
        capture.previousFrameAt = arrivedAt;
        if (!capture.motion && previous !== null && arrivedAt - previous < MOTION_SETTLE_MS) {
            capture.motion = true;
            updateEncoding(capture, view);
        }
        if (!capture.motion) return;
        if (capture.settleTimer !== null) clearTimeout(capture.settleTimer);
        capture.settleTimer = setTimeout(() => {
            clearMotion(capture);
            // Restart pushes the detailed still even when the page no longer repaints.
            updateEncoding(capture, view);
        }, MOTION_SETTLE_MS);
        // The Node daemon handle also supports unref; browser ambient timer overloads omit it.
        (capture.settleTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    }
    function close(key: string, capture: Capture): Promise<void> {
        if (capture.stopping) return capture.stopping;
        capture.closed = true;
        clearMotion(capture);
        capture.lastFrame = null;
        capture.unsubscribe();
        capture.stopping = (async () => {
            try {
                await capture.updating;
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
                    handle, consumers: new Set(), lastFrame: null, started: Promise.resolve(false), stopping: null,
                    closed: false, unsubscribe: () => undefined,
                    viewportOwner: input.contextCapture.resolveViewportOwner?.(consumer.view),
                    encoding: { format: 'jpeg', quality: STILL_QUALITY }, updating: Promise.resolve(),
                    motion: false, previousFrameAt: null, settleTimer: null,
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
                        created.lastFrame = frame;
                        observeMotion(created, consumer.view, frame.timestampMs);
                        for (const subscriber of [...created.consumers]) {
                            if (subscriber.purpose !== 'humanViewer' && control?.isObservationHeld()) continue;
                            try { subscriber.onFrame(frame); } catch (error) { report(subscriber, error); }
                        }
                    } finally {
                        void dispatch({ ...handle, method: 'Page.screencastFrameAck', params: { sessionId } })
                            .catch((error: unknown) => { for (const subscriber of created.consumers) report(subscriber, error); });
                    }
                });
                const unsubscribeFrames = created.unsubscribe;
                const unsubscribeViewport = created.viewportOwner?.subscribe(view => {
                    if (browserViewKey(view) === key) updateEncoding(created, view);
                });
                created.unsubscribe = () => { unsubscribeFrames(); unsubscribeViewport?.(); };
                created.encoding = encodingFor(created, consumer.view);
                created.started = dispatch({ ...handle, method: 'Page.startScreencast', params: created.encoding })
                    .then(() => true, (error: unknown) => {
                        created.closed = true;
                        clearMotion(created);
                        created.unsubscribe();
                        if (captures.get(key) === created) captures.delete(key);
                        for (const subscriber of created.consumers) report(subscriber, error);
                        return false;
                    });
            } else {
                capture.consumers.add(consumer);
                if (consumer.purpose !== 'humanViewer') clearMotion(capture);
                updateEncoding(capture, consumer.view);
                // Chromium only emits on repaint. A newly admitted human viewer needs the
                // current picture even while another viewer/recording keeps this capture alive.
                // Observation subscribers still wait for fresh, non-confidential evidence.
                if (consumer.purpose === 'humanViewer' && capture.lastFrame) {
                    try { consumer.onFrame(capture.lastFrame); } catch (error) { report(consumer, error); }
                }
            }
            const current = capture;
            if (!await current.started || current.closed) return null;
            await current.updating;
            if (current.closed) return null;
            if (consumer.purpose !== 'humanViewer' && control?.isObservationHeld()) {
                current.consumers.delete(consumer);
                if (!current.consumers.size) await close(key, current);
                else updateEncoding(current, consumer.view);
                return null;
            }
            let released = false;
            return {
                async stop() {
                    if (released) return;
                    released = true;
                    current.consumers.delete(consumer);
                    if (!current.consumers.size) await close(key, current);
                    else updateEncoding(current, consumer.view);
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
