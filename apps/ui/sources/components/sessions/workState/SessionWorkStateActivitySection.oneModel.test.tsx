import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ONE MODEL, TWO SURFACES — the deciding check for r4.1.
 *
 * Both the compact work-state surface and the expanded Agents pane are rendered against the SAME
 * seeded session, through real derivation over real store state, and asked what is running. Before
 * this change they could not have agreed by construction: the popover listed workflows from
 * `sessionWorkflowActivityHeadlineV1` while the pane listed the same runs from
 * `sync/domains/session/agentActivity` — two models, one concept, one per surface.
 *
 * The test is written to fail if either surface grows its own idea of what exists: it compares the
 * rendered agent titles, not a count, so a surface that dropped an agent, invented one, or read a
 * second headline shows up as a diff rather than as a number that happens to match.
 */

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

/**
 * Every key any frame asked for.
 *
 * A string is only translated when the branch that renders it is taken, so this is a
 * frame-independent record of what was rendered — including a frame that was corrected away one
 * commit later, which is exactly what a post-commit presence report produces and what no
 * after-the-fact tree query can see.
 */
const translatedKeys = vi.hoisted(() => [] as string[]);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            translatedKeys.push(key);
            return params ? `${key}(${Object.values(params).join(',')})` : key;
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/s1' }).module;
});

// Genuine system boundaries: the sync façade, the execution-run RPCs and the durable record fetch.
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

vi.mock('@/sync/domains/sessionActivity/sessionWorkflowActivityRecords', () => ({
    fetchWorkflowRunSnapshot: vi.fn(async () => null),
}));

const paneSpies = vi.hoisted(() => ({
    openDetailsTab: vi.fn(),
    openRight: vi.fn(),
    setRightTab: vi.fn(),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => paneSpies,
}));

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).installModalModuleMock()());

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

const SESSION_ID = 's1';
const ROSTER_TEST_ID = 'session-agents-roster';

let useSessionWorkStateActivitySection: typeof import('./SessionWorkStateActivitySection')['useSessionWorkStateActivitySection'];
let SessionWorkStateContent: typeof import('./SessionWorkStateContent')['SessionWorkStateContent'];
let SessionRightPanelAgentsView: typeof import('../panes/agents/SessionRightPanelAgentsView')['SessionRightPanelAgentsView'];
let storage: typeof import('@/sync/domains/state/storageStore')['storage'];
let testkit: typeof import('@/dev/testkit');
let previousStorageState: ReturnType<(typeof storage)['getState']> | null = null;

function seed(fixture: ReturnType<typeof import('@/dev/testkit')['makeSessionAgentActivityFixture']>) {
    storage.setState((state) => ({
        ...state,
        sessions: { ...state.sessions, [fixture.sessionId]: fixture.session },
        sessionMessages: { ...state.sessionMessages, ...fixture.storeSessionMessagesBySessionId },
    }));
}

/**
 * A host for the compact section, exactly as the real ones do it: call the hook, slot what it
 * returns. There is no component to render on its own — presence is the hook's answer, not a
 * question the section is asked after it has already painted.
 */
function CompactActivityHost(props: Readonly<{ sessionId: string; onOpenFullRoster?: () => void }>) {
    return <>{useSessionWorkStateActivitySection(props)}</>;
}

/** The titles a surface actually painted, in render order. */
function paintedTitles(text: string, candidates: readonly string[]): readonly string[] {
    return candidates.filter((title) => text.includes(title));
}

