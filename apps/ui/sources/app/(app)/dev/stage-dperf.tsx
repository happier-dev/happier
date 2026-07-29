import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import { DemoStage } from '@/components/onboarding/tour/stage/DemoStage';
import { type StageFrame, stageFrames } from '@/components/onboarding/tour/stage/stageFrames';
import {
    preloadStageSurfaces,
    type StageSurfaceId,
} from '@/components/onboarding/tour/stage/stageSurfaces';
import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { installDemoFirewall, uninstallDemoFirewall } from '@/demoMode/guards/demoFirewall';
import { clearDemoWorld, seedDemoWorld } from '@/demoMode/seed/seedDemoWorld';

export { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';

// The perf-cadence loop cycles these two frames (the D23 budget rig). Every
// registered frame is still individually capturable via `?frame=<id>` so the
// journey-beat pixel matrix (incl. the nine feature beats) can be shot here.
export const DPERF_STAGE_FRAME_IDS = [
    'session-view.hero',
    'session-view.spotlight',
] as const;

const DPERF_STAGE_FRAME_ID_SET = new Set<string>(DPERF_STAGE_FRAME_IDS);

// All registered frames are mounted so a pinned capture can target any beat.
const DPERF_STAGE_FRAMES = stageFrames satisfies readonly StageFrame[];

// The runtime warm-up only preloads the perf-cadence loop surfaces; a pinned
// beat's surface materializes lazily through the DemoStage Suspense boundary.
const DPERF_LOOP_STAGE_FRAMES = stageFrames.filter((frame) => DPERF_STAGE_FRAME_ID_SET.has(frame.id));

function readPinnedStageFrameId(): string | null {
    if (typeof window === 'undefined') return null;
    const search = typeof window.location?.search === 'string' ? window.location.search : '';
    if (!search) return null;
    const requested = new URLSearchParams(search).get('frame');
    if (!requested) return null;
    return stageFrames.some((frame) => frame.id === requested) ? requested : null;
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
    const pinnedFrameId = React.useMemo(() => readPinnedStageFrameId(), []);
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
            if (pinnedFrameId) return;
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
    }, [pinnedFrameId, runtimeDeps]);

    return (
        <View testID="stage-dperf-route" style={styles.root}>
            {ready ? (
                <DemoStage
                    frames={DPERF_STAGE_FRAMES}
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
    root: {
        alignItems: 'stretch',
        flex: 1,
        justifyContent: 'center',
        minHeight: 1,
        minWidth: 1,
    },
});
