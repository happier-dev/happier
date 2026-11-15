import * as React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaFrameContext, SafeAreaInsetsContext, useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

import { DemoStage } from '@/components/onboarding/tour/stage/DemoStage';
import { resolveStageFramesForHostDevice, stageFrames, type StageFrame } from '@/components/onboarding/tour/stage/stageFrames';
import { StagePhoneCaptureContext } from '@/components/onboarding/tour/stage/StagePhoneCaptureContext';
import { StagePhoneNavigationHost } from '@/components/onboarding/tour/stage/StagePhoneNavigationHost';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';
import { MOBILE_MAX_WIDTH_PX } from '@/components/onboarding/unauthShell/useUnauthShellLayout';
import {
    preloadStageSurfaces,
    stageSurfaceById,
    type StageSurfaceId,
} from '@/components/onboarding/tour/stage/stageSurfaces';
import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { installDemoFirewall, uninstallDemoFirewall } from '@/demoMode/guards/demoFirewall';
import { clearDemoWorld, seedDemoWorld } from '@/demoMode/seed/seedDemoWorld';

// The perf-cadence loop cycles these two frames (the D23 budget rig). Every
// registered frame is still individually capturable via `?frame=<id>` so the
// journey-beat pixel matrix (incl. the nine feature beats) can be shot here.
export const DPERF_STAGE_FRAME_IDS = [
    'session-view.hero',
    'session-view.spotlight',
] as const;

const DPERF_STAGE_FRAME_ID_SET = new Set<string>(DPERF_STAGE_FRAME_IDS);

// The runtime warm-up only preloads the perf-cadence loop surfaces; a pinned
// beat's surface materializes lazily through the DemoStage Suspense boundary.
const DPERF_LOOP_STAGE_FRAMES = stageFrames.filter((frame) => DPERF_STAGE_FRAME_ID_SET.has(frame.id));

function readStageRouteOptions(): Readonly<{ pinnedFrameId: string | null; phoneCapture: boolean }> {
    const defaults = { pinnedFrameId: null, phoneCapture: false };
    if (typeof window === 'undefined') return defaults;
    const search = typeof window.location?.search === 'string' ? window.location.search : '';
    const params = new URLSearchParams(search);
    const requested = params.get('frame');
    return {
        pinnedFrameId: requested && stageFrames.some((frame) => frame.id === requested) ? requested : null,
        phoneCapture: params.get('capture') === 'phone',
    };
}

const PHONE_CAPTURE_INSETS = { top: 59, bottom: 34, left: 0, right: 0 };

function PhoneCaptureSurface(props: Readonly<{ frame: StageFrame }>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const viewport = useSafeAreaFrame();
    const insets = useSafeAreaInsets();
    const surface = stageSurfaceById.get(props.frame.surface);
    if (!surface) return null;
    const Surface = surface.component;
    const contentId = `demo-stage-frame-${props.frame.id}`;
    const captureAttributes = { dataSet: {
        'frame-id': props.frame.id,
        'viewport-width': String(viewport.width),
        'viewport-height': String(viewport.height),
        'safe-area-top': String(insets.top),
        'safe-area-bottom': String(insets.bottom),
        'safe-area-left': String(insets.left),
        'safe-area-right': String(insets.right),
    } };
    return (
        <View
            testID="demo-stage-phone-screen"
            style={[styles.captureScreen, { backgroundColor: theme.colors.surface.base }]}
            {...captureAttributes}
        >
            <React.Suspense fallback={<View testID={`${contentId}-loading`} />}>
                <View testID={`${contentId}-content`} style={styles.captureScreen}>
                    {surface.phoneSafeArea === 'capture' ? (
                        <StagePhoneNavigationHost surface={props.frame.surface}>
                            <Surface device="phone" />
                        </StagePhoneNavigationHost>
                    ) : <Surface device="phone" />}
                </View>
            </React.Suspense>
        </View>
    );
}

const DPERF_STAGE_SURFACE_IDS: readonly StageSurfaceId[] = Array.from(
    new Set(DPERF_LOOP_STAGE_FRAMES.map((frame) => frame.surface)),
);

export type StageDperfRuntimeStatus = 'ready' | 'cancelled';

export type StageDperfRuntimeDeps = Readonly<{
    seedDemoWorld: () => Promise<unknown>;
    preloadStageSurfaces: (surfaceIds: readonly StageSurfaceId[]) => Promise<unknown>;
    installDemoFirewall: () => void;
    shouldCancel?: () => boolean;
}>;

export type StageDperfRouteRuntimeDeps = StageDperfRuntimeDeps & Readonly<{
    clearDemoWorld: () => Promise<unknown>;
    uninstallDemoFirewall: () => void;
}>;

const DEFAULT_STAGE_DPERF_ROUTE_RUNTIME_DEPS: StageDperfRouteRuntimeDeps = {
    seedDemoWorld,
    preloadStageSurfaces,
    installDemoFirewall,
    clearDemoWorld,
    uninstallDemoFirewall,
};

