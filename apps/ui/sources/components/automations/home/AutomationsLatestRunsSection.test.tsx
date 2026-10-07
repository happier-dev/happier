import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationDefinitionListItemSchema, AutomationV3RunListItemSchema } from '@happier-dev/protocol';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createAutomationDefinitionSummary } from '@/sync/domains/automations/automationDefinitionProjection';
import type { AutomationDefinition, AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Automations server, behind the sync orchestrator (the network boundary): what a refresh returns,
 * and each Automation's first Run page. Both land in the real store, as the real transport does.
 */
const server = vi.hoisted(() => ({
    automations: [] as unknown[],
    runsByAutomationId: {} as Record<string, unknown[]>,
    fail: false,
    pending: null as null | Promise<void>,
    refreshes: 0,
    runReads: [] as string[],
    pushed: [] as unknown[],
    featureState: 'enabled' as 'enabled' | 'disabled',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: (route: unknown) => { server.pushed.push(route); } } }).module;
});
// The server's feature answer for Automations on this Home.
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: server.featureState }),
}));
// The store boundary: a real zustand store running the real Automation and Run domains (the same
// harness the domain tests use), without the whole app store graph.
vi.mock('@/sync/domains/state/storageStore', async () => {
    const { create } = await import('zustand');
    const { createAutomationsDomain } = await import('@/sync/store/domains/automations');
    const { createWorkflowRunsDomain } = await import('@/sync/store/domains/workflowRuns');
    type DomainArgs = Parameters<typeof createAutomationsDomain>[0];
    const store = create<Record<string, unknown>>()((set, get) => {
        const args = { set, get } as unknown as DomainArgs;
        return {
            isDataReady: true,
            // Row metrics read the reader's list density straight from the store's local settings.
            localSettings: { uiItemDensity: 'cozy' },
            ...createWorkflowRunsDomain(args as never),
            ...createAutomationsDomain(args),
        };
    });
    return { storage: store, getStorage: () => store };
});
vi.mock('@/sync/domains/state/storage', async () => {
    const ReactModule = await import('react');
    const { storage: store } = await import('@/sync/domains/state/storageStore');
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: createUseLocalSettingMock({ values: { uiItemDensity: 'cozy' } }),
        useAutomations: () => {
            const byId = (store as unknown as (selector: (state: { automations: Record<string, AutomationDefinition> }) => unknown) => Record<string, AutomationDefinition>)(
                (state) => state.automations,
            );
            return ReactModule.useMemo(() => Object.values(byId), [byId]);
        },
    });
});
vi.mock('@/sync/sync', async () => {
    const { storage: store } = await import('@/sync/domains/state/storageStore');
    return {
        sync: {
            refreshAutomations: async () => {
                server.refreshes += 1;
                if (server.pending) await server.pending;
                if (server.fail) throw new Error('offline');
                store.getState().applyAutomations(server.automations as AutomationDefinition[], null);
            },
            fetchAutomationRuns: async (automationId: string) => {
                server.runReads.push(automationId);
                if (server.fail) throw new Error('offline');
                store.getState().setAutomationRuns(
                    automationId,
                    (server.runsByAutomationId[automationId] ?? []) as AutomationDefinitionRun[],
                    null,
                );
                return { nextCursor: null };
            },
        },
    };
});

function automation(id: string, name: string, lastRunAt: number | null): AutomationDefinition {
    return createAutomationDefinitionSummary(AutomationDefinitionListItemSchema.parse({
        id,
        name,
        description: null,
        enabled: true,
        triggers: [],
        targetType: 'newSession',
        existingSessionId: null,
        templateVersion: 1,
        lastRunAt,
        createdAt: 1,
        updatedAt: 1,
        assignments: [],
    }));
}

