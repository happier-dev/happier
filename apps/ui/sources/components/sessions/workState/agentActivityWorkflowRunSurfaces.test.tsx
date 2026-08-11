import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildAgentActivityEntryId,
    type SessionAgentActivityEntryV1,
    type SessionAgentActivityHeadlineV1,
} from '@happier-dev/protocol';

import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A WORKFLOW RUN, through both agent-activity surfaces.
 *
 * Every test under `workState/` and `panes/agents/` seeded plain subagents, so the run half of the
 * model was rendered by nothing: a reviewer deleted the entire run-panel block from
 * `SessionWorkStateActivitySection` and the whole suite stayed green. Two shipped regressions hid
 * in that gap — a running workflow that named no agents was invisible to every count surface, and a
 * terminal run was invisible in both rosters — so the run is exercised here through the real
 * surfaces, against real derivation over real store state.
 *
 * Three shapes, because they fail differently:
 *
 * - a **count-only** run (the old-CLI / cold-open path): the producer states a total and names no
 *   agent, so the run is the only thing that represents that work;
 * - a run whose members ARE named: the run is a container, and counting it as well would double
 *   count;
 * - a **terminal** run: not a panel any more, and therefore a row — the only row that can state the
 *   run-level outcome.
 *
 * **It lives HERE, beside the block it guards, and that placement is load-bearing.** The guard began
 * under `agentActivity/` — the model's folder, not the surface's — so `yarn test:unit -- workState
 * SessionRightPanelAgentsView`, the pattern this corridor was actually run with, never selected it:
 * the same run-panel deletion above stayed green across all 22 matching shards. A guard the team's
 * habitual command does not run is a guard that rots, so it sits in the host directory whose file
 * the mutation edits, under a name that keeps `agentActivity` in the path for the model-scoped
 * pattern too. Moving it back out of `workState/` silently disarms it.
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

const SESSION_ID = 's1';
const ROSTER_TEST_ID = 'session-agents-roster';
const WORKING_HEADER_TEST_ID = `${ROSTER_TEST_ID}:section:working`;
const FINISHED_HEADER_TEST_ID = `${ROSTER_TEST_ID}:section:finished`;

let useSessionWorkStateActivitySection: typeof import('./SessionWorkStateActivitySection')['useSessionWorkStateActivitySection'];
let SessionRightPanelAgentsView: typeof import('../panes/agents/SessionRightPanelAgentsView')['SessionRightPanelAgentsView'];
let useSessionAgentActivity: typeof import('@/hooks/session/useSessionAgentActivity')['useSessionAgentActivity'];
let countSessionAgentActivityFromMetadata: typeof import('@/sync/domains/session/agentActivity/countSessionAgentActivityFromMetadata')['countSessionAgentActivityFromMetadata'];
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

/** Everything a subtree printed, so a section heading can be read without a second testID. */
function textOf(node: ReactTestInstance | null): string {
    if (!node) return '';
    const parts: string[] = [];
    const walk = (children: readonly (ReactTestInstance | string)[]): void => {
        for (const child of children) {
            if (typeof child === 'string') parts.push(child);
            else walk(child.children);
        }
    };
    walk(node.children);
    return parts.join(' ');
}

/**
 * The compact surface, mounted the way its real hosts mount it.
 *
 * `useSessionWorkStateActivitySection` returns the section node, or `null` when nothing is live, so
 * the host can decide presence during its own render. This stands in for `SessionWorkStateContent`
 * without dragging the goal controller in.
 */
function CompactWorkStateHost(props: Readonly<{ sessionId: string }>): React.ReactElement {
    const section = useSessionWorkStateActivitySection({ sessionId: props.sessionId });
    return <>{section}</>;
}

/** The number the badge above the pane draws: the ONE count owner, read exactly as it reads it. */
async function readLiveCount(): Promise<number> {
    const probe = await testkit.renderHook(() => useSessionAgentActivity({
        sessionId: SESSION_ID,
        directSessionRuntime: { directSessionLink: null, status: null, refreshNow: async () => null },
    }).counts.live);
    const live = probe.getCurrent();
    await probe.unmount();
    return live;
}

function workflowAgent(over: Readonly<{
    runId: string;
    agentId: string;
    title: string;
    status: SessionAgentActivityEntryV1['status'];
}>): SessionAgentActivityEntryV1 {
    return {
        entryId: buildAgentActivityEntryId({ kind: 'workflow_agent', runId: over.runId, agentId: over.agentId }),
        kind: 'workflow_agent',
        title: over.title,
        status: over.status,
        updatedAt: 2_000,
        runId: over.runId,
        parentId: buildAgentActivityEntryId({ kind: 'workflow_run', runId: over.runId }),
    };
}

