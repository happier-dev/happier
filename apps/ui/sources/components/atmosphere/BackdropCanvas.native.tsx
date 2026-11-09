import * as React from 'react';
import { PixelRatio, View } from 'react-native';
import { Image } from 'expo-image';
import { Canvas, Image as SkiaImage, useImage, type SkImage } from '@shopify/react-native-skia';
import { PLANET_SCENE_RENDERER } from '@happier-dev/brand/planet';
import { atmosphereResettleFact } from './atmosphereStage';
import type { BackdropCanvasProps } from './backdropCanvas.types';
import { backdropSettle } from './backdropResettle';
import { backdropRenderRequest, backdropRequestKey } from './backdropRenderRequest';
import { acquireNativeBackdrop, createNativeBackdropTransition, NATIVE_TONE_SIDE, readNativePicturePixels, type NativeBackdropRender } from './renderBackdrop.native';
import { useCanvasRenderState } from './useCanvasRenderState';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

export const BackdropCanvas = React.memo(function BackdropCanvas(props: BackdropCanvasProps) {
    type Drawn = { localId: string | null; w: number; h: number };
    const state = useCanvasRenderState({ size: props.size, span: props.span, horizon: props.horizon }, props.source);
    const [shown, setShown] = React.useState<{ uri: string; render: NativeBackdropRender }>();
    const [target, setTarget] = React.useState<Readonly<{ key: string; uri: string; render: NativeBackdropRender; settle: NonNullable<ReturnType<typeof backdropSettle>>; drawn: Drawn }> | null>(null);
    const owned = React.useRef(new Set<NativeBackdropRender>());
    React.useLayoutEffect(() => {
        for (const render of owned.current) if (render !== shown?.render && render !== target?.render) {
            render.release(); owned.current.delete(render);
        }
    }, [shown, target]);
    React.useEffect(() => () => { for (const render of owned.current) render.release(); owned.current.clear(); }, []);
    const targetRef = React.useRef(target); targetRef.current = target;
    const [playback, setPlayback] = React.useState<{
        transition: Awaited<ReturnType<typeof createNativeBackdropTransition>>;
        target: NonNullable<typeof target>; elapsedMs: number; live: boolean;
    } | null>(null);
    const [animated, setAnimated] = React.useState<SkImage | null>(null);
    const fromImage = useImage(shown?.uri ?? null);
    const toImage = useImage(target?.uri ?? null);
    // What this canvas shows, and the last idle resettle it played (plan UD-4).
    const frame = React.useRef<Drawn | null>(null);
    const settled = React.useRef<number | null>(null);
    const ready = React.useRef(props.onReady); ready.current = props.onReady;
    const failed = React.useRef(props.onError); failed.current = props.onError;
    const rendered = React.useRef(props.onRendered); rendered.current = props.onRendered;
    const dpr = props.dpr ?? PixelRatio.get();
    const request = backdropRenderRequest({ ...props, ...state.geometry }, dpr);
    const displaySize = { width: request.width / dpr, height: request.height / dpr };
    const key = backdropRequestKey(request);
    const active = useHostActivelyViewed();
    const reducedMotion = useReducedMotionPreference();
    const paused = props.resettlePaused === true || !state.visible || !active;
    React.useEffect(() => {
        if (!state.visible || request.width <= 0 || request.height <= 0) return;
        if (targetRef.current?.key === key) return;
        let cancelled = false;
        const render = acquireNativeBackdrop(request);
        void render.promise.then(next => {
            if (cancelled) return;
            owned.current.add(render);
            const source = props.source;
            const drawn = { localId: 'localId' in source ? source.localId : null, w: request.width, h: request.height };
            const settle = backdropSettle({ enabled: props.resettle, fact: atmosphereResettleFact.get(), settled: settled.current, shown: frame.current, next: drawn });
            if (settle) settled.current = settle.id;
            if (settle) setTarget({ key, uri: next, render, settle, drawn });
            else { frame.current = drawn; setTarget(null); setAnimated(null); setShown({ uri: next, render }); }
        }, error => {
            render.release();
            if (!cancelled) failed.current?.(error instanceof Error ? error : new Error(String(error)));
        });
        return () => { cancelled = true; if (!owned.current.has(render)) render.release(); };
        // The serialized key includes all configuration; source is its own identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, props.source, state.visible, props.resettle]);
    // The shown render's pixels give the atmosphere its tone, as the web canvas does.
    React.useEffect(() => {
        if (!fromImage || !rendered.current) return;
        let live = true;
        void readNativePicturePixels(fromImage, NATIVE_TONE_SIDE).then(pixels => { if (live) rendered.current?.(pixels); }, () => {});
        return () => { live = false; };
    }, [fromImage]);
    const { theme } = props;
    const [red, green, blue] = props.page;
    React.useEffect(() => {
        setPlayback(null);
        if (!target || !fromImage || !toImage) return;
        let cancelled = false;
        let transition: Awaited<ReturnType<typeof createNativeBackdropTransition>> | null = null;
        let prepared: NonNullable<typeof playback> | null = null;
        void (async () => {
            transition = await createNativeBackdropTransition({ from: fromImage, to: toImage, kind: target.settle.kind, dpr, page: [red, green, blue], theme });
            if (cancelled) { await transition.dispose(); return; }
            prepared = { transition, target, elapsedMs: 0, live: true };
            setPlayback(prepared);
            ready.current?.();
        })().catch(error => { if (!cancelled) failed.current?.(error instanceof Error ? error : new Error(String(error))); });
        return () => {
            cancelled = true;
            if (prepared) prepared.live = false;
            if (transition) void transition.dispose();
        };
    }, [target, fromImage, toImage, dpr, red, green, blue, theme]);
    React.useEffect(() => {
        if (target && (props.resettle === false || (reducedMotion && target.settle.kind === 'resettle'))) {
            frame.current = target.drawn;
            setShown({ uri: target.uri, render: target.render });
            setAnimated(null);
            setTarget(null);
            return;
        }
        if (!playback?.live || playback.target !== target || paused) return;
        let cancelled = false, tick = 0;
        let last = performance.now();
        const step = async (time: number) => {
            if (cancelled || !playback.live) return;
            playback.elapsedMs += Math.max(0, time - last);
            last = time;
            const progress = Math.min(1, playback.elapsedMs / playback.target.settle.durationMs);
            const eased = playback.target.settle.kind === 'resettle' ? PLANET_SCENE_RENDERER.easeInOut(progress) : progress;
            const next = await playback.transition.frame(eased);
            if (cancelled || !playback.live) { next.dispose(); return; }
            setAnimated(next);
            if (progress >= 1) {
                frame.current = playback.target.drawn;
                setShown({ uri: playback.target.uri, render: playback.target.render });
                setTarget(null);
                return;
            }
            tick = requestAnimationFrame(time => { void step(time).catch(fail); });
        };
        const fail = (error: unknown) => {
            if (!cancelled) failed.current?.(error instanceof Error ? error : new Error(String(error)));
        };
        tick = requestAnimationFrame(time => { void step(time).catch(fail); });
        return () => { cancelled = true; cancelAnimationFrame(tick); };
    }, [target, playback, paused, reducedMotion, props.resettle]);
    React.useEffect(() => () => animated?.dispose(), [animated]);
    return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={props.testID} style={[props.style, displaySize]}>
        {shown ? <Image source={{ uri: shown.uri }} contentFit="fill" transition={0} onLoad={() => { setAnimated(null); ready.current?.(); }} style={displaySize} /> : null}
        {animated ? <Canvas pointerEvents="none" style={[displaySize, { position: 'absolute', left: 0, top: 0 }]}>
            <SkiaImage image={animated} x={0} y={0} width={displaySize.width} height={displaySize.height} fit="fill" />
        </Canvas> : null}
    </View>;
});