function run(id: string, automationId: string, at: number, state: AutomationDefinitionRun['state']): AutomationDefinitionRun {
    return AutomationV3RunListItemSchema.parse({
        id,
        automationId,
        revision: 1,
        triggerId: null,
        triggerRetired: false,
        state,
        cause: { kind: 'manual', invokedAt: at },
        dueAt: at,
        claimedAt: null,
        startedAt: null,
        finishedAt: null,
        claimedByMachineId: null,
        leaseExpiresAt: null,
        attempt: 0,
        errorCode: null,
        producedSessionId: null,
        executionDispatchState: null,
        executionAttempt: 0,
        replyHandoffState: 'none',
        replyHandoffAttempt: 0,
        replyHandoffDueAt: null,
        createdAt: at,
        updatedAt: at,
    });
}

function serveTwoAutomations() {
    server.automations = [automation('triage', 'Morning triage', 2_000), automation('deps', 'Nightly deps', 1_000)];
    server.runsByAutomationId = {
        triage: [run('t2', 'triage', 2_000, 'succeeded'), run('t1', 'triage', 500, 'succeeded')],
        deps: [run('d1', 'deps', 1_000, 'failed')],
    };
}

afterEach(() => {
    standardCleanup();
    vi.restoreAllMocks();
    act(() => {
        storage.getState().applyAutomations([], null);
    });
    server.automations = [];
    server.runsByAutomationId = {};
    server.fail = false;
    server.pending = null;
    server.refreshes = 0;
    server.runReads = [];
    server.pushed = [];
    server.featureState = 'enabled';
});

async function renderSection() {
    const { AutomationsLatestRunsSection } = await import('./AutomationsLatestRunsSection');
    const screen = await renderScreen(<AutomationsLatestRunsSection menu="menu:here" />);
    await flushHookEffects({ cycles: 4 });
    return screen;
}

