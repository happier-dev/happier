import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '../cleanup/standardCleanup';
import { flushHookEffects } from '../hooks/flushHookEffects';
import { createSessionMessagesHooksMock } from '../mocks/sessionMessagesHooks';
import { createStorageModuleStub } from '../mocks/storage';
import { renderScreen } from '../render/renderScreen';
import {
    agentActivityFixtureSubagentId,
    executionRunFixtureSubagentId,
    makeSessionAgentActivityFixture,
} from './agentActivityFixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('../mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('../mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('../mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('../mocks/text');
    return createTextModuleMock({
        // Interpolated keys must stay renderable strings; the default mock returns `{key, params}`.
        translate: (key: string, params?: Record<string, unknown>) => (
            params ? `${key}(${Object.values(params).join(',')})` : key
        ),
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('../mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/s1' }).module;
});

// Genuine system boundaries: the sync façade and the execution-run RPC.
vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(async () => 'loaded' as const),
        getSyncTuning: () => ({ sidechainDemandHydrationConcurrencyLimit: 2 }),
        sendMessage: vi.fn(async () => undefined),
    },
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunList: vi.fn(async () => ({ ok: true, runs: [] })),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({ openDetailsTab: vi.fn() }),
}));

// Server-reported capability / runtime probes: remote state, not the session state under test.
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: () => false,
}));

vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
    useExecutionRunsBackendsForSession: () => null,
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable: true,
        machineOnline: true,
        machineRpcTargetAvailable: true,
    }),
}));

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => null,
}));

vi.mock('@/components/sessions/model/useDirectSessionRuntime', () => ({
    useDirectSessionRuntime: () => ({
        directSessionLink: null,
        status: null,
        refreshNow: async () => null,
    }),
}));

const ROSTER_TEST_ID = 'session-agents-roster';

const fixture = makeSessionAgentActivityFixture({
    sessionId: 's1',
    subagents: [
        {
            key: 'alpha',
            title: 'Audit the auth flow',
            status: 'running',
            activity: 'Reading src/auth/session.ts',
            pendingPermission: true,
        },
        { key: 'beta', title: 'Draft the migration', status: 'running', activity: 'Writing migration plan' },
        { key: 'gamma', title: 'Tidy imports', status: 'succeeded' },
        { key: 'delta', title: 'Broken sweep', status: 'failed' },
    ],
    executionRuns: [
        { runId: 'run_11111111', label: 'Code review', intent: 'review', backendId: 'codex', status: 'running' },
    ],
});

let SessionRightPanelAgentsView: typeof import(
    '@/components/sessions/panes/agents/SessionRightPanelAgentsView'
)['SessionRightPanelAgentsView'];
let storage: typeof import('@/sync/domains/state/storageStore')['storage'];
let previousStorageState: ReturnType<(typeof storage)['getState']> | null = null;

describe('agent activity testkit fixtures', () => {
    beforeAll(async () => {
        ({ storage } = await import('@/sync/domains/state/storageStore'));
        ({ SessionRightPanelAgentsView } = await import(
            '@/components/sessions/panes/agents/SessionRightPanelAgentsView'
        ));
    }, 300_000);

    beforeEach(() => {
        previousStorageState = storage.getState();
        storage.setState((state) => ({
            ...state,
            sessions: { ...state.sessions, [fixture.sessionId]: fixture.session },
            sessionMessages: { ...state.sessionMessages, ...fixture.storeSessionMessagesBySessionId },
        }));
    });

    afterEach(() => {
        standardCleanup();
        if (previousStorageState) storage.setState(previousStorageState);
    });

    it('renders a live agent roster with an activity preview through the canonical testkit', async () => {
        const screen = await renderScreen(
            <SessionRightPanelAgentsView sessionId={fixture.sessionId} scopeId="session:s1" />,
        );
        // The real execution-run poller resolves after the first paint; settle it before asserting.
        await flushHookEffects();

        // Derivation, not a hand-shaped roster: the rows exist because `deriveSessionSubagents`
        // recognised the fixture's transcript tool calls.
        expect(screen.findByTestId(`${ROSTER_TEST_ID}:row:${agentActivityFixtureSubagentId('alpha')}`)).toBeTruthy();
        expect(screen.findByTestId(`${ROSTER_TEST_ID}:row:${agentActivityFixtureSubagentId('gamma')}`)).toBeTruthy();
        expect(screen.findByTestId(`${ROSTER_TEST_ID}:row:${executionRunFixtureSubagentId('run_11111111')}`)).toBeTruthy();

        // The live activity preview comes from the fixture's reducer sidechain entries and lands in
        // the row's single meta line.
        expect(screen.getTextContent()).toContain('Reading src/auth/session.ts');
        expect(screen.getTextContent()).toContain('Writing migration plan');

        // Assorted states are reachable, including the attention-carrying pending permission —
        // which is a status now (`waiting`), not a badge beside one.
        expect(
            screen.findByTestId(`${ROSTER_TEST_ID}:row:${agentActivityFixtureSubagentId('alpha')}:status`)?.props.accessibilityLabel,
        ).toBe('session.agentActivity.status.waiting');
        expect(
            screen.findByTestId(`${ROSTER_TEST_ID}:row:${agentActivityFixtureSubagentId('beta')}:status`)?.props.accessibilityLabel,
        ).toBe('session.agentActivity.status.running');
        expect(
            screen.findByTestId(`${ROSTER_TEST_ID}:row:${agentActivityFixtureSubagentId('delta')}:status`)?.props.accessibilityLabel,
        ).toBe('session.agentActivity.status.failed');
    }, 120_000);

    it('lets the canonical storage stub express live session state', () => {
        const stub = createStorageModuleStub({
            ...createSessionMessagesHooksMock({ bySessionId: fixture.sessionMessagesBySessionId }),
        });

        expect(stub.useSessionMessages(fixture.sessionId).messages).toHaveLength(fixture.messages.length);
        expect(stub.useSessionMessagesReducerState(fixture.sessionId)).toBe(fixture.reducerState);
        expect(stub.useSessionSubagentSourceMessages(fixture.sessionId)).toHaveLength(fixture.messages.length);
        // Referential stability: agent surfaces put these results into `useMemo` dependency arrays.
        expect(stub.useSessionMessages(fixture.sessionId)).toBe(stub.useSessionMessages(fixture.sessionId));
    });

    it('keeps the storage stub defaults empty for sessions no fixture configured', () => {
        const stub = createStorageModuleStub({});

        expect(stub.useSessionMessages('unknown-session')).toEqual({ messages: [], isLoaded: true });
        expect(stub.useSessionMessagesReducerState('unknown-session')).toBeNull();
        expect(stub.useSessionSubagentSourceMessages('unknown-session')).toEqual([]);
    });
});
