import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildAgentActivityEntryId,
    buildWorkflowAgentSidechainId,
    type SessionAgentActivityEntryV1,
    type SessionAgentActivityHeadlineV1,
    type SessionRuntimeIssueV1,
    type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';
import type { Session } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ONE SURFACE, TWO HOSTS — the deciding check for the agent-activity surface unification.
 *
 * The compact work-state popover and the Agents pane used to decide density, bleed, staleness,
 * pressability, ordering, grouping and emptiness for themselves. Every visible defect this file
 * pins was a COMPOSITION decision made twice, not a row defect: the row has been shared since r4.1.
 *
 * So each case renders the SAME seeded session through BOTH hosts and asks them the same question.
 * A host that grows its own answer shows up here as a diff, not as a number that happens to match.
 */

const routerPushSpy = vi.hoisted(() => vi.fn());
const openDetailsTabSpy = vi.hoisted(() => vi.fn());
const runSnapshots = vi.hoisted(() => new Map<string, unknown>());
/** Every sidechain this render actually asked the server for, in order. */
const ensureSidechainSpy = vi.hoisted(() => vi.fn(async () => 'loaded' as const));

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
        pathname: () => '/session/s1',
        router: { push: routerPushSpy },
    }).module;
});

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).installModalModuleMock()());

// Genuine system boundaries: the sync façade, the execution-run RPCs and the durable record fetch.
vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainSpy,
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
    fetchWorkflowRunSnapshot: vi.fn(async (params: { runId: string }) => (
        runSnapshots.get(params.runId) ?? null
    )),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({ openDetailsTab: openDetailsTabSpy }),
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

const SESSION_ID = 's1';
const PANE_TEST_ID = 'session-agents-roster';
const COMPACT_TEST_ID = 'session-work-state-activity';
const EMPTY_STATE_KEY = 'session.agentActivity.empty.firstUseTitle';
const STALE_KEY = 'session.agentActivity.staleness.stale';
const UNOBSERVED_KEY = 'session.agentActivity.sessionNotice.unobserved';
const STOPPED_AUTH_KEY = 'session.agentActivity.sessionNotice.stoppedAuth';
const STOPPED_KEY = 'session.agentActivity.sessionNotice.stopped';
const RUNNING_STATUS_KEY = 'session.agentActivity.status.running';

let useSessionWorkStateActivitySection: typeof import('../../workState/SessionWorkStateActivitySection')['useSessionWorkStateActivitySection'];
let SessionRightPanelAgentsView: typeof import('../../panes/agents/SessionRightPanelAgentsView')['SessionRightPanelAgentsView'];
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

/** The compact surface, mounted exactly as `SessionWorkStateContent` mounts it. */
function CompactHost(props: Readonly<{ sessionId: string }>): React.ReactElement {
    return <>{useSessionWorkStateActivitySection({ sessionId: props.sessionId })}</>;
}