describe('Automations · Latest runs on Home', () => {
    it('draws a done Run quietly in the ink, a failed one (glyph and line) in rose, one to look at in attention amber', async () => {
        const { LatestRunRow } = await import('./AutomationsLatestRunsSection');
        const { automationRunTone } = await import('./latestAutomationRuns');
        const { lightTheme } = await import('@/theme');
        const glyphOf = async (state: AutomationDefinitionRun['state'], glyph: string) => {
            const screen = await renderScreen(
                <LatestRunRow
                    row={{ run: run(state, 'triage', 1_000, state), automationName: 'Morning triage', targetType: 'newSession', at: 1_000, tone: automationRunTone(state) }}
                    onOpen={() => {}}
                />,
            );
            const icon = screen.tree.root.findAll((node) => node.props.name === glyph)[0];
            const item = screen.tree.root.findAll((node) => node.props.testID === `home-automations.run.${state}` && 'subtitle' in node.props)[0];
            return { color: icon?.props.color as string | undefined, subtitleStyle: item?.props.subtitleStyle as { color?: string } | undefined };
        };

        const done = await glyphOf('succeeded', 'check-circle');
        expect(done.color).toBe(lightTheme.colors.text.secondary);
        expect(done.subtitleStyle).toBeUndefined();
        const failed = await glyphOf('failed', 'x-circle');
        expect(failed.color).toBe(lightTheme.colors.state.danger.foreground);
        expect(failed.subtitleStyle?.color).toBe(lightTheme.colors.state.danger.foreground);
        expect((await glyphOf('outcome_uncertain', 'warning-circle')).color).toBe(lightTheme.colors.state.attention.foreground);
    });

    it('keeps run times short and relative, in the rows\' meta column rather than inside the state line', async () => {
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now);
        server.automations = [automation('triage', 'Morning triage', now - 12 * 60_000)];
        server.runsByAutomationId = { triage: [run('recent', 'triage', now - 12 * 60_000, 'succeeded')] };
        const screen = await renderSection();
        expect(screen.getTextContent()).toContain('12m');
        const item = screen.tree.root.findAll((node) => node.props.testID === 'home-automations.run.recent' && 'subtitle' in node.props)[0];
        expect(item?.props.detail).toBe('12m');
        expect(String(item?.props.subtitle)).not.toContain('12m');
    });
    it('shows the newest Runs across Automations, with when they were read and a way to Automations', async () => {
        serveTwoAutomations();
        const screen = await renderSection();

        const text = screen.getTextContent();
        expect(text.indexOf('Morning triage')).toBeLessThan(text.indexOf('Nightly deps'));
        expect(screen.findByTestId('home-automations.run.t2')).toBeTruthy();
        expect(screen.findByTestId('home-automations.run.d1')).toBeTruthy();
        expect(screen.findByTestId('home-automations.run.t1')).toBeTruthy();
        expect(screen.findByTestId('home-automations.asOf')).toBeTruthy();
        // Only the Automations the rows can come from are read.
        expect([...server.runReads].sort()).toEqual(['deps', 'triage']);

        screen.pressByTestId('home-automations.open');
        expect(server.pushed).toEqual(['/automations']);
        screen.pressByTestId('home-automations.run.d1');
        expect(server.pushed.at(-1)).toMatchObject({ params: expect.objectContaining({ runId: 'd1' }) });
    });

    it('reserves its rows until the first read answers, then says what will appear when nothing has run', async () => {
        let release: () => void = () => {};
        server.pending = new Promise<void>((resolve) => { release = resolve; });
        server.automations = [automation('fresh', 'Weekly notes', null)];
        const screen = await renderSection();
        expect(screen.findByTestId('home-automations.loading')).toBeTruthy();

        await act(async () => { release(); });
        await flushHookEffects({ cycles: 4 });
        expect(screen.findByTestId('home-automations.loading')).toBeNull();
        expect(screen.findByTestId('home-automations.empty')).toBeTruthy();
    });

    it('answers from Automations this device already knows while its refresh is still out', async () => {
        server.pending = new Promise<void>(() => {});
        act(() => {
            storage.getState().applyAutomations([automation('known', 'Weekly notes', null)], null);
        });
        const screen = await renderSection();
        // Nothing has run: that is known now, so no skeleton stands in for it.
        expect(screen.findByTestId('home-automations.loading')).toBeNull();
        expect(screen.findByTestId('home-automations.empty')).toBeTruthy();
    });

    it('offers Try again when the first read fails, and recovers in place', async () => {
        server.fail = true;
        const screen = await renderSection();
        expect(screen.findByTestId('home-automations.error')).toBeTruthy();

        server.fail = false;
        serveTwoAutomations();
        screen.pressByTestId('home-automations.error-action');
        await flushHookEffects({ cycles: 6 });
        expect(screen.findByTestId('home-automations.error')).toBeNull();
        expect(screen.findByTestId('home-automations.run.t2')).toBeTruthy();
    });

    it('keeps the last-known Runs when its refresh fails, with the reason and Retry in place of Open', async () => {
        // What this device already read (the app's startup load), then a refresh that cannot answer.
        serveTwoAutomations();
        act(() => {
            storage.getState().applyAutomations(server.automations as AutomationDefinition[], null);
            for (const [automationId, runs] of Object.entries(server.runsByAutomationId)) {
                storage.getState().setAutomationRuns(automationId, runs as AutomationDefinitionRun[], null);
            }
        });
        server.fail = true;
        const screen = await renderSection();

        expect(screen.findByTestId('home-automations.loading')).toBeNull();
        expect(screen.findByTestId('home-automations.run.t2')).toBeTruthy();
        expect(screen.findByTestId('home-automations.stale')).toBeTruthy();
        expect(screen.findByTestId('home-automations.open')).toBeNull();

        server.fail = false;
        screen.pressByTestId('home-automations.stale-action');
        await flushHookEffects({ cycles: 6 });
        expect(screen.findByTestId('home-automations.stale')).toBeNull();
        expect(screen.findByTestId('home-automations.open')).toBeTruthy();
    });

    it('is absent where this Home has Automations turned off', async () => {
        server.featureState = 'disabled';
        serveTwoAutomations();
        const screen = await renderSection();
        expect(screen.findByTestId('home-automations')).toBeNull();
        expect(server.refreshes).toBe(0);
    });
});
