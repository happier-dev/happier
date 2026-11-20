import * as React from 'react';
import { StyleSheet } from 'react-native';
import { createAtmosphereTransition, type AtmospherePixels } from '@happier-dev/brand/atmosphere';
import { PLANET_SCENE_RENDERER } from '@happier-dev/brand/planet';
import { snapCanvasBox } from '@/components/ui/media/canvasBackingStore';
import { atmosphereResettleFact } from './atmosphereStage';
import { backdropSettle } from './backdropResettle';
import type { BackdropCanvasProps, BackdropRenderRequest } from './backdropCanvas.types';
import { backdropRenderRequest, backdropRequestKey } from './backdropRenderRequest';
import { createBackdropWorker, retainBackdropWorker } from './backdropWorker.web';
import { createBackdropRenderCache } from './backdropRenderCache';
import { useCanvasRenderState } from './useCanvasRenderState';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

function createRenderer(initialRequest: BackdropRenderRequest) {
    let request = initialRequest;
    let worker: ReturnType<typeof createBackdropWorker> | null = null;
    const cache = createBackdropRenderCache<AtmospherePixels>((_key, signal) => {
        worker ??= createBackdropWorker();
        return worker.render(request, signal);
    });
    return {
        users: 0,
        render(next: BackdropRenderRequest) {
            request = next;
            return cache.acquire(backdropRequestKey(next));
        },
        dispose() { worker?.dispose(); worker = null; cache.clear(); },
    };
}

// A group only projects the same pixels in several clipped panes. Source identity remains the cache
// boundary, as it is for a standalone canvas; changing a picture cannot return the preceding bytes.
const renderGroups = new WeakMap<object, WeakMap<BackdropCanvasProps['source'], ReturnType<typeof createRenderer>>>();
function groupedRenderer(group: object, request: BackdropRenderRequest) {
    let sources = renderGroups.get(group);
    if (!sources) { sources = new WeakMap(); renderGroups.set(group, sources); }
    let renderer = sources.get(request.source);
    if (!renderer) { renderer = createRenderer(request); sources.set(request.source, renderer); }
    return renderer;
}

export const BackdropCanvas = React.memo(function BackdropCanvas(props: BackdropCanvasProps) {
    const [playback, setPlayback] = React.useState<{
        key: string; context: CanvasRenderingContext2D; target: ImageData;
        frames: ReturnType<typeof createAtmosphereTransition>;
        settle: NonNullable<ReturnType<typeof backdropSettle>>; elapsedMs: number;
    } | null>(null);
    const playbackRef = React.useRef(playback); playbackRef.current = playback;
    const ref = React.useRef<HTMLCanvasElement>(null);
    const ready = React.useRef(props.onReady); ready.current = props.onReady;
    const rendered = React.useRef(props.onRendered); rendered.current = props.onRendered;
    const failed = React.useRef(props.onError); failed.current = props.onError;
    // What this canvas shows, and the last idle resettle it played (plan UD-4).
    const shown = React.useRef<{ localId: string | null; w: number; h: number } | null>(null);
    const settled = React.useRef<number | null>(null);
    const state = useCanvasRenderState({ size: props.size, span: props.span, horizon: props.horizon }, props.source);
    const active = useHostActivelyViewed();
    const reducedMotion = useReducedMotionPreference();
    const paused = props.resettlePaused === true || !state.visible || !active;
    const dpr = props.dpr ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const request = backdropRenderRequest({ ...props, ...state.geometry }, dpr);
    const requestRef = React.useRef(request); requestRef.current = request;
    const key = backdropRequestKey(request);
    React.useEffect(() => retainBackdropWorker(), []);
    // Source-scoped projections release their buffers; the physical worker follows mounted canvases.
    const renderer = React.useMemo(() => props.renderGroup
        ? groupedRenderer(props.renderGroup, requestRef.current)
        : createRenderer(requestRef.current), [props.renderGroup, props.source]);
    React.useEffect(() => {
        renderer.users++;
        return () => { if (--renderer.users === 0) renderer.dispose(); };
    }, [renderer]);
    React.useEffect(() => {
        if (!state.visible || request.width <= 0 || request.height <= 0) return;
        if (playbackRef.current?.key === key) return;
        setPlayback(null);
        let cancelled = false;
        const render = renderer.render(requestRef.current);
        void render.promise.then(pixels => {
            if (cancelled || !ref.current) return;
            const canvas = ref.current;
            const { source, job } = requestRef.current;
            const next = { localId: 'localId' in source ? source.localId : null, w: pixels.w, h: pixels.h };
            const settle = backdropSettle({ enabled: props.resettle, fact: atmosphereResettleFact.get(), settled: settled.current, shown: shown.current, next });
            shown.current = next;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Atmosphere canvas is unavailable');
            const target = new ImageData(new Uint8ClampedArray(pixels.rgba), pixels.w, pixels.h);
            rendered.current?.(pixels);
            if (!settle) {
                // Set the backing store only when its new render is ready: no blank frame on resize.
                canvas.width = pixels.w; canvas.height = pixels.h;
                context.putImageData(target, 0, 0);
                ready.current?.();
                return;
            }
            // The idle resettle: the brand's frames from the picture on screen to the new one, then the
            // exact target (lab `Atmos.transition`). The resettle eases in and out; the cross-fade eases itself.
            settled.current = settle.id;
            const from = context.getImageData(0, 0, pixels.w, pixels.h);
            const frames = createAtmosphereTransition(settle.kind, { from: { rgba: from.data, w: pixels.w, h: pixels.h }, to: pixels, page: job.page, theme: job.theme, dpr });
            ready.current?.();
            setPlayback({ key, context, target, frames, settle, elapsedMs: 0 });
        }).catch(error => { if (!cancelled) failed.current?.(error instanceof Error ? error : new Error(String(error))); });
        return () => { cancelled = true; render.release(); };
        // All configuration is in key; source changes select a new renderer/cache.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renderer, key, state.visible, props.resettle]);
    React.useEffect(() => {
        if (!playback) return;
        const { context, target, frames, settle } = playback;
        if (props.resettle === false || (reducedMotion && settle.kind === 'resettle')) {
            context.putImageData(target, 0, 0);
            setPlayback(null);
            return;
        }
        if (paused) return;
        // Pausing retains both pixels and elapsed time; resuming excludes the hidden/typing interval.
        let last = performance.now();
        let frame = requestAnimationFrame(function step(time) {
            playback.elapsedMs += Math.max(0, time - last);
            last = time;
            const progress = Math.min(1, playback.elapsedMs / settle.durationMs);
            if (progress >= 1) {
                context.putImageData(target, 0, 0);
                setPlayback(null);
                return;
            }
            const eased = settle.kind === 'resettle' ? PLANET_SCENE_RENDERER.easeInOut(progress) : progress;
            context.putImageData(new ImageData(frames.frame(eased), frames.w, frames.h), 0, 0);
            frame = requestAnimationFrame(step);
        });
        return () => cancelAnimationFrame(frame);
    }, [playback, paused, reducedMotion, props.resettle]);
    const box = snapCanvasBox(state.geometry.size.width, state.geometry.size.height, dpr);
    return React.createElement('canvas', {
        ref, 'aria-hidden': true, 'data-testid': props.testID,
        style: { ...StyleSheet.flatten(props.style), width: box.width, height: box.height, pointerEvents: 'none', display: 'block' },
    });
});