function unifiedHeadline(params: Readonly<{
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

function workflowAgentEntry(over: Readonly<{
    runId: string;
    agentId: string;
    title: string;
    status: SessionAgentActivityEntryV1['status'];
    parented?: boolean;
    /** The imported transcript (W23), which is what makes a workflow agent inspectable at all. */
    sidechainId?: string;
}>): SessionAgentActivityEntryV1 {
    return {
        entryId: buildAgentActivityEntryId({ kind: 'workflow_agent', runId: over.runId, agentId: over.agentId }),
        kind: 'workflow_agent',
        title: over.title,
        status: over.status,
        updatedAt: 2_000,
        runId: over.runId,
        ...(over.sidechainId ? { sidechainId: over.sidechainId } : {}),
        ...(over.parented === false
            ? {}
            : { parentId: buildAgentActivityEntryId({ kind: 'workflow_run', runId: over.runId }) }),
    };
}

type ProducerRealAgent = Readonly<{ agentId: string; title: string; line: string }>;

/**
 * The workflow shape a PRODUCER can actually publish, seeded end to end.
 *
 * Every earlier preview proof in this file seeds `parented: false` workflow agents and no
 * `workflow_run` entry at all — a wire shape no producer emits. `agentActivityHeadlineProjection.ts`
 * publishes ONE run entry plus one agent entry per snapshot agent, each carrying
 * `parentId = <the run entry>`; so under the real partition every agent of a LIVE run is folded into
 * the run panel and never listed. Proving reachability on the unparented shape therefore proved
 * nothing about the surface a phone has, which is how the run panel shipped with no preview at all.
 *
 * So this seeds all four halves the producer writes together: the unified headline (run + parented
 * agents, with the sidechain ids the importer proved), and the durable `activity/workflow_run.v1`
 * snapshot the panel draws its rows from — with the same per-agent sidechain ids, since the headline
 * projection copies them from exactly this record.
 */
function seedProducerRealWorkflow(params: Readonly<{
    runId: string;
    workflowToolUseId: string;
    agents: readonly ProducerRealAgent[];
    /** `false` publishes the run and its agents as finished, in `recentEntries`. */
    live: boolean;
}>): Readonly<{
    runEntryId: string;
    entryIdByAgentId: ReadonlyMap<string, string>;
    sidechainIdByAgentId: ReadonlyMap<string, string>;
}> {
    const { agents, live, runId, workflowToolUseId } = params;
    /**
     * The record revision the producer stamps on the run entry, and ONLY the run entry.
     *
     * `agentActivityHeadlineProjection.ts` writes `recordRevision: snapshot.recordRevision`
     * unconditionally, so a seed without it is not the shape the producer publishes: it is the
     * older shape that makes `useWorkflowRunDetails` fall back to keying the durable fetch on the
     * entry's evidence instant. Both branches are real — a CLI predating the field is reachable the
     * moment a client and a daemon differ — and this file exercises them separately: the run
     * entries seeded inline below carry no revision and take the fallback, while the producer-real
     * seeds here take the revision key the current CLI actually emits.
     */
    const recordRevision = '1';
    const sidechainIdByAgentId = new Map<string, string>();
    const entryIdByAgentId = new Map<string, string>();
    for (const agent of agents) {
        sidechainIdByAgentId.set(
            agent.agentId,
            buildWorkflowAgentSidechainId({ workflowToolUseId, agentId: agent.agentId }),
        );
        entryIdByAgentId.set(
            agent.agentId,
            buildAgentActivityEntryId({ kind: 'workflow_agent', runId, agentId: agent.agentId }),
        );
    }

    runSnapshots.set(runId, testkit.makeSessionWorkflowRunSnapshot({
        runId,
        title: 'Ship the release',
        workflowToolUseId,
        recordRevision,
        status: live ? 'active' : 'complete',
        totalAgents: agents.length,
        completedAgents: live ? 0 : agents.length,
        agents: agents.map((agent) => ({
            id: agent.agentId,
            title: agent.title,
            status: live ? 'active' as const : 'complete' as const,
            updatedAt: 2_000,
            sidechainId: sidechainIdByAgentId.get(agent.agentId)!,
        })),
    }) as SessionWorkflowRunSnapshotV1);

    const runEntryId = buildAgentActivityEntryId({ kind: 'workflow_run', runId });
    const entries: SessionAgentActivityEntryV1[] = [
        {
            entryId: runEntryId,
            kind: 'workflow_run',
            title: 'Ship the release',
            status: live ? 'running' : 'succeeded',
            updatedAt: 2_000,
            runId,
            // Copied from the snapshot exactly as the projection does, so the headline names the
            // record version it points at. Agents stay unstamped: they live INSIDE the run's
            // record and a second freshness authority for one record is what the producer refuses.
            recordRevision,
        },
        ...agents.map((agent) => workflowAgentEntry({
            runId,
            agentId: agent.agentId,
            title: agent.title,
            status: live ? 'running' : 'succeeded',
            sidechainId: sidechainIdByAgentId.get(agent.agentId)!,
        })),
    ];

    const fixture = testkit.makeSessionAgentActivityFixture({
        sessionId: SESSION_ID,
        session: {
            metadata: unifiedHeadline(
                live ? { activeEntries: entries } : { activeEntries: [], recentEntries: entries },
            ) as never,
        },
    });
    for (const agent of agents) {
        fixture.reducerState.sidechains.set(sidechainIdByAgentId.get(agent.agentId)!, [
            testkit.makeAgentActivitySidechainMessage({
                id: `${agent.agentId}_step`,
                createdAt: 1_000,
                toolName: 'Read',
                toolDescription: `${agent.agentId}.ts`,
            }),
            testkit.makeAgentActivitySidechainMessage({
                id: `${agent.agentId}_line`,
                createdAt: 1_001,
                text: agent.line,
            }),
        ]);
    }
    seed(fixture);

    return { runEntryId, entryIdByAgentId, sidechainIdByAgentId };
}

/**
 * Entry ids a surface printed, in render order.
 *
 * Read off the list's per-item motion wrappers rather than the row testIDs, because a row's own
 * testID is also the prefix of its status glyph and elapsed slot.
 */
/** The sidechain ids this render actually fetched, deduplicated, in call order. */
function sidechainRequests(): string[] {
    return ensureSidechainSpy.mock.calls
        .map((call) => String((call as unknown as readonly unknown[])[1]))
        .filter((id, index, all) => all.indexOf(id) === index);
}

/** One session, one subagent, and whatever runtime facts the case is about. */
function seedLiveSubagentSession(params: Readonly<{
    sessionId: string;
    status?: 'running' | 'succeeded';
    session?: Partial<Session>;
}>): void {
    seed(testkit.makeSessionAgentActivityFixture({
        sessionId: params.sessionId,
        subagents: [{
            key: 'alpha',
            title: 'Audit the auth flow',
            status: params.status ?? 'running',
            activity: 'Reading auth.ts',
        }],
        ...(params.session ? { session: params.session } : {}),
    }));
}

/** The classification the CLI writes when a session's runtime fails, as the wire spells it. */
function runtimeIssue(over: Readonly<{ source: SessionRuntimeIssueV1['source']; code?: string }>): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: over.code ?? 'provider_auth_expired',
        source: over.source,
        // Long before anything else this fixture carries, so no later evidence contradicts it.
        occurredAt: 1_500,
    };
}

/**
 * How many times a surface states the session fact. RULING-16 allows exactly one, or none.
 *
 * Counted in the rendered TEXT rather than by testID, because the tree carries a composite and a
 * host node for the same element and a node count would read two for one sentence.
 */
function noticeCount(
    screen: Readonly<{ getTextContent: () => string }>,
    key: string,
): number {
    return screen.getTextContent().split(key).length - 1;
}

function rowIds(screen: Readonly<{ findAll: (p: (node: any) => boolean) => any[] }>, prefix: string): string[] {
    const marker = `${prefix}:motion:`;
    return screen
        .findAll((node) => typeof node.props?.testID === 'string' && node.props.testID.startsWith(marker))
        .map((node) => String(node.props.testID).slice(marker.length))
        .filter((key) => !key.startsWith('section:') && !key.startsWith('show-all:'))
        .filter((key, index, all) => all.indexOf(key) === index);
}

