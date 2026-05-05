import { useMemo, useRef, type ReactNode } from 'react';
import type { Scenario, DeviceFocus } from '../timeline/types';
import type {
    DemoSurfaceView,
    ScenarioBeat,
} from '../timeline/scenarioTypes';
import { useScenarioTimeline } from '../timeline/useScenarioTimeline';
import { useInView } from '../useInView';
import {
    resolveStageSurfaceVisibility,
    type StageLayout,
} from './resolveStageSurfaceVisibility';
import { resolveTerminalTitle } from './resolveTerminalTitle';

export type DemoInstanceId = string;

export type ScenarioStagePrep = {
    demoId: DemoInstanceId;
    scenario: Scenario;
    state: ReturnType<typeof useScenarioTimeline>['state'];
    focus: DeviceFocus;
    activeBeat: ScenarioBeat;
    /** Index of the active beat in the scenario's beat list (0-based). */
    beatIndex: number;
    /** Total beat count. */
    totalBeats: number;
    surfaceVisibility: ReturnType<typeof resolveStageSurfaceVisibility>;
    terminalTitle: string;
    desktopTitle: string;
    phoneView: DemoSurfaceView;
    desktopView: DemoSurfaceView;
    stageRef: React.RefObject<HTMLDivElement | null>;
    inView: boolean;
    phoneScreen?: ReactNode;
    desktopScreen?: ReactNode;
};

export type UseScenarioStageInput = {
    demoId?: DemoInstanceId;
    scenario: Scenario;
    layout: StageLayout;
    phoneView?: DemoSurfaceView;
    desktopView?: DemoSurfaceView;
    phoneScreen?: ReactNode;
    desktopScreen?: ReactNode;
};

/**
 * Shared scenario wiring for the cinematic stage.
 *
 * The bridge / cross-document store is gone — the marketing site renders
 * real screenshots and recordings of the live app, not a mounted React
 * tree. The hook still exposes the timeline so beats can drive cinematography
 * and the NarrativeLayer.
 */
export function useScenarioStage(input: UseScenarioStageInput): ScenarioStagePrep {
    const demoId = input.demoId ?? input.scenario.id;

    const stageRef = useRef<HTMLDivElement | null>(null);
    const inView = useInView(stageRef, { rootMargin: '0px 0px -20% 0px' });

    const { state, focus, activeBeat } = useScenarioTimeline(input.scenario, {
        autoplay: inView,
    });

    const phoneView: DemoSurfaceView = input.phoneView ?? 'phone-session';
    const desktopView: DemoSurfaceView = input.desktopView ?? 'desktop-session';

    const surfaceVisibility = resolveStageSurfaceVisibility({
        layout: input.layout,
        visibleSurfaces: activeBeat.visibleSurfaces,
        phoneView,
        desktopView,
    });

    const terminalTitle = useMemo(
        () => resolveTerminalTitle(activeBeat, state.sessionTitle),
        [activeBeat, state.sessionTitle],
    );

    const beatIndex = Math.max(
        0,
        input.scenario.beats.findIndex((b) => b.id === activeBeat.id),
    );

    return {
        demoId,
        scenario: input.scenario,
        state,
        focus,
        activeBeat,
        beatIndex,
        totalBeats: input.scenario.beats.length,
        surfaceVisibility,
        terminalTitle,
        desktopTitle: 'Happier',
        phoneView,
        desktopView,
        stageRef,
        inView,
        phoneScreen: input.phoneScreen,
        desktopScreen: input.desktopScreen,
    };
}