describe('the compact work-state surface and the Agents pane read ONE model', () => {
    beforeAll(async () => {
        testkit = await import('@/dev/testkit');
        ({ storage } = await import('@/sync/domains/state/storageStore'));
        ({ useSessionWorkStateActivitySection } = await import('./SessionWorkStateActivitySection'));
        ({ SessionWorkStateContent } = await import('./SessionWorkStateContent'));
        ({ SessionRightPanelAgentsView } = await import('../panes/agents/SessionRightPanelAgentsView'));
    }, 300_000);

    beforeEach(() => {
        previousStorageState = storage.getState();
    });

    afterEach(() => {
        testkit.standardCleanup();
        if (previousStorageState) storage.setState(previousStorageState);
        clearSessionTranscriptDerivedCachesForSession(SESSION_ID);
    });

    it('names the same running work in both surfaces, and shows no finished work in the compact one', async () => {
        const running = ['Audit the auth flow', 'Write the migration', 'Await the approval'];
        const finished = ['Old work'];
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [
                { key: 'alpha', title: running[0]!, status: 'running' },
                { key: 'beta', title: running[1]!, status: 'running' },
                { key: 'gamma', title: running[2]!, status: 'running', pendingPermission: true },
                { key: 'delta', title: finished[0]!, status: 'succeeded' },
            ],
        });
        seed(fixture);

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        const paneText = pane.getTextContent();
        expect(pane.findByTestId(ROSTER_TEST_ID)).toBeTruthy();
        await pane.unmount();

        const compact = await testkit.renderScreen(
            <CompactActivityHost sessionId={SESSION_ID} />,
        );
        await testkit.flushHookEffects();
        const compactText = compact.getTextContent();

        // Same population, same names, same order — from one derivation.
        expect(paintedTitles(compactText, running)).toEqual(running);
        expect(paintedTitles(paneText, running)).toEqual(running);

        // A permission-blocked agent is live work, and it is live work on BOTH surfaces. This is
        // the case the deleted attention model used to route somewhere else entirely.
        expect(compactText).toContain('session.agentActivity.status.waiting');

        // The compact surface is the live view: terminal work belongs to the pane, which has room
        // for history. The pane still has it, so nothing was lost — only relocated.
        expect(paintedTitles(compactText, finished)).toEqual([]);
        expect(paintedTitles(paneText, finished)).toEqual(finished);

        await compact.unmount();
    }, 120_000);

    /**
     * A9: the lead-in to the expanded surface renders only when there is somewhere to go — the
     * section's own contract, which holds whether or not a caller has a destination. (The roster now
     * has a screen of its own, so `SessionView` passes the handler on every device; this still fixes
     * the section's behaviour for a host that has nowhere to send a reader.)
     */
    it('renders no lead-in when the expanded surface is unreachable', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [{ key: 'alpha', title: 'Audit the auth flow', status: 'running' }],
        });
        seed(fixture);

        const withoutLeadIn = await testkit.renderScreen(
            <CompactActivityHost sessionId={SESSION_ID} />,
        );
        await testkit.flushHookEffects();
        expect(withoutLeadIn.findByTestId('session-work-state-activity-open-roster')).toBeNull();
        await withoutLeadIn.unmount();

        const withLeadIn = await testkit.renderScreen(
            <CompactActivityHost sessionId={SESSION_ID} onOpenFullRoster={() => {}} />,
        );
        await testkit.flushHookEffects();
        expect(withLeadIn.findByTestId('session-work-state-activity-open-roster')).toBeTruthy();
        await withLeadIn.unmount();
    }, 120_000);

    /**
     * The host's "nothing to show" placeholder and the activity section may not both be right, and
     * they may not take turns being right either. Emptiness used to be reported UPWARD from a
     * post-commit effect, so a session with live work and no goal or tasks committed the placeholder
     * and the running rows together and dropped the placeholder one commit later — a flash a slow
     * device shows and a settled tree query can never see, which is why this asserts on the
     * translation log rather than on the final frame.
     */
    it('never renders the "nothing here" placeholder in ANY frame while work is live', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [{ key: 'alpha', title: 'Audit the auth flow', status: 'running' }],
        });
        seed(fixture);
        translatedKeys.length = 0;

        const compact = await testkit.renderScreen(
            <SessionWorkStateContent
                sessionId={SESSION_ID}
                snapshot={null}
                editableGoal={false}
                requestClose={() => {}}
            />,
        );
        await testkit.flushHookEffects();

        expect(compact.getTextContent()).toContain('Audit the auth flow');
        expect(translatedKeys).not.toContain('session.workState.emptyPlaceholder');

        await compact.unmount();
    }, 120_000);

    it('shows nothing at all when nothing is running', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [{ key: 'alpha', title: 'Old work', status: 'succeeded' }],
        });
        seed(fixture);

        const compact = await testkit.renderScreen(
            <CompactActivityHost sessionId={SESSION_ID} />,
        );
        await testkit.flushHookEffects();
        expect(compact.findByTestId('session-work-state-activity-section')).toBeNull();
        await compact.unmount();
    }, 120_000);
    /**
     * The compact popover reaches a pane, which is the assumption this surface was built on being
     * false. It used to push the subagent's full-screen route on every device "because a popover
     * anchored to the composer has no pane scope" — but a pane scope is addressed by session id, so
     * a wide layout can host the press exactly as a transcript file link already does. That false
     * assumption is why an imported workflow sidechain, which has no route at all, could be
     * previewed here and opened nowhere.
     */
    it('opens a pressed agent in the details pane from the COMPACT surface, not only from the pane', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [{ key: 'alpha', title: 'Audit the auth flow', status: 'running' }],
        });
        seed(fixture);
        paneSpies.openDetailsTab.mockClear();

        const compact = await testkit.renderScreen(
            <CompactActivityHost sessionId={SESSION_ID} />,
        );
        await testkit.flushHookEffects();

        const row = compact.root.findAllByProps({ accessibilityRole: 'button' })
            .find((instance: any) => typeof instance.props?.testID === 'string'
                && instance.props.testID.startsWith('session-work-state-activity:row:'));
        expect(row).toBeTruthy();
        await testkit.pressTestInstanceAsync(row!);

        expect(paneSpies.openDetailsTab).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'subagent' }),
            expect.objectContaining({ intent: 'preview' }),
        );

        await compact.unmount();
    }, 120_000);
});
