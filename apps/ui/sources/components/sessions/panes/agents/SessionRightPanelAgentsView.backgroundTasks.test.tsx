import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The deciding check for R-9's UI half: a real background command reaches the Agents pane as a
 * NAMED row carrying its redacted label, its detail states only attested fields, and that detail
 * deep-links to the `Bash` card that launched it.
 *
 * It runs the pane over real store state and the real record→entry derivation. Only two genuine
 * boundaries are mocked: the system-record transport the CLI writes through, and the router.
 */

const SESSION_ID = 'bg-session';
const ROSTER_TEST_ID = 'session-agents-roster';
const TASK_ID = 'task_bg_1';
const REDACTED_LABEL = 'curl -H "Authorization: [REDACTED]" https://example.test';
const LAUNCH_SEQ = 12;

const routerPush = vi.hoisted(() => vi.fn());
const routerNavigate = vi.hoisted(() => vi.fn());
const listSessionSystemRecords = vi.hoisted(() => vi.fn());

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
    return createExpoRouterMock({
        pathname: () => `/session/${SESSION_ID}`,
        router: { push: routerPush, navigate: routerNavigate },
    }).module;
});

// Genuine system boundaries: the sync façade, the execution-run RPCs, the system-record transport.
vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(async () => 'loaded' as const),
        getSyncTuning: () => ({ sidechainDemandHydrationConcurrencyLimit: 2 }),
        sendMessage: vi.fn(async () => undefined),
        submitMessage: vi.fn(async () => undefined),
        encryption: { getSessionEncryption: () => null },
    },
}));

vi.mock('@/sync/ops/sessionSystemRecords', () => ({
    listSessionSystemRecords,
    fetchSessionSystemRecord: vi.fn(async () => null),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunList: vi.fn(async () => ({ ok: true, runs: [] })),
    sessionExecutionRunStop: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({ openDetailsTab: vi.fn() }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => false }));
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
    useDirectSessionRuntime: () => ({ directSessionLink: null, status: null, refreshNow: async () => null }),
}));

let SessionRightPanelAgentsView: typeof import('./SessionRightPanelAgentsView')['SessionRightPanelAgentsView'];
let storage: typeof import('@/sync/domains/state/storageStore')['storage'];
let testkit: typeof import('@/dev/testkit');
let previousStorageState: ReturnType<(typeof storage)['getState']> | null = null;

function backgroundTaskRecordPage(overrides: Record<string, unknown> = {}) {
    return {
        records: [{
            namespace: 'activity',
            kind: 'background_task.v1',
            localId: `activity:background_task:v1:${TASK_ID}`,
            content: {
                t: 'plain',
                v: {
                    v: 1,
                    taskId: TASK_ID,
                    kind: 'command',
                    status: 'succeeded',
                    label: REDACTED_LABEL,
                    startedAt: 1_700_000_000_000,
                    endedAt: 1_700_000_016_000,
                    summary: 'Background command completed',
                    updatedAt: 1_700_000_016_000,
                    ...overrides,
                },
            },
        }],
        nextCursor: null,
        hasNext: false,
    };
}

/** The transcript card that launched the command: a backgrounded `Bash` whose result carries the id. */
function launchingBashMessage(withTaskId: boolean) {
    return testkit.createToolCallMessageFixture({
        id: 'msg_bash_launch',
        seq: LAUNCH_SEQ,
        createdAt: 1_700_000_000_000,
        tool: {
            id: 'toolu_bash_1',
            name: 'Bash',
            state: 'completed',
            input: { command: 'curl -H "Authorization: Bearer secret" https://example.test', run_in_background: true },
            createdAt: 1_700_000_000_000,
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_000_500,
            description: null,
            result: withTaskId
                ? { tool_use_result: { stdout: '', backgroundTaskId: TASK_ID } }
                : { tool_use_result: { stdout: '' } },
        },
    } as never);
}

