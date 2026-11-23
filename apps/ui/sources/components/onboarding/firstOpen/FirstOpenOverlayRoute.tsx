import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';

import type { GlyphSurfaceReadiness, GlyphSurfaceWarmup } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import type { WelcomeEntryViewModel } from '@/components/onboarding/preAuth/WelcomeEntryView';
import { usePrepareStepBuild } from '@/components/ui/motion/stepMotion/StepMotionStage';
import type { StepBuildResult } from '@/components/ui/motion/stepMotion/stepMotionTypes';
import { getDesktopHostWindowLabel, invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';

import type { FirstOpenPlacement } from './FirstOpenScene';

type Presentation = typeof import('./FirstOpenOverlayPresentation');
type Start = FirstOpenPlacement & Readonly<{ epoch: number; welcome: WelcomeEntryViewModel }>;

function reportProgress(progress: 'prepared' | 'drawn' | 'ready') {
    return invokeDesktopHost('desktop_first_open_overlay_progress', { progress });
}

/** Hidden until native has its ready event, a Welcome snapshot and an active launch. */
export function FirstOpenOverlayRoute() {
    const isPresenter = getDesktopHostWindowLabel() === 'first_open_overlay';
    const [prepared, setPrepared] = useState<Readonly<{
        Presentation: Presentation;
        placement: FirstOpenPlacement;
        warmup?: GlyphSurfaceWarmup;
    }> | null>(null);
    const [start, setStart] = useState<Start | null>(null);
    const [sceneReady, setSceneReady] = useState<GlyphSurfaceReadiness | null>(null);
    const [buildReady, setBuildReady] = useState(false);
    const [settling, setSettling] = useState(false);
    const [opacity] = useState(() => new Animated.Value(1));
    const fade = useRef<Animated.CompositeAnimation | undefined>(undefined);
    const swapping = useRef(false);
    const readySent = useRef(false);
    // Reserve the renderer and start the destination build while the presenter is still hidden.
    usePrepareStepBuild(isPresenter && !settling, setBuildReady);
    const unavailable = useCallback(() => {
        void invokeDesktopHost('desktop_first_open_overlay_unavailable').catch(() => {});
    }, []);
    const close = useCallback(() => {
        void invokeDesktopHost('desktop_first_open_close').catch(() => {});
    }, []);
    const swap = useCallback(() => {
        if (swapping.current) return;
        swapping.current = true;
        setSettling(true);
        prepared?.Presentation.skipFirstOpenDestination();
        void invokeDesktopHost('desktop_first_open_swap').then(() => {
            const animation = Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: false });
            fade.current = animation;
            animation.start(({ finished }) => { if (finished) close(); });
        }, close);
    }, [close, opacity, prepared]);
    const buildSettled = useCallback((outcome: StepBuildResult) => {
        if (swapping.current) return;
        if (outcome === 'settled') swap();
        else unavailable();
    }, [swap, unavailable]);
    const onFirstDraw = useCallback((status: GlyphSurfaceReadiness) => {
        if (status === 'ready') void reportProgress('drawn').catch(() => {});
        setSceneReady(status);
    }, []);

    useEffect(() => {
        if (!isPresenter) return;
        let disposed = false;
        const listeners: Array<() => void> = [];
        const listen = <T,>(event: string, callback: (payload: T) => void) => {
            return listenDesktopHostEvent<T>(event, payload => { if (!disposed) callback(payload); }).then(stop => {
                if (disposed) stop();
                else listeners.push(stop);
            });
        };
        const startListener = listen<Start>('first_open:start', payload => {
            setStart({ ...payload, epoch: payload.epoch - performance.timeOrigin });
        });
        const welcomeListener = listen<WelcomeEntryViewModel>('first_open:welcome', welcome => {
            setStart(current => current ? { ...current, welcome } : current);
        });
        const placement = Promise.all([startListener, welcomeListener]).then(async () => {
            if (disposed) return;
            const frame = await invokeDesktopHost<FirstOpenPlacement>('desktop_first_open_overlay_subscribed');
            if (!disposed) void reportProgress('prepared').catch(() => {});
            return frame;
        });
        const presentation = import('./FirstOpenOverlayPresentation');
        const warmup = import('@/components/atmosphere/glyph/GlyphSurface').then(glyph => {
            if (!disposed) return glyph.warmGlyphSurface();
        });
        void Promise.all([placement, presentation, warmup]).then(([frame, Presentation, glyph]) => {
            if (!disposed && frame) setPrepared({ Presentation, placement: frame, warmup: glyph });
        }, () => { if (!disposed) unavailable(); });
        return () => {
            disposed = true;
            for (const stop of listeners) stop();
            fade.current?.stop();
        };
    }, [isPresenter, unavailable]);

    useEffect(() => {
        if (sceneReady === 'still') { unavailable(); return; }
        if (sceneReady !== 'ready' || !buildReady || readySent.current) return;
        readySent.current = true;
        void reportProgress('ready').catch(unavailable);
    }, [buildReady, sceneReady, unavailable]);

    const started = start !== null;
    useEffect(() => {
        if (!started) return;
        const pointer = (event: PointerEvent) => { event.preventDefault(); swap(); };
        const key = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); swap(); }
        };
        document.addEventListener('pointerdown', pointer, true);
        document.addEventListener('keydown', key, true);
        return () => {
            document.removeEventListener('pointerdown', pointer, true);
            document.removeEventListener('keydown', key, true);
        };
    }, [started, swap]);

    if (!prepared) return null;
    const { FirstOpenScene, FirstOpenOverlayReplica } = prepared.Presentation;
    return (
        <Animated.View style={[StyleSheet.absoluteFillObject, { opacity }]}>
            {start ? (
                <FirstOpenOverlayReplica welcome={start.welcome} epoch={start.epoch} windowRect={start.windowRect}
                    onSettled={buildSettled} />
            ) : null}
            <FirstOpenScene epoch={start?.epoch ?? null} holding={settling} placement={prepared.placement}
                warmup={prepared.warmup} onReady={onFirstDraw} />
        </Animated.View>
    );
}
