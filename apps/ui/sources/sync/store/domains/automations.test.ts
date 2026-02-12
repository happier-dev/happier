import { describe, expect, it } from 'vitest';

import { createAutomationsDomain } from './automations';

type Automation = {
    id: string;
    name: string;
    enabled: boolean;
    updatedAt: number;
};

type AutomationRun = {
    id: string;
    automationId: string;
    state: 'queued' | 'running' | 'succeeded' | 'failed';
    scheduledAt: number;
    updatedAt: number;
};

type State = ReturnType<typeof createAutomationsDomain>;

function createHarness(): {
    state: State;
    get: () => State;
    set: (updater: (state: State) => State) => void;
} {
    let state = {} as State;
    const get = () => state;
    const set = (updater: (draft: State) => State) => {
        state = updater(state);
    };
    state = createAutomationsDomain({ get, set } as any);
    return { state, get, set };
}

function automation(input: Partial<Automation> & Pick<Automation, 'id'>): Automation {
    return {
        id: input.id,
        name: input.name ?? input.id,
        enabled: input.enabled ?? true,
        updatedAt: input.updatedAt ?? 1,
    };
}

function run(input: Partial<AutomationRun> & Pick<AutomationRun, 'id' | 'automationId'>): AutomationRun {
    return {
        id: input.id,
        automationId: input.automationId,
        state: input.state ?? 'queued',
        scheduledAt: input.scheduledAt ?? 1,
        updatedAt: input.updatedAt ?? 1,
    };
}

describe('createAutomationsDomain', () => {
    it('initializes with empty automation state', () => {
        const harness = createHarness();
        expect(harness.get().automations).toEqual({});
        expect(harness.get().automationRunsByAutomationId).toEqual({});
    });

    it('replaces automations map when applying a snapshot', () => {
        const harness = createHarness();
        harness.get().applyAutomations([automation({ id: 'a1' }), automation({ id: 'a2' })] as any);
        expect(Object.keys(harness.get().automations).sort()).toEqual(['a1', 'a2']);

        harness.get().applyAutomations([automation({ id: 'a3' })] as any);
        expect(Object.keys(harness.get().automations).sort()).toEqual(['a3']);
    });

    it('upserts and removes automations', () => {
        const harness = createHarness();
        harness.get().upsertAutomation(automation({ id: 'a1', name: 'Nightly' }) as any);
        expect(harness.get().automations.a1?.name).toBe('Nightly');

        harness.get().upsertAutomation(automation({ id: 'a1', name: 'Hourly', updatedAt: 2 }) as any);
        expect(harness.get().automations.a1?.name).toBe('Hourly');

        harness.get().removeAutomation('a1');
        expect(harness.get().automations.a1).toBeUndefined();
    });

    it('tracks runs per automation and keeps newest first', () => {
        const harness = createHarness();
        harness.get().setAutomationRuns('a1', [
            run({ id: 'r1', automationId: 'a1', scheduledAt: 10 }),
            run({ id: 'r2', automationId: 'a1', scheduledAt: 20 }),
        ] as any);

        expect(harness.get().automationRunsByAutomationId.a1?.map((entry) => entry.id)).toEqual(['r2', 'r1']);

        harness.get().upsertAutomationRun(
            run({ id: 'r3', automationId: 'a1', scheduledAt: 30, state: 'running' }) as any,
        );
        expect(harness.get().automationRunsByAutomationId.a1?.map((entry) => entry.id)).toEqual(['r3', 'r2', 'r1']);

        harness.get().upsertAutomationRun(
            run({ id: 'r2', automationId: 'a1', scheduledAt: 40, state: 'succeeded' }) as any,
        );
        expect(harness.get().automationRunsByAutomationId.a1?.map((entry) => entry.id)).toEqual(['r2', 'r3', 'r1']);
        expect(harness.get().automationRunsByAutomationId.a1?.[0]?.state).toBe('succeeded');
    });

    it('removes run cache when automation is removed', () => {
        const harness = createHarness();
        harness.get().upsertAutomation(automation({ id: 'a1' }) as any);
        harness.get().setAutomationRuns('a1', [run({ id: 'r1', automationId: 'a1' })] as any);

        harness.get().removeAutomation('a1');
        expect(harness.get().automationRunsByAutomationId.a1).toBeUndefined();
    });
});
