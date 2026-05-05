import { describe, expect, it } from 'vitest';
import { createScenarioEngine } from './scenarioEngine';
import type { ScenarioDefinition } from './scenarioTypes';
import { createBeat } from '../scenarios/scenarioFixtures';

const scenario = {
    id: 'handoff',
    title: 'Handoff',
    durationMs: 3_000,
    totalDuration: 3_000,
    initialBridgeState: {
        scenarioId: 'handoff',
        beatId: 'boot',
        activeView: 'phone-session',
        sessions: [],
        messagesBySession: {},
        machines: [],
        profile: null,
        activeSessionId: null,
        permissionsBySession: {},
        terminal: { lines: [], commands: [] },
    },
    beats: [
        createBeat({
            id: 'boot',
            atMs: 0,
            durationMs: 1_000,
            focus: 'all',
            visibleSurfaces: ['phone-session'],
            bridgePatch: { beatId: 'boot' },
        }),
        createBeat({
            id: 'approval',
            atMs: 1_000,
            durationMs: 1_000,
            focus: 'phone',
            visibleSurfaces: ['phone-session', 'terminal'],
            bridgePatch: { beatId: 'approval', activeView: 'phone-session' },
            events: [{ id: 'pulse-approval', type: 'sync-pulse' }],
        }),
    ],
} satisfies ScenarioDefinition;

describe('scenario engine', () => {
    it('applies each crossed beat exactly once', () => {
        const fired: string[] = [];
        const engine = createScenarioEngine(scenario, {
            onEvent: (event) => fired.push(event.id),
        });

        engine.seek(1_100);
        engine.seek(1_200);

        expect(engine.getState().beatId).toBe('approval');
        expect(fired).toEqual(['pulse-approval']);
    });

    it('resets deterministically when the timeline loops', () => {
        const engine = createScenarioEngine(scenario);

        engine.seek(1_100);
        engine.seek(100);

        expect(engine.getState().beatId).toBe('boot');
    });
});
