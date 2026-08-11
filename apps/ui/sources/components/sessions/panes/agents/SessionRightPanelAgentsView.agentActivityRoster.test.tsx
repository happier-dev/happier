import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT } from '@/components/sessions/agentActivity/list/agentActivitySectionModel';
import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The deciding check for the Agents pane swap: the pane renders the ONE agent-activity row, from
 * real derivation over real store state, with a translated status word and a live elapsed value —
 * and the row the pane used to hand-roll is gone.
 *
 * It runs on the real storage store and the canonical agent-activity fixtures rather than a
 * hand-shaped roster, because a roster stated directly in the test would pass whether or not
 * `deriveSessionSubagents` still reaches this surface.
 */

const STATUS_WORDS: Readonly<Record<string, string>> = {
    'session.agentActivity.status.queued': 'Queued',
    'session.agentActivity.status.starting': 'Starting',
    'session.agentActivity.status.running': 'Running',
    'session.agentActivity.status.waiting': 'Awaiting approval',
    'session.agentActivity.status.blocked': 'Blocked',
    'session.agentActivity.status.succeeded': 'Succeeded',
    'session.agentActivity.status.failed': 'Failed',
    'session.agentActivity.status.timedOut': 'Timed out',
    'session.agentActivity.status.cancelled': 'Cancelled',
    'session.agentActivity.status.unknown': 'Unknown',
};

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
            STATUS_WORDS[key] ?? (params ? `${key}(${Object.values(params).join(',')})` : key)
        ),
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/s1' }).module;
});

// Genuine system boundaries: the sync façade and the execution-run RPCs.
vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(async () => 'loaded' as const),
        getSyncTuning: () => ({ sidechainDemandHydrationConcurrencyLimit: 2 }),
        sendMessage: vi.fn(async () => undefined),
        submitMessage: vi.fn(async () => undefined),
    },
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunList: vi.fn(async () => ({ ok: true, runs: [] })),
    sessionExecutionRunStop: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({ openDetailsTab: vi.fn() }),
}));

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
const SESSION_ID = 's1';

let SessionRightPanelAgentsView: typeof import('./SessionRightPanelAgentsView')['SessionRightPanelAgentsView'];
let storage: typeof import('@/sync/domains/state/storageStore')['storage'];
let testkit: typeof import('@/dev/testkit');
let previousStorageState: ReturnType<(typeof storage)['getState']> | null = null;

/** The entry array the pane hands the one list — the object row memoization depends on (INV-4). */
function readRosterEntries(
    screen: Awaited<ReturnType<(typeof testkit)['renderScreen']>>,
): readonly unknown[] {
    const list = screen
        .findAllByTestId(ROSTER_TEST_ID)
        .find((node) => Array.isArray(node.props?.entries));
    if (!list) throw new Error('expected the agents pane to render one agent-activity list');
    return list.props.entries as readonly unknown[];
}

function seed(fixture: ReturnType<typeof import('@/dev/testkit')['makeSessionAgentActivityFixture']>) {
    storage.setState((state) => ({
        ...state,
        sessions: { ...state.sessions, [fixture.sessionId]: fixture.session },
        sessionMessages: { ...state.sessionMessages, ...fixture.storeSessionMessagesBySessionId },
    }));
}