function unifiedHeadlineMetadata(params: Readonly<{
    activeEntries: readonly SessionAgentActivityEntryV1[];
    recentEntries?: readonly SessionAgentActivityEntryV1[];
}>): Record<string, unknown> {
    const headline: SessionAgentActivityHeadlineV1 = {
        v: 1,
        backendId: 'claude',
        updatedAt: 2_000,
        activeEntries: [...params.activeEntries],
        ...(params.recentEntries ? { recentEntries: [...params.recentEntries] } : {}),
    };
    return { sessionAgentActivityHeadlineV1: headline };
}

describe('a workflow run reaches both agent-activity surfaces', () => {
    beforeAll(async () => {
        testkit = await import('@/dev/testkit');
        ({ storage } = await import('@/sync/domains/state/storageStore'));
        ({ useSessionAgentActivity } = await import('@/hooks/session/useSessionAgentActivity'));
        ({ countSessionAgentActivityFromMetadata } = await import(
            '@/sync/domains/session/agentActivity/countSessionAgentActivityFromMetadata'
        ));
        ({ useSessionWorkStateActivitySection } = await import('./SessionWorkStateActivitySection'));
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

    /**
     * The count-only path: old-CLI Claude, and EVERY cold open before transcript derivation. The
     * producer states `totalAgents` and names nobody, so the run is the only representation of that
     * work — and it used to be skipped by the shared counter as if it were a container, reporting
     * `live: 0` while both surfaces drew it as a live panel (PLAN §4.6, RULING-4).
     */
    it('draws a running run that names no agents, and counts it, on both surfaces', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            session: {
                metadata: testkit.makeSessionWorkflowActivityMetadata([
                    testkit.makeSessionWorkflowRunHeadline({
                        runId: 'wf_cold',
                        title: 'Ship the release',
                        status: 'active',
                        totalAgents: 5,
                        completedAgents: 2,
                    }),
                ]) as never,
            },
        });
        seed(fixture);

        // The session-list row and the header glyph read this, off metadata alone.
        // One unit of work, described as what it is: a workflow with three agents still running
        // (RULING-10 for the noun, RULING-11 for the figure). The producer's counts are the only
        // thing that can say three here — dropping them understated the run to a single anonymous
        // "agent" on every surface, and reading `totalAgents` alone overstated it as five while two
        // of those agents had already finished.
        //
        // `live` is THREE, not one (RULING-12). It used to be one — the run counted as a single
        // roster unit — so the chip said "1 workflow, 3 agents" beside a badge saying `1`. The
        // tally counts what the chip describes.
        expect(countSessionAgentActivityFromMetadata(fixture.session.metadata))
            .toMatchObject({ live: 3, total: 1, liveWorkflowRuns: 1, liveWorkflowAgents: 3 });
        expect(await readLiveCount()).toBe(3);

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        expect(pane.findByTestId('workflow-run-panel-wf_cold')).toBeTruthy();
        expect(pane.getTextContent()).toContain('Ship the release');
        await pane.unmount();

        const compact = await testkit.renderScreen(
            <CompactWorkStateHost sessionId={SESSION_ID} />,
        );
        await testkit.flushHookEffects();
        expect(compact.findByTestId('workflow-run-panel-wf_cold')).toBeTruthy();
        expect(compact.getTextContent()).toContain('Ship the release');
        await compact.unmount();
    }, 120_000);

    /**
     * The other half of the same rule, and the reviewer's worked example: a workflow 3/5 done plus
     * two plain subagents. The badge said 4 while the pane showed a panel and `WORKING 2`, leaving
     * the reader to compute `(5-3)+2`. The run must still not be counted — its members are named,
     * so counting it too would double count — and the heading must cover the work the panel holds.
     */
    it('counts the members of a named run once, and says so under WORKING', async () => {
        const runId = 'wf_named';
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [
                { key: 'alpha', title: 'Audit the auth flow', status: 'running' },
                { key: 'beta', title: 'Write the migration', status: 'running' },
            ],
            session: {
                metadata: unifiedHeadlineMetadata({
                    activeEntries: [
                        {
                            entryId: buildAgentActivityEntryId({ kind: 'workflow_run', runId }),
                            kind: 'workflow_run',
                            title: 'Ship the release',
                            status: 'running',
                            updatedAt: 2_000,
                            runId,
                        },
                        workflowAgent({ runId, agentId: 'wfa-4', title: 'Fourth agent', status: 'running' }),
                        workflowAgent({ runId, agentId: 'wfa-5', title: 'Fifth agent', status: 'running' }),
                    ],
                    recentEntries: [
                        workflowAgent({ runId, agentId: 'wfa-1', title: 'First agent', status: 'succeeded' }),
                        workflowAgent({ runId, agentId: 'wfa-2', title: 'Second agent', status: 'succeeded' }),
                        workflowAgent({ runId, agentId: 'wfa-3', title: 'Third agent', status: 'succeeded' }),
                    ],
                }) as never,
            },
        });
        seed(fixture);

        // Two remaining workflow agents plus two plain subagents. The run is a container here, so
        // it is not a sixth unit of work.
        const badgeCount = await readLiveCount();
        expect(badgeCount).toBe(4);

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();

        expect(pane.findByTestId(`workflow-run-panel-${runId}`)).toBeTruthy();
        // The panel holds its own members; the list must not print them a second time.
        expect(pane.getTextContent()).not.toContain('Fourth agent');
        expect(pane.getTextContent()).toContain('Audit the auth flow');
        // The heading states the section's population, so it and the tab badge above it are one
        // number rather than two the reader has to reconcile.
        expect(textOf(pane.findByTestId(WORKING_HEADER_TEST_ID))).toContain(String(badgeCount));
        await pane.unmount();

        // The compact surface draws the same run through the same partition, so the two surfaces
        // cannot group one workflow differently.
        const compact = await testkit.renderScreen(
            <CompactWorkStateHost sessionId={SESSION_ID} />,
        );
        await testkit.flushHookEffects();
        expect(compact.findByTestId(`workflow-run-panel-${runId}`)).toBeTruthy();
        expect(compact.getTextContent()).not.toContain('Fourth agent');
        expect(compact.getTextContent()).toContain('Audit the auth flow');
        await compact.unmount();
    }, 120_000);

    /**
     * RULING-12, at the fifth surface: the WORKING heading states the same magnitude as the badge.
     *
     * A count-only run 5/3 beside two plain subagents. The badge counts the run's live complement
     * (2) plus the two loose agents (4); the pane draws the run as a panel and lists only the two
     * subagents, so a heading that counted rows plus a flat one per folded unit said `3` an inch
     * under a badge saying `4`. The heading covers what the badge covers — the live work of this
     * session — so it is derived from that one tally rather than from a private unit count.
     */
    it('states the same magnitude under WORKING as the badge above it', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [
                { key: 'alpha', title: 'Audit the auth flow', status: 'running' },
                { key: 'beta', title: 'Write the migration', status: 'running' },
            ],
            session: {
                metadata: testkit.makeSessionWorkflowActivityMetadata([
                    testkit.makeSessionWorkflowRunHeadline({
                        runId: 'wf_mixed',
                        title: 'Ship the release',
                        status: 'active',
                        totalAgents: 5,
                        completedAgents: 3,
                    }),
                ]) as never,
            },
        });
        seed(fixture);

        // Two agents still moving inside the run, plus two of its own — the chip says
        // "1 workflow, 2 agents · 2 subagents working", and the tally must say the same.
        const badgeCount = await readLiveCount();
        expect(badgeCount).toBe(4);

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        expect(pane.findByTestId('workflow-run-panel-wf_mixed')).toBeTruthy();
        expect(textOf(pane.findByTestId(WORKING_HEADER_TEST_ID))).toContain(String(badgeCount));
        await pane.unmount();
    }, 120_000);

    /**
     * §4.7: FINISHED holds every terminal state including failed. A run that fails before naming an
     * agent was counted in `total`/`failed` and drawn nowhere: not a panel any more, and filtered
     * out of the list as if it were still one. The run-level word has no other home — no member row
     * can say the run itself failed.
     */
    it('lists a terminal run with its own outcome, and keeps it out of the compact live view', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [{ key: 'alpha', title: 'Older finished work', status: 'succeeded' }],
            session: {
                metadata: testkit.makeSessionWorkflowActivityMetadata([], {
                    recentRuns: [testkit.makeSessionWorkflowRunHeadline({
                        runId: 'wf_dead',
                        title: 'Ship the release',
                        status: 'failed',
                        updatedAt: 9_000,
                        totalAgents: 0,
                        completedAgents: 0,
                    })],
                }) as never,
            },
        });
        seed(fixture);

        expect(countSessionAgentActivityFromMetadata(fixture.session.metadata))
            .toMatchObject({ live: 0, failed: 1, total: 1 });

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        const paneText = pane.getTextContent();

        // A row, not a panel: a finished run is history and belongs in the ordered list.
        expect(pane.findByTestId('workflow-run-panel-wf_dead')).toBeNull();
        expect(pane.findByTestId(`${ROSTER_TEST_ID}:row:workflow_run:wf_dead`)).toBeTruthy();
        expect(paneText).toContain('Ship the release');
        expect(paneText).toContain('session.agentActivity.status.failed');
        expect(textOf(pane.findByTestId(FINISHED_HEADER_TEST_ID))).toContain('2');
        await pane.unmount();

        // The compact surface is live-only by design (§4.6), so the finished run belongs to the
        // pane. Pinned here so "terminal work is absent" stays a decision rather than a side effect.
        const compact = await testkit.renderScreen(
            <CompactWorkStateHost sessionId={SESSION_ID} />,
        );
        await testkit.flushHookEffects();
        expect(compact.findByTestId('session-work-state-activity-section')).toBeNull();
        await compact.unmount();
    }, 120_000);
});
