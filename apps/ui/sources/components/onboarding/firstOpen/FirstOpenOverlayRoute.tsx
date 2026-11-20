import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';

import type { GlyphSurfaceReadiness } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import type { WelcomeEntryViewModel } from '@/components/onboarding/preAuth/WelcomeEntryView';
import { usePrepareStepBuild } from '@/components/ui/motion/stepMotion/StepMotionStage';
import type { StepBuildResult } from '@/components/ui/motion/stepMotion/stepMotionTypes';
import { getDesktopHostWindowLabel, invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';

import type { FirstOpenPlacement } from './FirstOpenScene';

type Presentation = typeof import('./FirstOpenOverlayPresentation');
type Start = FirstOpenPlacement & Readonly<{ epoch: number; welcome: WelcomeEntryViewModel }>;

/** Hidden until native has its ready event, a Welcome snapshot and an active launch. */
export function FirstOpenOverlayRoute() {
    const [prepared, setPrepared] = useState<Readonly<{ Presentation: Presentation; placement: FirstOpenPlacement }> | null>(null);
    const [start, setStart] = useState<Start | null>(null);
    const [sceneReady, setSceneReady] = useState<GlyphSurfaceReadiness | null>(null);
    const [buildReady, setBuildReady] = useState(false);
    const [settling, setSettling] = useState(false);
    const [opacity] = useState(() => new Animated.Value(1));
    const fade = useRef<Animated.CompositeAnimation | undefined>(undefined);
    const swapping = useRef(false);
    const readySent = useRef(false);
    // The stage keeps the shared glyph renderer available through the build after admission.
    usePrepareStepBuild(prepared !== null && !settling, setBuildReady);
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

    useEffect(() => {
        if (getDesktopHostWindowLabel() !== 'first_open_overlay') return;
        let disposed = false;
        const listeners: Array<() => void> = [];
        const listen = <T,>(event: string, callback: (payload: T) => void) => {
            void listenDesktopHostEvent<T>(event, payload => { if (!disposed) callback(payload); }).then(stop => {
                if (disposed) stop();
                else listeners.push(stop);
            }).catch(() => { if (!disposed) unavailable(); });
        };
        listen<FirstOpenPlacement>('first_open:prepare', placement => {
            void import('./FirstOpenOverlayPresentation').then(Presentation => {
                if (!disposed) setPrepared({ Presentation, placement });
            }, () => { if (!disposed) unavailable(); });
        });
        listen<Start>('first_open:start', payload => {
            setStart({ ...payload, epoch: payload.epoch - performance.timeOrigin });
        });
        listen<WelcomeEntryViewModel>('first_open:welcome', welcome => {
            setStart(current => current ? { ...current, welcome } : current);
        });
        return () => {
            disposed = true;
            for (const stop of listeners) stop();
            fade.current?.stop();
        };
    }, [unavailable]);

    useEffect(() => {
        if (sceneReady === 'still') { unavailable(); return; }
        if (sceneReady !== 'ready' || !buildReady || readySent.current) return;
        readySent.current = true;
        void invokeDesktopHost('desktop_first_open_overlay_ready').catch(unavailable);
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
            <FirstOpenScene epoch={start?.epoch ?? null} holding={settling} placement={prepared.placement} onReady={setSceneReady} />
        </Animated.View>
    );
}
