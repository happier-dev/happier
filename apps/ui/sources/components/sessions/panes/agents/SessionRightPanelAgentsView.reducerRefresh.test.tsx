import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (
            params ? `${key}(${Object.values(params).join(',')})` : key
        ),
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
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

let SessionRightPanelAgentsView: typeof import('./SessionRightPanelAgentsView')['SessionRightPanelAgentsView'];
let storage: typeof import('@/sync/domains/state/storageStore')['storage'];
let testkit: typeof import('@/dev/testkit');
let fixture: ReturnType<typeof import('@/dev/testkit')['makeSessionAgentActivityFixture']>;
let previousStorageState: ReturnType<(typeof storage)['getState']> | null = null;

const SUBAGENT_KEY = 'alpha';
const SESSION_ID = 's1';
const ROSTER_TEST_ID = 'session-agents-roster';

function seedFixture() {
    fixture = testkit.makeSessionAgentActivityFixture({
        sessionId: SESSION_ID,
        subagents: [{
            key: SUBAGENT_KEY,
            title: 'Audit the auth flow',
            status: 'running',
            activity: 'Reading src/auth/session.ts',
        }],
    });
    storage.setState((state) => ({
        ...state,
        sessions: { ...state.sessions, [fixture.sessionId]: fixture.session },
        sessionMessages: { ...state.sessionMessages, ...fixture.storeSessionMessagesBySessionId },
    }));
}

/**
 * The reducer mutates `reducerState.sidechains` in place and signals the change by bumping
 * `reducerVersion` — exactly what `sync/store/domains/messages.ts` does on every commit
 * (`reducerState: existingSession.reducerState, reducerVersion: (…) + 1`). The reducer state's
 * own identity never changes, which is why the version is the only change signal.
 */
async function appendSidechainMessage(message: Parameters<
    typeof import('@/dev/testkit')['makeAgentActivitySidechainMessage']
>[0]): Promise<void> {
    const sidechainId = testkit.agentActivityFixtureSidechainId(SUBAGENT_KEY);
    await act(async () => {
        fixture.reducerState.sidechains.set(sidechainId, [
            ...(fixture.reducerState.sidechains.get(sidechainId) ?? []),
            testkit.makeAgentActivitySidechainMessage(message),
        ]);
        storage.setState((state) => {
            const session = state.sessionMessages[fixture.sessionId];
            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [fixture.sessionId]: {
                        ...session,
                        reducerState: fixture.reducerState,
                        reducerVersion: (session.reducerVersion ?? 0) + 1,
                    },
                },
            };
        });
        await testkit.flushHookEffects();
    });
}

describe('SessionRightPanelAgentsView reducer refresh', () => {
    beforeAll(async () => {
        testkit = await import('@/dev/testkit');
        ({ storage } = await import('@/sync/domains/state/storageStore'));
        ({ SessionRightPanelAgentsView } = await import('./SessionRightPanelAgentsView'));
    }, 300_000);

    beforeEach(() => {
        previousStorageState = storage.getState();
        seedFixture();
    });

    afterEach(() => {
        testkit.standardCleanup();
        if (previousStorageState) storage.setState(previousStorageState);
        // Each test reseeds the same session id with a fresh transcript, which is the production
        // "transcript memory released and rebuilt" case; without going through the release seam the
        // subagent-source LRU would serve the previous test's messages at the same source version.
        clearSessionTranscriptDerivedCachesForSession(SESSION_ID);
    });

    it('refreshes the activity preview when the reducer sidechain mutates in place', async () => {
        const screen = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={fixture.sessionId} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();

        // The preview is the row's one meta line now, so it is read off the rendered text rather
        // than a dedicated node — which is also the thing a reader actually sees.
        expect(screen.getTextContent()).toContain('Reading src/auth/session.ts');

        await appendSidechainMessage({
            id: `${testkit.agentActivityFixtureSidechainId(SUBAGENT_KEY)}_activity_2`,
            createdAt: 2_000,
            text: 'Editing src/auth/token.ts',
        });

        expect(screen.getTextContent()).toContain('Editing src/auth/token.ts');
        expect(screen.getTextContent()).not.toContain('Reading src/auth/session.ts');
    }, 120_000);

    it('surfaces a permission that arrives on an already-rendered sidechain', async () => {
        const subagentId = testkit.agentActivityFixtureSubagentId(SUBAGENT_KEY);
        const statusTestId = `${ROSTER_TEST_ID}:row:${subagentId}:status`;
        const screen = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={fixture.sessionId} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();

        // A blocked agent is no longer a badge beside the status — it IS the status (`waiting`),
        // and that status word is the entire signal. The row does not move sections and nothing
        // above it changes.
        expect(screen.findByTestId(statusTestId)?.props.accessibilityLabel)
            .toBe('session.agentActivity.status.running');
        expect(screen.findByTestId(`${ROSTER_TEST_ID}:section:working`)).toBeTruthy();

        await appendSidechainMessage({
            id: `${testkit.agentActivityFixtureSidechainId(SUBAGENT_KEY)}_permission`,
            createdAt: 2_000,
            permissionStatus: 'pending',
        });

        expect(screen.findByTestId(statusTestId)?.props.accessibilityLabel)
            .toBe('session.agentActivity.status.waiting');
        expect(screen.findByTestId(`${ROSTER_TEST_ID}:section:needsYou`)).toBeNull();
        expect(screen.findByTestId(`${ROSTER_TEST_ID}:section:working`)).toBeTruthy();
    }, 120_000);
});