async function seedAndRender(params: Readonly<{ withLaunchCard: boolean }>) {
    const launch = launchingBashMessage(params.withLaunchCard);
    const fixture = testkit.makeSessionAgentActivityFixture({
        sessionId: SESSION_ID,
        // A projection that has left the zero baseline is what tells the roster there is background
        // work to read at all.
        session: { runtimeActivityState: 'active', runtimeActivityActiveCount: 1, runtimeActivityRevision: 3 },
    });
    const sessionMessages = {
        ...fixture.sessionMessages,
        messageIdsOldestFirst: [launch.id],
        messagesById: { [launch.id]: launch },
        messagesMap: { [launch.id]: launch },
    };
    storage.setState((state) => ({
        ...state,
        sessions: { ...state.sessions, [SESSION_ID]: fixture.session },
        sessionMessages: { ...state.sessionMessages, [SESSION_ID]: sessionMessages },
    }) as never);

    const screen = await testkit.renderScreen(
        <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:bg" />,
    );
    await testkit.flushHookEffects();
    return screen;
}

describe('SessionRightPanelAgentsView background tasks', () => {
    beforeAll(async () => {
        testkit = await import('@/dev/testkit');
        ({ storage } = await import('@/sync/domains/state/storageStore'));
        ({ SessionRightPanelAgentsView } = await import('./SessionRightPanelAgentsView'));
    }, 300_000);

    beforeEach(() => {
        previousStorageState = storage.getState();
        routerPush.mockReset();
        routerNavigate.mockReset();
        listSessionSystemRecords.mockReset();
        listSessionSystemRecords.mockResolvedValue(backgroundTaskRecordPage());
    });

    afterEach(() => {
        testkit.standardCleanup();
        if (previousStorageState) storage.setState(previousStorageState);
        clearSessionTranscriptDerivedCachesForSession(SESSION_ID);
    });

    it('renders a real background command as a named row and deep-links its detail to the Bash card', async () => {
        const screen = await seedAndRender({ withLaunchCard: true });

        // Named: the redacted label the CLI persisted, not "working in background".
        expect(screen.getTextContent()).toContain(REDACTED_LABEL);
        const row = screen.findByTestId(`${ROSTER_TEST_ID}:row:background_task:${TASK_ID}`);
        expect(row).not.toBeNull();
        // Terminal state reached from record evidence, never from elapsed time (§4.9.3).
        expect(
            screen.findByTestId(`${ROSTER_TEST_ID}:row:background_task:${TASK_ID}:status`)?.props.accessibilityLabel,
        ).toBe('session.agentActivity.status.succeeded');

        const detailTestId = `${ROSTER_TEST_ID}:background-task:${TASK_ID}`;
        expect(screen.findByTestId(detailTestId)).toBeNull();
        await act(async () => {
            (row!.props as { onPress?: () => void }).onPress?.();
        });
        expect(screen.findByTestId(detailTestId)).not.toBeNull();

        await act(async () => {
            screen.findByTestId(`${detailTestId}:open-command`)?.props.onPress();
        });
        expect(routerNavigate).toHaveBeenCalledWith(`/session/${SESSION_ID}?jumpSeq=${LAUNCH_SEQ}`, expect.any(Object));

        await screen.unmount();
    });

    it('offers no deep link when this client cannot point at the launching card', async () => {
        // The record alone cannot name a message. Without the provider task id on a Bash result
        // there is no honest target, and a control that leads nowhere must not render (A9).
        const screen = await seedAndRender({ withLaunchCard: false });

        const row = screen.findByTestId(`${ROSTER_TEST_ID}:row:background_task:${TASK_ID}`);
        await act(async () => {
            (row!.props as { onPress?: () => void }).onPress?.();
        });
        const detailTestId = `${ROSTER_TEST_ID}:background-task:${TASK_ID}`;
        expect(screen.findByTestId(detailTestId)).not.toBeNull();
        expect(screen.findByTestId(`${detailTestId}:open-command`)).toBeNull();

        await screen.unmount();
    });
});