export function resolveNextDperfStageFrameId(currentFrameId: string): string {
    const currentIndex = DPERF_STAGE_FRAME_IDS.findIndex((frameId) => frameId === currentFrameId);
    if (currentIndex < 0) return DPERF_STAGE_FRAME_IDS[0];
    return DPERF_STAGE_FRAME_IDS[(currentIndex + 1) % DPERF_STAGE_FRAME_IDS.length];
}

export async function prepareStageDperfRuntime(deps: StageDperfRuntimeDeps = {
    seedDemoWorld,
    preloadStageSurfaces,
    installDemoFirewall,
}): Promise<StageDperfRuntimeStatus> {
    await deps.seedDemoWorld();
    if (deps.shouldCancel?.()) return 'cancelled';

    await deps.preloadStageSurfaces(DPERF_STAGE_SURFACE_IDS);
    if (deps.shouldCancel?.()) return 'cancelled';

    deps.installDemoFirewall();
    if (deps.shouldCancel?.()) return 'cancelled';

    return 'ready';
}

export function StageDperfDevRouteContent(props: Readonly<{
    runtimeDeps?: StageDperfRouteRuntimeDeps;
}>): React.ReactElement {
    const runtimeDeps = props.runtimeDeps ?? DEFAULT_STAGE_DPERF_ROUTE_RUNTIME_DEPS;
    const { width, height } = useWindowDimensions();
    const frames = resolveStageFramesForHostDevice(width <= MOBILE_MAX_WIDTH_PX ? 'phone' : 'desktop');
    const { pinnedFrameId, phoneCapture } = React.useMemo(readStageRouteOptions, []);
    const captureViewport = React.useMemo(() => ({ x: 0, y: 0, width, height }), [height, width]);
    const [ready, setReady] = React.useState(false);
    const [activeFrameId, setActiveFrameId] = React.useState<string>(pinnedFrameId ?? DPERF_STAGE_FRAME_IDS[0]);
    const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        let seeded = false;
        let firewallInstalled = false;

        const stopLoop = () => {
            if (!intervalRef.current) return;
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        };

        const cleanupRuntime = async (): Promise<void> => {
            const shouldClear = seeded;
            const shouldUninstallFirewall = firewallInstalled;
            seeded = false;
            firewallInstalled = false;
            try {
                if (shouldClear) {
                    await runtimeDeps.clearDemoWorld();
                }
            } finally {
                if (shouldUninstallFirewall) {
                    runtimeDeps.uninstallDemoFirewall();
                }
            }
        };

        async function startRuntime(): Promise<void> {
            const status = await prepareStageDperfRuntime({
                seedDemoWorld: async () => {
                    await runtimeDeps.seedDemoWorld();
                    seeded = true;
                },
                preloadStageSurfaces: runtimeDeps.preloadStageSurfaces,
                installDemoFirewall: () => {
                    runtimeDeps.installDemoFirewall();
                    firewallInstalled = true;
                },
                shouldCancel: () => cancelled,
            });
            if (status === 'cancelled' || cancelled) {
                await cleanupRuntime();
                return;
            }

            setReady(true);
            // A pinned frame holds still for a deterministic screenshot; otherwise
            // cycle the two perf-cadence frames as before.
            if (pinnedFrameId || phoneCapture) return;
            intervalRef.current = setInterval(() => {
                setActiveFrameId((currentFrameId) => resolveNextDperfStageFrameId(currentFrameId));
            }, 1400);
        }

        void startRuntime().catch(() => {
            void cleanupRuntime().catch(() => undefined);
        });

        return () => {
            cancelled = true;
            stopLoop();
            void cleanupRuntime().catch(() => undefined);
        };
    }, [phoneCapture, pinnedFrameId, runtimeDeps]);

    const activeFrame = frames.find((frame) => frame.id === activeFrameId) ?? frames[0];

    return (
        <View testID="stage-dperf-route" style={styles.root}>
            {phoneCapture ? <Stack.Screen options={{ headerShown: false }} /> : null}
            {ready && phoneCapture && activeFrame ? (
                <NavigationTitleChromeProvider showsTitle={false}>
                    <StagePhoneCaptureContext.Provider value>
                        {/* SafeAreaProvider's web measurement replaces initialMetrics with env() zeros.
                            These canonical contexts keep the capture's simulated device metrics fixed. */}
                        <SafeAreaFrameContext.Provider value={captureViewport}>
                            <SafeAreaInsetsContext.Provider value={PHONE_CAPTURE_INSETS}>
                                <PhoneCaptureSurface frame={activeFrame} />
                            </SafeAreaInsetsContext.Provider>
                        </SafeAreaFrameContext.Provider>
                    </StagePhoneCaptureContext.Provider>
                </NavigationTitleChromeProvider>
            ) : ready ? (
                <DemoStage
                    frames={frames}
                    activeFrameId={activeFrameId}
                />
            ) : null}
        </View>
    );
}

export default function StageDperfDevRoute(): React.ReactElement | null {
    if (!isDevRouteEnabled()) return null;
    return <StageDperfDevRouteContent />;
}

const styles = StyleSheet.create({
    captureScreen: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
    },
    root: {
        alignItems: 'stretch',
        flex: 1,
        justifyContent: 'center',
        minHeight: 1,
        minWidth: 1,
    },
});
