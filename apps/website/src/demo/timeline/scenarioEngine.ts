import type {
    DemoBridgeState,
    ScenarioBeat,
    ScenarioDefinition,
    ScenarioEvent,
} from './scenarioTypes';

type ScenarioEngineOptions = Readonly<{
    onEvent?: (event: ScenarioEvent, beat: ScenarioBeat) => void;
}>;

export type ScenarioEngine = Readonly<{
    seek: (elapsedMs: number) => ScenarioBeat;
    getBeat: () => ScenarioBeat;
    /**
     * Returns the merged bridge-state snapshot. The earlier marketing demo
     * pushed this into a sibling `apps/demo` web component; today nothing
     * reads it but a few legacy tests still inspect it for transcript
     * fixtures, so we keep the merge cheap and loose.
     */
    getState: () => DemoBridgeState;
}>;

function findBeatIndex(scenario: ScenarioDefinition, elapsedMs: number): number {
    // Pick the beat with the largest atMs <= elapsedMs. We deliberately do
    // NOT break early on the first out-of-order beat: scenarios are authored
    // in narrative order (e.g. "step-away" before "finished-notif") even
    // when their atMs aren't monotonic, so the loop has to scan all beats
    // and let the largest matching atMs win.
    let index = 0;
    let bestAt = -1;
    for (let i = 0; i < scenario.beats.length; i++) {
        const at = scenario.beats[i].atMs;
        if (at <= elapsedMs && at >= bestAt) {
            bestAt = at;
            index = i;
        }
    }
    return index;
}

function applyBeatState(
    baseState: DemoBridgeState,
    beat: ScenarioBeat,
): DemoBridgeState {
    const baseTerminal = (baseState as Record<string, unknown>).terminal as
        | { lines?: unknown; commands?: unknown }
        | undefined;
    const nextTerminal = beat.terminal
        ? {
              ...(baseTerminal ?? {}),
              lines: beat.terminal.lines,
              commands: beat.terminal.commands ?? baseTerminal?.commands,
          }
        : baseTerminal;

    return {
        ...baseState,
        beatId: beat.id,
        terminal: nextTerminal,
        syncPulseKey: beat.state?.syncPulseKey ?? (baseState as Record<string, unknown>).syncPulseKey,
        ...(beat.bridgePatch ?? {}),
    };
}

export function createScenarioEngine(
    scenario: ScenarioDefinition,
    options: ScenarioEngineOptions = {},
): ScenarioEngine {
    let activeIndex = 0;
    let state = applyBeatState(scenario.initialBridgeState, scenario.beats[0]);
    const firedEvents = new Set<string>();

    const fireEvents = (beat: ScenarioBeat) => {
        for (const event of beat.events ?? []) {
            const key = `${beat.id}:${event.id}`;
            if (firedEvents.has(key)) continue;
            firedEvents.add(key);
            options.onEvent?.(event, beat);
        }
    };

    return {
        seek: (elapsedMs) => {
            const normalizedMs =
                ((elapsedMs % scenario.durationMs) + scenario.durationMs) %
                scenario.durationMs;
            const nextIndex = findBeatIndex(scenario, normalizedMs);
            if (nextIndex < activeIndex || elapsedMs < scenario.beats[activeIndex].atMs) {
                firedEvents.clear();
                state = scenario.initialBridgeState;
            }
            activeIndex = nextIndex;
            const beat = scenario.beats[activeIndex];
            state = applyBeatState(state, beat);
            fireEvents(beat);
            return beat;
        },
        getBeat: () => scenario.beats[activeIndex],
        getState: () => state,
    };
}
