import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, AppState, Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import type { GlyphSurfaceReadiness } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import type { WelcomeEntryViewModel } from '@/components/onboarding/preAuth/WelcomeEntryView';
import { useStepMotionStage } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { recordOpeningSeen } from '@/sync/domains/state/onboardingUiState';
import { invokeDesktopHost, isDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';
import { readHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import { FirstOpenOwnsWelcomePaint, FirstOpenWelcomeEpoch, FirstOpenWelcomeModelContext } from './FirstOpenWelcomeModelContext';
import { resolveInAppFirstFrame } from './inAppFirstFrame';
import type { FirstOpenAdmission } from './useFirstOpenBoot';

type Phase = 'preparing' | 'still' | 'settled' | { epoch: number };
const FirstOpenContentLayout = createContext<((event: LayoutChangeEvent) => WelcomeEntryViewModel | undefined) | null>(null);
type OverlayHost =
    | { kind: 'overlay'; epoch: number }
    | { kind: 'settled'; outcome: 'completed' | 'fallback' | 'interrupted' };

export function useFirstOpenContentLayout() {
    return useContext(FirstOpenContentLayout);
}

/** Presents the prepared decoration if available at the destination's first usable layout. */
export function FirstOpenHost({ opening, children, bootPending = false }: Readonly<{
    opening: FirstOpenAdmission;
    children: ReactNode;
    bootPending?: boolean;
}>) {
    const { decision } = opening;
    const scene = decision === 'in-app' ? opening.scene : null;
    const release = decision === 'in-app' ? opening.release : undefined;
    const stage = useStepMotionStage();
    const seen = useRef(false);
    const activePlay = useRef(false);
    const readiness = useRef<GlyphSurfaceReadiness | null>(null);
    const [phase, setPhase] = useState<Phase>('preparing');
    const [opacity] = useState(() => new Animated.Value(1));
    const [replica, setReplica] = useState<number | null>(null);
    const [replicaClosed, setReplicaClosed] = useState(false);
    const welcome = useRef<WelcomeEntryViewModel | undefined>(undefined);
    const transmitted = useRef<WelcomeEntryViewModel | undefined>(undefined);
    const replicaLive = useRef(false);
    const publishWelcome = useCallback((model: WelcomeEntryViewModel) => {
        welcome.current = model;
        if (!replicaLive.current || transmitted.current === model) return;
        transmitted.current = model;
        void invokeDesktopHost('desktop_first_open_welcome', { welcome: model }).catch(() => {});
    }, []);
    const waitingForReplica = decision === 'overlay-eligible' && !replicaClosed;
    const playing = typeof phase === 'object';
    const wasPresenting = useRef(false);
    const presenting = playing || (replica !== null && !replicaClosed);
    const settle = useCallback(() => setPhase('settled'), []);
    const fadeToRest = useCallback(() => {
        opacity.setValue(0.65);
        setPhase('still');
    }, [opacity]);
    const skip = useCallback((options?: Readonly<{ focusDestination: boolean }>) => {
        if (!activePlay.current || !scene) return;
        activePlay.current = false;
        fadeToRest();
        scene.skipFirstOpenDestination(options);
    }, [fadeToRest, scene]);
    const interrupt = useCallback(() => {
        if (!activePlay.current || !scene) return;
        activePlay.current = false;
        settle();
        scene.skipFirstOpenDestination();
    }, [scene, settle]);
    const updateReady = useCallback((result: GlyphSurfaceReadiness) => {
        readiness.current = result;
        if (result === 'still') skip();
    }, [skip]);

    useLayoutEffect(() => {
        if (wasPresenting.current && !presenting) performance.mark?.('first_open:destination-handoff');
        wasPresenting.current = presenting;
    }, [presenting]);

    useLayoutEffect(() => {
        if (phase === 'still' || phase === 'settled') release?.();
    }, [phase, release]);

    useLayoutEffect(() => {
        if (!waitingForReplica) return;
        let listening = true;
        let unlisten: (() => void) | undefined;
        void listenDesktopHostEvent<OverlayHost>('first_open:host', (host) => {
            if (host.kind === 'settled') {
                replicaLive.current = false;
                setReplicaClosed(true);
                if (host.outcome === 'fallback') fadeToRest();
                else settle();
                return;
            }
            replicaLive.current = true;
            setReplica(host.epoch - performance.timeOrigin);
            if (welcome.current) publishWelcome(welcome.current);
        }).then(stop => {
            if (listening) unlisten = stop;
            else stop();
        }).catch(() => {
            if (!listening) return;
            setReplicaClosed(true);
            fadeToRest();
        });
        return () => {
            listening = false;
            replicaLive.current = false;
            unlisten?.();
        };
    }, [fadeToRest, publishWelcome, settle, waitingForReplica]);

    const onFirstLayout = useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        if (seen.current || width <= 0 || height <= 0) return;
        seen.current = true;
        recordOpeningSeen(Date.now());
        if (decision === 'overlay-eligible') {
            transmitted.current = welcome.current;
            settle();
            return welcome.current;
        }
        // A desktop main webview commits this layout just before native shows it.
        if (scene && (isDesktopHost() || readHostActivelyViewed())
            && resolveInAppFirstFrame(decision, readiness.current, stage?.isBuildReady() ?? false) === 'play') {
            const epoch = performance.now();
            activePlay.current = true;
            setPhase({ epoch });
            void scene.buildFirstOpenDestination(epoch).then(outcome => {
                if (!activePlay.current) return;
                activePlay.current = false;
                if (outcome === 'settled') settle();
                else fadeToRest();
            }, () => skip());
            return;
        }
        fadeToRest();
    }, [decision, fadeToRest, scene, settle, skip, stage]);

    useEffect(() => {
        if (phase !== 'still') return;
        const fade = Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: Platform.OS !== 'web' });
        fade.start(({ finished }) => { if (finished) settle(); });
        return () => fade.stop();
    }, [opacity, phase, settle]);

    useEffect(() => {
        if (!playing || !scene) return;
        if (Platform.OS !== 'web') {
            const appState = AppState.addEventListener('change', (state) => { if (state !== 'active') interrupt(); });
            return () => appState.remove();
        }
        if (typeof document === 'undefined') return;
        const key = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || !activePlay.current) return;
            event.preventDefault();
            skip({ focusDestination: true });
        };
        const pointer = () => skip();
        const visibility = () => { if (document.hidden) interrupt(); };
        document.addEventListener('keydown', key, true);
        document.addEventListener('pointerdown', pointer, true);
        document.addEventListener('visibilitychange', visibility);
        return () => {
            document.removeEventListener('keydown', key, true);
            document.removeEventListener('pointerdown', pointer, true);
            document.removeEventListener('visibilitychange', visibility);
        };
    }, [interrupt, playing, scene, skip]);

    const skipTouch = playing && Platform.OS !== 'web' ? () => skip() : undefined;
    const Scene = scene?.FirstOpenScene;
    return (
        <View style={bootPending ? [StyleSheet.absoluteFillObject, { opacity: 0 }] : { flex: 1, position: 'relative' }}
            pointerEvents={bootPending ? 'none' : undefined} onTouchStart={skipTouch}>
            <Animated.View style={{ flex: 1, opacity }}>
                <FirstOpenContentLayout.Provider value={phase === 'preparing' ? onFirstLayout : null}>
                    <FirstOpenWelcomeEpoch.Provider value={typeof phase === 'object' ? phase.epoch : replicaClosed ? null : replica}>
                        <FirstOpenOwnsWelcomePaint.Provider value={playing}>
                            <FirstOpenWelcomeModelContext.Provider value={waitingForReplica ? publishWelcome : null}>
                                {children}
                            </FirstOpenWelcomeModelContext.Provider>
                        </FirstOpenOwnsWelcomePaint.Provider>
                    </FirstOpenWelcomeEpoch.Provider>
                </FirstOpenContentLayout.Provider>
            </Animated.View>
            {Scene && decision === 'in-app' && (phase === 'preparing' || typeof phase === 'object')
                ? <Scene epoch={typeof phase === 'object' ? phase.epoch : null} onReady={updateReady} warmup={opening.warmup} />
                : null}
        </View>
    );
}
