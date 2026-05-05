import { useEffect, useMemo, useRef, useState } from 'react';
import { createScenarioEngine } from './scenarioEngine';
import type { DemoState, DeviceFocus, Scenario, ScenarioBeat } from './scenarioTypes';

type TimelineOptions = Readonly<{
    autoplay?: boolean;
    speed?: number;
}>;

export type ScenarioTimelineView = Readonly<{
    elapsed: number;
    progress: number;
    activeBeat: ScenarioBeat;
    state: DemoState;
    focus: DeviceFocus;
    reducedMotion: boolean;
}>;

function readReducedMotion(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;
}

export function useScenarioTimeline(
    scenario: Scenario,
    { autoplay = true, speed = 1 }: TimelineOptions = {},
): ScenarioTimelineView {
    const reducedMotion = readReducedMotion();
    const [elapsed, setElapsed] = useState(0);
    const rafRef = useRef<number | null>(null);
    const startRef = useRef<number | null>(null);
    const engine = useMemo(() => createScenarioEngine(scenario), [scenario]);

    const activeBeat = engine.seek(elapsed);

    useEffect(() => {
        setElapsed(0);
        startRef.current = null;
    }, [scenario]);

    useEffect(() => {
        if (!autoplay || reducedMotion) return;
        if (typeof requestAnimationFrame !== 'function') return;

        const tick = (now: number) => {
            if (startRef.current == null) startRef.current = now;
            const nextElapsed = ((now - startRef.current) * speed) % scenario.durationMs;
            setElapsed(nextElapsed);
            rafRef.current = requestAnimationFrame(tick);
        };

        rafRef.current = requestAnimationFrame(tick);
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        };
    }, [autoplay, reducedMotion, scenario.durationMs, speed]);

    return {
        elapsed,
        progress: elapsed / scenario.durationMs,
        activeBeat,
        state: activeBeat.state,
        focus: activeBeat.focus,
        reducedMotion,
    };
}