describe('one agent-activity surface, two hosts', () => {
    beforeAll(async () => {
        testkit = await import('@/dev/testkit');
        ({ storage } = await import('@/sync/domains/state/storageStore'));
        ({ useSessionWorkStateActivitySection } = await import('../../workState/SessionWorkStateActivitySection'));
        ({ SessionRightPanelAgentsView } = await import('../../panes/agents/SessionRightPanelAgentsView'));
    }, 300_000);

    beforeEach(() => {
        previousStorageState = storage.getState();
        routerPushSpy.mockClear();
        openDetailsTabSpy.mockClear();
        ensureSidechainSpy.mockClear();
        runSnapshots.clear();
    });

    afterEach(() => {
        testkit.standardCleanup();
        if (previousStorageState) storage.setState(previousStorageState);
        clearSessionTranscriptDerivedCachesForSession(SESSION_ID);
    });

    /**
     * (a) The photographed defect: a running run panel with "Your agents will show up here"
     * underneath it. Emptiness was decided from the LIST's entries alone while the host had already
     * drawn the live work above it as a panel.
     */
    it('never draws the empty state while a live run is on screen, in either host', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            session: {
                metadata: testkit.makeSessionWorkflowActivityMetadata([
                    testkit.makeSessionWorkflowRunHeadline({
                        runId: 'wf_live',
                        title: 'Ship the release',
                        status: 'active',
                        totalAgents: 5,
                        completedAgents: 2,
                    }),
                ]) as never,
            },
        });
        seed(fixture);

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        expect(pane.findByTestId('workflow-run-panel-wf_live')).toBeTruthy();
        expect(pane.findByTestId(`${PANE_TEST_ID}:empty`)).toBeNull();
        expect(pane.getTextContent()).not.toContain(EMPTY_STATE_KEY);
        await pane.unmount();

        const compact = await testkit.renderScreen(<CompactHost sessionId={SESSION_ID} />);
        await testkit.flushHookEffects();
        expect(compact.findByTestId('workflow-run-panel-wf_live')).toBeTruthy();
        expect(compact.findByTestId(`${COMPACT_TEST_ID}:empty`)).toBeNull();
        expect(compact.getTextContent()).not.toContain(EMPTY_STATE_KEY);
        await compact.unmount();
    }, 120_000);

    /**
     * (b) Dead work must not look alive on the surface a phone user actually has. The compact
     * surface dropped the staleness prop entirely, so a ten-minutes-silent agent kept a turning
     * spinner and said nothing; run-panel agent rows never carried `updatedAt` at all.
     */
    it('states silence on a quiet agent in the compact surface and in the run panel', async () => {
        const runId = 'wf_stale';
        runSnapshots.set(runId, testkit.makeSessionWorkflowRunSnapshot({
            runId,
            title: 'Ship the release',
            status: 'active',
            totalAgents: 1,
            completedAgents: 0,
            agents: [{
                id: 'wfa-1',
                title: 'Quiet agent',
                status: 'active',
                // Epoch-1970 evidence: silent for decades, so the note is a fact about the agent
                // rather than about the moment the test happened to run.
                updatedAt: 1_000,
            }],
        }) as SessionWorkflowRunSnapshotV1);

        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [{ key: 'alpha', title: 'Audit the auth flow', status: 'running', activity: 'Reading auth.ts' }],
            session: {
                metadata: unifiedHeadline({
                    activeEntries: [{
                        entryId: buildAgentActivityEntryId({ kind: 'workflow_run', runId }),
                        kind: 'workflow_run',
                        title: 'Ship the release',
                        status: 'running',
                        updatedAt: 2_000,
                        runId,
                    }],
                }) as never,
            },
        });
        seed(fixture);

        const compact = await testkit.renderScreen(<CompactHost sessionId={SESSION_ID} />);
        await testkit.flushHookEffects();
        const compactText = compact.getTextContent();
        expect(compactText).toContain('Quiet agent');
        expect(compact.findByTestId(`workflow-agent-${runId}-wfa-1`)).toBeTruthy();
        // TWO silent rows, so this cannot pass on one of them: the flat subagent row (the compact
        // surface passed no staleness at all) and the run panel's own agent row (which had no
        // `updatedAt` to reason from). Either regression drops the count to one.
        expect(compactText.split(STALE_KEY).length - 1).toBe(2);
        await compact.unmount();

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        expect(pane.getTextContent()).toContain(STALE_KEY);
        await pane.unmount();
    }, 120_000);

    /**
     * (c) A9, at the largest target on the row. A headline-only workflow agent resolves to no
     * subagent, so the pane's press handler returned silently — while the row still carried a
     * ripple, a pressed overlay and `accessibilityRole="button"`.
     */
    it('does not advertise a press on a row that resolves to nothing', async () => {
        const runId = 'wf_orphan';
        const entryId = buildAgentActivityEntryId({ kind: 'workflow_agent', runId, agentId: 'wfa-1' });
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            session: {
                metadata: unifiedHeadline({
                    activeEntries: [workflowAgentEntry({
                        runId,
                        agentId: 'wfa-1',
                        title: 'Headline only agent',
                        status: 'running',
                        parented: false,
                    })],
                }) as never,
            },
        });
        seed(fixture);

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        const row = pane.findByTestId(`${PANE_TEST_ID}:row:${entryId}`);
        expect(row).toBeTruthy();
        expect(row?.props.onPress).toBeUndefined();
        expect(row?.props.accessibilityRole).not.toBe('button');
        await pane.unmount();
    }, 120_000);

    /**
     * (d) The other half of the same contract: a row that DOES resolve stays pressable, and the
     * compact surface — the only agent surface a phone has — reaches the same work.
     *
     * W23 added a bounded preview under these rows and did NOT spend the row press on it: opening
     * is still one press, and the glance lives on the caret beside it (pinned below).
     */
    it('opens a locally derived subagent from both hosts', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [{ key: 'alpha', title: 'Audit the auth flow', status: 'running', activity: 'Reading auth.ts' }],
        });
        seed(fixture);
        const subagentId = testkit.agentActivityFixtureSubagentId('alpha');

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        const paneRow = pane.findByTestId(`${PANE_TEST_ID}:row:${subagentId}`);
        expect(paneRow?.props.accessibilityRole).toBe('button');
        pane.pressByTestId(`${PANE_TEST_ID}:row:${subagentId}`);
        expect(openDetailsTabSpy).toHaveBeenCalled();
        await pane.unmount();

        const compact = await testkit.renderScreen(<CompactHost sessionId={SESSION_ID} />);
        await testkit.flushHookEffects();
        const compactRow = compact.findByTestId(`${COMPACT_TEST_ID}:row:${subagentId}`);
        expect(compactRow?.props.accessibilityRole).toBe('button');
        compact.pressByTestId(`${COMPACT_TEST_ID}:row:${subagentId}`);
        // Same work, same destination: the transcript message the pane's details tab resolves, on
        // the route a phone can actually reach.
        expect(routerPushSpy).toHaveBeenCalledWith(
            `/session/${SESSION_ID}/message/${encodeURIComponent(`tool:${testkit.agentActivityFixtureSidechainId('alpha')}`)}`,
        );
        await compact.unmount();
    }, 120_000);

    /**
     * (W23-d2) The two gestures on one row, and neither eats the other.
     *
     * An agent with a destination keeps its one-press open — the caret is what glances. The
     * discriminating assertion is the pair: expanding must not navigate, and the row press must not
     * expand. A single control doing both is how "open" became two presses in the draft of this
     * wave, and how the overflow menu briefly disappeared from every disclosed row.
     */
    it('separates open from glance on a row that can do both, in both hosts', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [{ key: 'alpha', title: 'Audit the auth flow', status: 'running', activity: 'Reading auth.ts' }],
        });
        seed(fixture);
        const subagentId = testkit.agentActivityFixtureSubagentId('alpha');

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        // The actions a roster row offers do not depend on whether it can disclose a body.
        expect(pane.findByTestId(`${PANE_TEST_ID}:row:${subagentId}:overflow`)).toBeTruthy();
        expect(pane.findByTestId(`${PANE_TEST_ID}:preview:${subagentId}`)).toBeNull();

        pane.pressByTestId(`${PANE_TEST_ID}:row:${subagentId}:disclosure`);
        await testkit.flushHookEffects();
        expect(pane.findByTestId(`${PANE_TEST_ID}:preview:${subagentId}`)).toBeTruthy();
        expect(openDetailsTabSpy).not.toHaveBeenCalled();
        expect(routerPushSpy).not.toHaveBeenCalled();

        // And from the disclosed body, the same destination the row press has.
        pane.pressByTestId(`${PANE_TEST_ID}:preview:${subagentId}:open-details`);
        expect(openDetailsTabSpy).toHaveBeenCalled();
        await pane.unmount();

        const compact = await testkit.renderScreen(<CompactHost sessionId={SESSION_ID} />);
        await testkit.flushHookEffects();
        compact.pressByTestId(`${COMPACT_TEST_ID}:row:${subagentId}:disclosure`);
        await testkit.flushHookEffects();
        expect(compact.findByTestId(`${COMPACT_TEST_ID}:preview:${subagentId}`)).toBeTruthy();
        expect(routerPushSpy).not.toHaveBeenCalled();
        await compact.unmount();
    }, 180_000);

    /**
     * (e) The same entry, told the same way. Ordering had no owner in the compact surface at all —
     * it rode merge order and agreed with the pane only because no agent had a start time. The
     * Truth phase has started writing them, so the two would have diverged on the next release.
     */
    it('prints the same live rows, in the same order, in both hosts', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: [
                { key: 'late', title: 'Started last', status: 'running', createdAt: 9_000, pendingPermission: true },
                { key: 'early', title: 'Started first', status: 'running', createdAt: 1_000 },
                { key: 'done', title: 'Old work', status: 'succeeded', createdAt: 5_000 },
            ],
        });
        seed(fixture);

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        const paneRows = rowIds(pane, PANE_TEST_ID);
        const paneText = pane.getTextContent();
        await pane.unmount();

        const compact = await testkit.renderScreen(<CompactHost sessionId={SESSION_ID} />);
        await testkit.flushHookEffects();
        const compactRows = rowIds(compact, COMPACT_TEST_ID);
        const compactText = compact.getTextContent();
        await compact.unmount();

        const liveIds = [
            testkit.agentActivityFixtureSubagentId('early'),
            testkit.agentActivityFixtureSubagentId('late'),
        ];
        // Oldest first, from the one comparator — not merge order.
        expect(compactRows).toEqual(liveIds);
        // The pane keeps history too, so its live prefix is what must match.
        expect(paneRows.filter((id) => liveIds.includes(id))).toEqual(liveIds);
        // Same entry, same status WORD. A permission-blocked agent is the discriminating case: it is
        // the one the deleted attention model used to route somewhere else entirely.
        expect(compactText).toContain('session.agentActivity.status.waiting');
        expect(paneText).toContain('session.agentActivity.status.waiting');
    }, 120_000);

    /**
     * The compact surface stays bounded, and expands IN PLACE.
     *
     * This is the one property the shared surface must NOT flatten away: the popover is capped at
     * 520pt and already spends most of it on the goal block and the task list, while the pane is the
     * monitoring surface and shows everything. The cap runs inside the section model, so it keeps
     * the rows that have been running longest rather than an arbitrary six — and it routes nowhere,
     * because the right pane is structurally hidden on every phone.
     */
    it('bounds the compact surface at six rows and expands in place, while the pane shows all', async () => {
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            subagents: Array.from({ length: 8 }, (_, index) => ({
                key: `a${index}`,
                title: `Agent ${index}`,
                status: 'running' as const,
                createdAt: 1_000 + index,
            })),
        });
        seed(fixture);

        const compact = await testkit.renderScreen(<CompactHost sessionId={SESSION_ID} />);
        await testkit.flushHookEffects();
        expect(rowIds(compact, COMPACT_TEST_ID)).toHaveLength(6);
        // Oldest first, so the bound keeps the longest-running work rather than whatever merged first.
        expect(compact.getTextContent()).toContain('Agent 0');
        expect(compact.getTextContent()).not.toContain('Agent 7');

        compact.pressByTestId(`${COMPACT_TEST_ID}:show-all:working`);
        await testkit.flushHookEffects();
        expect(rowIds(compact, COMPACT_TEST_ID)).toHaveLength(8);
        expect(compact.getTextContent()).toContain('Agent 7');
        await compact.unmount();

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        expect(rowIds(pane, PANE_TEST_ID)).toHaveLength(8);
        expect(pane.findByTestId(`${PANE_TEST_ID}:show-all:working`)).toBeNull();
        await pane.unmount();
    }, 120_000);

    /**
     * (f) Render what the producer supplied, and nothing more. A workflow agent that reports tokens
     * and tool calls shows them; one that reports nothing shows nothing invented (N-USAGE).
     */
    it('shows the metrics a workflow agent reported and invents none for the agent that reported none', async () => {
        const runId = 'wf_metrics';
        runSnapshots.set(runId, testkit.makeSessionWorkflowRunSnapshot({
            runId,
            title: 'Ship the release',
            status: 'active',
            totalAgents: 2,
            completedAgents: 0,
            agents: [
                {
                    id: 'wfa-rich',
                    title: 'Rich agent',
                    status: 'active',
                    updatedAt: 2_000,
                    tokensUsed: 1_500,
                    toolCalls: 7,
                },
                { id: 'wfa-bare', title: 'Bare agent', status: 'active', updatedAt: 2_000 },
            ],
        }) as SessionWorkflowRunSnapshotV1);

        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            session: {
                metadata: unifiedHeadline({
                    activeEntries: [{
                        entryId: buildAgentActivityEntryId({ kind: 'workflow_run', runId }),
                        kind: 'workflow_run',
                        title: 'Ship the release',
                        status: 'running',
                        updatedAt: 2_000,
                        runId,
                    }],
                }) as never,
            },
        });
        seed(fixture);

        const compact = await testkit.renderScreen(<CompactHost sessionId={SESSION_ID} />);
        await testkit.flushHookEffects();
        const text = compact.getTextContent();
        expect(text).toContain('tools.workflowActivityView.tokens(1.5k)');
        expect(text).toContain('tools.workflowActivityView.toolCalls(7)');
        // The bare agent is present and carries no fabricated figure.
        expect(text).toContain('Bare agent');
        expect(text).not.toContain('tools.workflowActivityView.tokens(0)');
        await compact.unmount();
    }, 120_000);

    /**
     * (W23-a) THREE agents, THREE previews.
     *
     * The collapse failure mode, observed at the UI end: one Workflow tool call owns many agent
     * sidecars, so any design that keyed a transcript on the tool call would have shown every agent
     * the same conversation. Each agent's own sidechain id is what keeps them distinct, so the
     * discriminating assertion is that the three bodies differ — a single shared body passes every
     * "the preview renders" test ever written.
     */
    it('gives three workflow agents three different previews', async () => {
        const runId = 'wf_split';
        const agents = [
            { agentId: 'a1', title: 'Reviewer', sidechainId: 'wf_split/a1', line: 'Reviewed the auth flow' },
            { agentId: 'a2', title: 'Planner', sidechainId: 'wf_split/a2', line: 'Drafted the migration plan' },
            { agentId: 'a3', title: 'Builder', sidechainId: 'wf_split/a3', line: 'Wrote the adapter' },
        ] as const;

        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            session: {
                metadata: unifiedHeadline({
                    activeEntries: agents.map((agent) => workflowAgentEntry({
                        runId,
                        agentId: agent.agentId,
                        title: agent.title,
                        status: 'running',
                        parented: false,
                        sidechainId: agent.sidechainId,
                    })),
                }) as never,
            },
        });
        for (const agent of agents) {
            fixture.reducerState.sidechains.set(agent.sidechainId, [
                testkit.makeAgentActivitySidechainMessage({
                    id: `${agent.agentId}_step`,
                    createdAt: 1_000,
                    toolName: 'Read',
                    toolDescription: `${agent.agentId}.ts`,
                }),
                testkit.makeAgentActivitySidechainMessage({
                    id: `${agent.agentId}_line`,
                    createdAt: 1_001,
                    text: agent.line,
                }),
            ]);
        }
        seed(fixture);

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();

        for (const agent of agents) {
            const entryId = buildAgentActivityEntryId({
                kind: 'workflow_agent',
                runId,
                agentId: agent.agentId,
            });
            expect(pane.getTextContent()).not.toContain(agent.line);
            pane.pressByTestId(`${PANE_TEST_ID}:row:${entryId}`);
            await testkit.flushHookEffects();
            const body = pane.findByTestId(`${PANE_TEST_ID}:preview:${entryId}`);
            expect(body, `${agent.title} preview`).toBeTruthy();
            expect(pane.findByTestId(`${PANE_TEST_ID}:preview:${entryId}:last-line`)).toBeTruthy();
        }

        const text = pane.getTextContent();
        for (const agent of agents) {
            expect(text, `${agent.title} line`).toContain(agent.line);
            expect(text, `${agent.title} step`).toContain(`${agent.agentId}.ts`);
        }
        // An orphan sidechain has no owning tool message, so nothing may advertise a screen for it.
        expect(pane.findByTestId(
            `${PANE_TEST_ID}:preview:${buildAgentActivityEntryId({ kind: 'workflow_agent', runId, agentId: 'a1' })}:open-details`,
        )).toBeNull();
        await pane.unmount();
    }, 180_000);

    /**
     * (W23-b) Nothing loads to DRAW the roster; expanding one row loads exactly that one sidechain.
     *
     * Asserted on a workflow agent on purpose. The roster's meta line already hydrates a bounded set
     * of SUBAGENT sidechains for its activity preview — a different owner answering a different
     * question — so a subagent row could pass this test by accident. A workflow agent's sidechain
     * has no other reader in this process, which makes the count here entirely attributable to the
     * expansion.
     */
    it('loads no sidechain until a row is expanded, then exactly the one that was expanded', async () => {
        const runId = 'wf_lazy';
        const entryId = buildAgentActivityEntryId({ kind: 'workflow_agent', runId, agentId: 'a1' });
        const otherEntryId = buildAgentActivityEntryId({ kind: 'workflow_agent', runId, agentId: 'a2' });
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            session: {
                metadata: unifiedHeadline({
                    activeEntries: [
                        workflowAgentEntry({
                            runId,
                            agentId: 'a1',
                            title: 'Reviewer',
                            status: 'running',
                            parented: false,
                            sidechainId: 'wf_lazy/a1',
                        }),
                        workflowAgentEntry({
                            runId,
                            agentId: 'a2',
                            title: 'Planner',
                            status: 'running',
                            parented: false,
                            sidechainId: 'wf_lazy/a2',
                        }),
                    ],
                }) as never,
            },
        });
        seed(fixture);

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        expect(pane.findByTestId(`${PANE_TEST_ID}:row:${entryId}`)).toBeTruthy();
        expect(sidechainRequests()).toEqual([]);

        pane.pressByTestId(`${PANE_TEST_ID}:row:${entryId}`);
        await testkit.flushHookEffects();
        expect(sidechainRequests()).toEqual(['wf_lazy/a1']);
        expect(sidechainRequests()).not.toContain('wf_lazy/a2');
        expect(pane.findByTestId(`${PANE_TEST_ID}:preview:${otherEntryId}`)).toBeNull();
        await pane.unmount();
    }, 180_000);

    /**
     * (W23-f) The preview is a disclosure inside a 520pt popover, not a transcript.
     *
     * Four hundred messages and four must cost the same body. The derivation is bounded on its own
     * (its unit test pins the model), so what this proves is that the SURFACE renders the bounded
     * model rather than reaching past it for the rest of the sidechain.
     */
    it('keeps the disclosed preview bounded however long the sidechain is', async () => {
        const runId = 'wf_bounded';
        const entryId = buildAgentActivityEntryId({ kind: 'workflow_agent', runId, agentId: 'a1' });
        const fixture = testkit.makeSessionAgentActivityFixture({
            sessionId: SESSION_ID,
            session: {
                metadata: unifiedHeadline({
                    activeEntries: [workflowAgentEntry({
                        runId,
                        agentId: 'a1',
                        title: 'Reviewer',
                        status: 'running',
                        parented: false,
                        sidechainId: 'wf_bounded/a1',
                    })],
                }) as never,
            },
        });
        fixture.reducerState.sidechains.set('wf_bounded/a1', Array.from({ length: 400 }, (_unused, index) =>
            testkit.makeAgentActivitySidechainMessage({
                id: `step_${index}`,
                createdAt: 1_000 + index,
                toolName: 'Read',
                toolDescription: `file_${index}.ts`,
            })));
        seed(fixture);

        const compact = await testkit.renderScreen(<CompactHost sessionId={SESSION_ID} />);
        await testkit.flushHookEffects();
        compact.pressByTestId(`${COMPACT_TEST_ID}:row:${entryId}`);
        await testkit.flushHookEffects();

        const body = compact.findByTestId(`${COMPACT_TEST_ID}:preview:${entryId}`);
        expect(body).toBeTruthy();
        const steps = compact.findAll((node) => (
            typeof node.props?.testID === 'string'
            && node.props.testID.startsWith(`${COMPACT_TEST_ID}:preview:${entryId}:step:`)
        ));
        expect(steps.length).toBeLessThanOrEqual(3);
        // The newest work, not the oldest: a preview that opened on `file_0.ts` would be showing
        // the start of a four-hundred-step transcript.
        expect(compact.getTextContent()).toContain('file_399.ts');
        expect(compact.getTextContent()).not.toContain('file_0.ts');
        await compact.unmount();
    }, 180_000);

    /**
     * (W25-a) The producer-real live run: every agent is INSIDE the panel, and each one still opens
     * its own transcript.
     *
     * This is the case the corridor actually ships and the one it had never tested. A live run's
     * agents are parented, so the partition folds all of them into `SessionWorkflowRunPanel` — the
     * flat list holds none of them — and the panel drew its rows through a path that carried no
     * sidechain id at all. The compact popover is the ONLY agent surface a phone has and it draws
     * that same panel, so a preview reachable only from a listed row was reachable only on a tablet
     * or desktop with the pane open.
     *
     * Three properties in one case, because each alone is passable by a wrong implementation:
     * folded (so this is the real partition, not the unparented shape), distinct per agent (one
     * `Workflow` tool call owns many sidecars, so a body keyed on the run would show all three
     * agents one conversation), and lazy (drawing the panel loads nothing; expanding one row loads
     * exactly that agent's sidechain).
     */
    it('opens each agent transcript from INSIDE a live run panel, in both hosts', async () => {
        const runId = 'wf_producer_live';
        const agents: readonly ProducerRealAgent[] = [
            { agentId: 'a1', title: 'Reviewer', line: 'Reviewed the auth flow' },
            { agentId: 'a2', title: 'Planner', line: 'Drafted the migration plan' },
        ];
        const seeded = seedProducerRealWorkflow({
            runId,
            workflowToolUseId: 'toolu_workflow_1',
            agents,
            live: true,
        });
        const firstEntryId = seeded.entryIdByAgentId.get('a1')!;
        const secondEntryId = seeded.entryIdByAgentId.get('a2')!;

        for (const [testID, host] of [
            [PANE_TEST_ID, <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />] as const,
            [COMPACT_TEST_ID, <CompactHost sessionId={SESSION_ID} />] as const,
        ]) {
            ensureSidechainSpy.mockClear();
            const screen = await testkit.renderScreen(host);
            await testkit.flushHookEffects();

            // The real partition: parented agents are folded into the panel, so the list has none of
            // them. An assertion that passed here on a listed row would be testing the old fixture.
            expect(screen.findByTestId(`${testID}:row:${firstEntryId}`), `${testID} listed row`).toBeNull();
            expect(screen.findByTestId(`workflow-run-panel-${runId}`), `${testID} panel`).toBeTruthy();
            expect(screen.findByTestId(`workflow-agent-${runId}-a1`), `${testID} panel row`).toBeTruthy();
            // Nothing is fetched to DRAW the panel.
            expect(sidechainRequests(), `${testID} idle fetches`).toEqual([]);

            screen.pressByTestId(`workflow-agent-${runId}-a1`);
            await testkit.flushHookEffects();

            expect(screen.findByTestId(`${testID}:preview:${firstEntryId}`), `${testID} preview`).toBeTruthy();
            expect(screen.getTextContent(), `${testID} first line`).toContain(agents[0]!.line);
            expect(screen.getTextContent(), `${testID} first step`).toContain('a1.ts');
            // The second agent's transcript is neither shown nor loaded: one row, one sidechain.
            expect(screen.getTextContent(), `${testID} second line`).not.toContain(agents[1]!.line);
            expect(screen.findByTestId(`${testID}:preview:${secondEntryId}`), `${testID} second preview`).toBeNull();
            expect(sidechainRequests(), `${testID} fetches`).toEqual([seeded.sidechainIdByAgentId.get('a1')]);

            screen.pressByTestId(`workflow-agent-${runId}-a2`);
            await testkit.flushHookEffects();
            expect(screen.getTextContent(), `${testID} second line after expand`).toContain(agents[1]!.line);
            expect(sidechainRequests(), `${testID} both fetches`).toEqual([
                seeded.sidechainIdByAgentId.get('a1'),
                seeded.sidechainIdByAgentId.get('a2'),
            ]);

            await screen.unmount();
        }
    }, 240_000);

    /**
     * (W25-b) The producer-real FINISHED run, which is the other half of the partition.
     *
     * A terminal run is not drawn as a panel — it is history, so it and its agents go into the
     * ordered list — and that listed path is where W23 proved the preview. Proving it again here on
     * the shape a producer publishes (a `workflow_run` entry in `recentEntries`, agents parented to
     * it) is what makes that claim about the product rather than about a fixture.
     *
     * It also pins the deliberate bound: the compact popover answers "what is running", so finished
     * work is absent from it by design (§4.7). That is a scope decision, and the way to keep it a
     * decision rather than a defect is to state it in a test.
     */
    it('lists a finished run\'s agents and opens each transcript from the pane', async () => {
        const runId = 'wf_producer_done';
        const agents: readonly ProducerRealAgent[] = [
            { agentId: 'a1', title: 'Reviewer', line: 'Reviewed the auth flow' },
            { agentId: 'a2', title: 'Planner', line: 'Drafted the migration plan' },
        ];
        const seeded = seedProducerRealWorkflow({
            runId,
            workflowToolUseId: 'toolu_workflow_2',
            agents,
            live: false,
        });
        const firstEntryId = seeded.entryIdByAgentId.get('a1')!;

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />,
        );
        await testkit.flushHookEffects();
        // No panel for a finished run, and its agents are rows in the list beside the run itself.
        expect(pane.findByTestId(`workflow-run-panel-${runId}`)).toBeNull();
        expect(pane.findByTestId(`${PANE_TEST_ID}:row:${seeded.runEntryId}`)).toBeTruthy();
        expect(pane.findByTestId(`${PANE_TEST_ID}:row:${firstEntryId}`)).toBeTruthy();

        pane.pressByTestId(`${PANE_TEST_ID}:row:${firstEntryId}`);
        await testkit.flushHookEffects();
        expect(pane.findByTestId(`${PANE_TEST_ID}:preview:${firstEntryId}`)).toBeTruthy();
        expect(pane.getTextContent()).toContain(agents[0]!.line);
        expect(sidechainRequests()).toEqual([seeded.sidechainIdByAgentId.get('a1')]);
        await pane.unmount();

        const compact = await testkit.renderScreen(<CompactHost sessionId={SESSION_ID} />);
        await testkit.flushHookEffects();
        // Live-only by contract: finished work is not folded away here, it is out of scope here.
        expect(compact.findByTestId(`${COMPACT_TEST_ID}:row:${firstEntryId}`)).toBeNull();
        expect(compact.getTextContent()).not.toContain(agents[0]!.line);
        await compact.unmount();
    }, 240_000);

    /**
     * (W26-a) RULING-16: the session fact is stated ONCE, beside the work, and no row is rewritten.
     *
     * `deriveSessionWorkObservation` has been the answer to "is this session still observing the
     * work it owns" since wave 24 and had no consumer at all, so the roster kept painting running
     * agents of a session nothing has witnessed for decades with no hedge anywhere on screen. The
     * mitigation is a sentence at section level: rewriting each row's status would be a
     * durable-looking claim about work this client never observed, and it would silently move rows
     * between sections while it did it.
     */
    it('states an unobserved session once above the roster, and rewrites no row', async () => {
        seedLiveSubagentSession({ sessionId: SESSION_ID });
        const entryId = testkit.agentActivityFixtureSubagentId('alpha');

        for (const [testID, host] of [
            [PANE_TEST_ID, <SessionRightPanelAgentsView sessionId={SESSION_ID} scopeId="session:s1" />] as const,
            [COMPACT_TEST_ID, <CompactHost sessionId={SESSION_ID} />] as const,
        ]) {
            const screen = await testkit.renderScreen(host);
            await testkit.flushHookEffects();

            expect(screen.findHostByTestId(`${testID}:session-notice`), `${testID} notice`).toBeTruthy();
            expect(noticeCount(screen, UNOBSERVED_KEY), `${testID} notices`).toBe(1);
            // The row is untouched: same title, still announced as running. A consumer that mapped
            // the session fact onto a row would show up here as a rewritten status, which is
            // exactly what stating it at section level exists to avoid.
            const row = screen.findByTestId(`${testID}:row:${entryId}`);
            expect(row, `${testID} row`).toBeTruthy();
            expect(screen.getTextContent(), `${testID} row title`).toContain('Audit the auth flow');
            expect(String(row?.props.accessibilityLabel), `${testID} row status`).toContain(RUNNING_STATUS_KEY);
            await screen.unmount();
        }
    }, 240_000);

    /**
     * (W26-b) The same sentence, in the vocabulary each fact deserves — and silence where another
     * surface already owns the copy.
     *
     * `auth` is named because an expired sign-in is actionable and no surface in this app has ever
     * interpreted it; every other classified stop shares one sentence, because a reader cannot act
     * on a taxonomy of provider failures; and `usage_limit` is deliberately NOT restated here,
     * because the usage-limit banner already owns that copy, its reset time and its recovery
     * action, and a second voice for it is how two surfaces come to disagree about when the session
     * resumes.
     */
    it('names an expired sign-in, defers a usage limit, and says nothing while the session is observed', async () => {
        seedLiveSubagentSession({
            sessionId: 'w26_auth',
            session: { lastRuntimeIssue: runtimeIssue({ source: 'auth_error' }) },
        });
        seedLiveSubagentSession({
            sessionId: 'w26_usage',
            session: { lastRuntimeIssue: runtimeIssue({ source: 'usage_limit', code: 'usage_limit_reached' }) },
        });
        seedLiveSubagentSession({
            sessionId: 'w26_exit',
            session: { lastRuntimeIssue: runtimeIssue({ source: 'provider_process_exit', code: 'provider_exited' }) },
        });
        seedLiveSubagentSession({
            sessionId: 'w26_observed',
            // Live AND witnessed: the runtime is there and something saw it a moment ago.
            session: { active: true, presence: 'online', activeAt: Date.now() },
        });

        const auth = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId="w26_auth" scopeId="session:w26_auth" />,
        );
        await testkit.flushHookEffects();
        expect(auth.findHostByTestId(`${PANE_TEST_ID}:session-notice`)).toBeTruthy();
        expect(noticeCount(auth, STOPPED_AUTH_KEY)).toBe(1);
        await auth.unmount();

        // Every other classified stop shares one sentence: the reader is told the session is not
        // running, not given a taxonomy of provider failures they cannot act on.
        const exited = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId="w26_exit" scopeId="session:w26_exit" />,
        );
        await testkit.flushHookEffects();
        expect(exited.getTextContent()).toContain(STOPPED_KEY);
        expect(exited.getTextContent()).not.toContain(STOPPED_AUTH_KEY);
        await exited.unmount();

        const usage = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId="w26_usage" scopeId="session:w26_usage" />,
        );
        await testkit.flushHookEffects();
        expect(usage.findHostByTestId(`${PANE_TEST_ID}:session-notice`)).toBeNull();
        expect(usage.getTextContent()).not.toContain('sessionNotice');
        await usage.unmount();

        const observed = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId="w26_observed" scopeId="session:w26_observed" />,
        );
        await testkit.flushHookEffects();
        expect(observed.findHostByTestId(`${PANE_TEST_ID}:session-notice`)).toBeNull();
        expect(observed.getTextContent()).not.toContain('sessionNotice');
        await observed.unmount();
    }, 240_000);

    /**
     * (W26-c) The hedge is about work still shown as in flight, so with none of that it is noise.
     *
     * Nearly every session a reader opens is `unobserved` — that is simply what a session not
     * running right now looks like — and the pane keeps history. An unconditional notice would sit
     * permanently above every finished roster in the app, saying that agents which finished
     * yesterday "may no longer be running".
     */
    it('says nothing about an unobserved session whose work has all finished', async () => {
        seedLiveSubagentSession({ sessionId: 'w26_history', status: 'succeeded' });

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId="w26_history" scopeId="session:w26_history" />,
        );
        await testkit.flushHookEffects();
        // The roster is there and the session is unobserved — only the hedge is absent.
        expect(pane.findByTestId(`${PANE_TEST_ID}:row:${testkit.agentActivityFixtureSubagentId('alpha')}`)).toBeTruthy();
        expect(pane.findHostByTestId(`${PANE_TEST_ID}:session-notice`)).toBeNull();
        expect(pane.getTextContent()).not.toContain(UNOBSERVED_KEY);
        await pane.unmount();
    }, 240_000);

    /**
     * (W29-a) The kind nobody publishes is covered by the same sentence, and by nothing else.
     *
     * An agent-team teammate is the ONE kind with no resolver on either side: its status is a
     * membership snapshot derived from the transcript (`deriveClaudeTeamSubagents`), so the CLI
     * teardown never sees it (there is no CLI publisher for this kind) and the client's tool-state
     * sweep cannot reach it either (the status is not derived from tool state). After a stop it
     * therefore stays `running` forever.
     *
     * That is the correct row behaviour and this test asserts it stays that way: an explicit
     * disband IS observable (`TeamDelete` drops the member out of the participant snapshot and the
     * row becomes `terminated`), so the only thing left to "resolve" is a death nobody witnessed —
     * exactly the inference this program has refused three times. What the reader gets instead is
     * the section-level fact, and this pins that it actually reaches THIS kind: the notice's gate is
     * `hasWorkInFlight`, which is the roster's live count, so a teammate that did not reach the
     * roster or was not counted live would leave the hedge silent above a running row.
     */
    it('hedges an unobserved session that only has agent-team members running, and resolves none of them', async () => {
        const member = { teamId: 'review-team', memberId: 'teammate_1', memberLabel: 'Reviewer' };
        seed(testkit.makeSessionAgentActivityFixture({
            sessionId: 'w29_team',
            teamMembers: [member],
        }));
        const entryId = testkit.agentActivityFixtureTeamMemberSubagentId(member);

        const pane = await testkit.renderScreen(
            <SessionRightPanelAgentsView sessionId="w29_team" scopeId="session:w29_team" />,
        );
        await testkit.flushHookEffects();

        const row = pane.findByTestId(`${PANE_TEST_ID}:row:${entryId}`);
        expect(row, 'team member row').toBeTruthy();
        expect(String(row?.props.accessibilityLabel), 'team member status').toContain(RUNNING_STATUS_KEY);
        expect(pane.findHostByTestId(`${PANE_TEST_ID}:session-notice`), 'team notice').toBeTruthy();
        expect(noticeCount(pane, UNOBSERVED_KEY), 'team notices').toBe(1);
        await pane.unmount();
    }, 240_000);
});