describe('SessionRightPanelAgentsView agent-activity roster', () => {
    beforeAll(async () => {
        testkit = await import('@/dev/testkit');
        ({ storage } = await import('@/sync/domains/state/storageStore'));
        ({ SessionRightPanelAgentsView } = await import('./SessionRightPanelAgentsView'));
    }, 300_000);

    beforeEach(() => {
        previousStorageState = storage.getState();
    });

    afterEach(() => {
        testkit.standardCleanup();
        if (previousStorageState) storage.setState(previousStorageState);
        // Reseeding one session id with a different roster is exactly "this session's transcript
        // memory was released and rebuilt", so it goes through the production release seam. Without
        // it, `useSessionSubagentSourceMessages`' per-session LRU still holds the previous test's
        // messages at the same `subagentSourceVersion` and silently serves them to the next one.
        clearSessionTranscriptDerivedCachesForSession(SESSION_ID);
    });

    it('renders the roster through AgentActivityRow with a translated status word and a live elapsed value', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [
                { key: 'alpha', title: 'Audit the auth flow', status: 'running', activity: 'Reading src/auth/session.ts' },
                { key: 'beta', title: 'Write the migration', status: 'succeeded' },
            ],
        });
        seed(fixture);

        const screen = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={fixture.sessionId} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();

        const runningId = testkit.agentActivityFixtureSubagentId('alpha');
        const finishedId = testkit.agentActivityFixtureSubagentId('beta');

        expect(screen.findByTestId(`${ROSTER_TEST_ID}:row:${runningId}`)).toBeTruthy();
        expect(screen.findByTestId(`${ROSTER_TEST_ID}:row:${finishedId}`)).toBeTruthy();

        // A1: the status is a translated word, never the raw enum.
        expect(
            screen.findByTestId(`${ROSTER_TEST_ID}:row:${runningId}:status`)?.props.accessibilityLabel,
        ).toBe('Running');
        expect(
            screen.findByTestId(`${ROSTER_TEST_ID}:row:${finishedId}:status`)?.props.accessibilityLabel,
        ).toBe('Succeeded');
        expect(screen.getTextContent()).not.toContain('succeeded');

        // R-4: a running agent shows elapsed time derived from startedAtMs.
        const elapsed = screen.findByTestId(`${ROSTER_TEST_ID}:row:${runningId}:elapsed`);
        expect(elapsed).toBeTruthy();
        expect(String(elapsed?.props.children ?? '')).toMatch(/\d/);

        // The activity preview survives the swap, now as the row's single meta line.
        expect(screen.getTextContent()).toContain('Reading src/auth/session.ts');

        // 9.4 trap 1: the old row must not still be live beside the new one.
        expect(screen.findByTestId(`session-subagent-row:${runningId}`)).toBeNull();
    }, 120_000);

    it('partitions the roster into the two shared sections and keeps a permission-blocked agent working', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [
                { key: 'alpha', title: 'Audit the auth flow', status: 'running', pendingPermission: true },
                { key: 'beta', title: 'Write the migration', status: 'running' },
                { key: 'gamma', title: 'Old work', status: 'succeeded' },
            ],
        });
        seed(fixture);

        const screen = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={fixture.sessionId} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();

        expect(screen.findByTestId(`${ROSTER_TEST_ID}:section:needsYou`)).toBeNull();
        expect(screen.findByTestId(`${ROSTER_TEST_ID}:section:working`)).toBeTruthy();
        expect(screen.findByTestId(`${ROSTER_TEST_ID}:section:finished`)).toBeTruthy();

        // The blockage is carried by the row itself — its own glyph and status word — and by
        // nothing above it. That is the whole of the claim this roster makes about it.
        const blockedId = testkit.agentActivityFixtureSubagentId('alpha');
        expect(
            screen.findByTestId(`${ROSTER_TEST_ID}:row:${blockedId}:status`)?.props.accessibilityLabel,
        ).toBe('Awaiting approval');
    }, 120_000);

    /**
     * The pane's FINISHED cap and its "Show all" row shipped unreachable: the cap only applies when
     * the host supplies somewhere for "show all" to go, and this host supplied nothing — so
     * `AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT`, the show-all item and their unit tests were all
     * certifying code the app could never enter (§4.7).
     */
    it('caps FINISHED in the pane and expands the rest in place', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [
                { key: 'live', title: 'Still going', status: 'running' },
                ...Array.from({ length: 26 }, (_unused, index) => ({
                    key: `done-${index}`,
                    title: `Finished ${index}`,
                    status: 'succeeded' as const,
                })),
            ],
        });
        seed(fixture);

        const screen = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={fixture.sessionId} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();

        // Counted rather than named: which rows fall outside the cap is an ordering detail, and
        // pinning it here would make this a test about the comparator instead of about the cap.
        const countFinishedRows = () => {
            const text = screen.getTextContent();
            return Array.from({ length: 26 }, (_unused, index) => index)
                .filter((index) => text.includes(`Finished ${index} session.subagents`))
                .length;
        };

        const showAll = screen.findByTestId(`${ROSTER_TEST_ID}:show-all:finished`);
        expect(showAll).toBeTruthy();
        expect(countFinishedRows()).toBe(AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT);
        // The header still states the honest total, so the cap never hides that more exists.
        expect(screen.getTextContent()).toContain('session.agentActivity.section.finished 26');

        await act(async () => {
            showAll!.props.onPress?.();
        });
        await testkit.flushHookEffects();

        expect(countFinishedRows()).toBe(26);
        expect(screen.findByTestId(`${ROSTER_TEST_ID}:show-all:finished`)).toBeNull();
    }, 120_000);

    it('offers no roster action whose route cannot be resolved (A9)', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [{ key: 'alpha', title: 'Audit the auth flow', status: 'running' }],
        });
        seed(fixture);

        const screen = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={fixture.sessionId} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();

        const subagentId = testkit.agentActivityFixtureSubagentId('alpha');
        const overflow = screen.findByTestId(`${ROSTER_TEST_ID}:row:${subagentId}:overflow`);
        expect(overflow).toBeTruthy();

        const { resolveSessionSubagentRowActions } = await import(
            '@/components/sessions/agentActivity/entry/fromSubagent'
        );
        const withoutRoute = resolveSessionSubagentRowActions({
            sessionId: 's1',
            subagent: {
                id: 'subagent_sidechain:nowhere',
                kind: 'subagent_sidechain',
                status: 'running',
                display: { title: 'Nowhere' },
                transcript: {},
                recipient: null,
                capabilities: {
                    canOpen: true,
                    canSend: false,
                    canStop: false,
                    canLaunchChild: false,
                    canDelete: false,
                    canOpenAdvancedRun: true,
                },
                timestamps: {},
            },
        });
        expect(withoutRoute).toEqual([]);
    }, 120_000);

    it('keeps the entry array identity across a reducer commit that changed nothing on screen (INV-4)', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [
                { key: 'alpha', title: 'Audit the auth flow', status: 'running', activity: 'Reading src/auth/session.ts' },
                { key: 'beta', title: 'Write the migration', status: 'running' },
                { key: 'gamma', title: 'Old work', status: 'succeeded' },
            ],
        });
        seed(fixture);

        const screen = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={fixture.sessionId} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();

        const before = readRosterEntries(screen);
        expect(before).toHaveLength(3);

        // A reducer commit rebuilds the pane's preview map and permission set from scratch, so the
        // projection recomputes. What must NOT change is the entry array it hands the list: the rows
        // are memoized on those objects, and a fresh one per commit re-renders the whole roster on
        // every streamed token.
        await act(async () => {
            storage.setState((state) => {
                const session = state.sessionMessages[fixture.sessionId]!;
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

        const after = readRosterEntries(screen);
        expect(after).toBe(before);
    }, 120_000);
});
