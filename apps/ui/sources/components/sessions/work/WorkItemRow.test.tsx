import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunSnapshotV1';

import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import type { SessionWorkSources } from './sessionWorkSources';

import type { WorkItem, WorkProjectionInput } from './workProjection';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE = { serverId: 'server-1', accountId: 'account-1' };
const rowPaints = new Map<string, number>();

/** The exact-Run reader's Action client is the network boundary (as in the Run screen's tests). */
const detailActions = vi.hoisted(() => ({
    getRun: vi.fn(),
    listInvocations: vi.fn(),
}));
vi.mock('@/sync/domains/workflows/workflowRunDetailActions', () => ({
    workflowRunDetailActions: detailActions,
}));

// Only the storage environment is replaced: the Run invocation window is the real canonical domain.
installSessionSubagentCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        const text = createTextModuleMock();
        // Preserve this suite's key-only copy boundary except for the spoken row's source facts.
        return createTextModuleMock({ translate: (key, params) => key === 'sessionWork.row.a11y' ? text.t(key, params) : key });
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: React.PropsWithChildren<{ testID?: string }>) => {
                if (props.testID?.startsWith('session-work-summary:')) rowPaints.set(props.testID, (rowPaints.get(props.testID) ?? 0) + 1);
                return React.createElement('View', props, children);
            },
        });
    },
    storage: async () => {
        const { create } = await import('zustand');
        const { createWorkflowRunsDomain } = await import('@/sync/store/domains/workflowRuns');
        type Domain = import('@/sync/store/domains/workflowRuns').WorkflowRunsDomain;
        const store = create<Domain>()((set, get) => createWorkflowRunsDomain<Domain>({ set, get }));
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({ storage: store, useActiveServerAccountScope: () => SCOPE });
    },
});

// Install boundary options before importing owners that can initialize React Native or storage.
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { activateStorageAccountScope } = await import('@/dev/testkit/mocks/storage');
const { createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } =
    await import('@/dev/testkit/fixtures/workflowRunFixtures');
const { readSessionWorkStatusFacts } = await import('@/components/work/status/sessionWorkStatusFacts');
const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');

let activeScope: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;
beforeEach(async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    activeScope = await activateStorageAccountScope(SCOPE, storage);
});
afterEach(() => {
    activeScope?.dispose();
    activeScope = null;
});

function needsYouSession(): WorkItem {
    return {
        key: 'session:checkout',
        kind: 'session',
        title: 'Checkout UI retry states',
        agentId: 'claude',
        facts: ['Claude'],
        parentKey: null,
        level: 0,
        status: { state: 'permission_required', bucket: 'needs_you', tone: 'attention', attentionType: 'approval', word: 'Needs your permission' },
        progress: null,
        open: { kind: 'session', sessionId: 'checkout' },
    };
}

// Load the row's module graph outside the per-test assertion deadline instead of
// lengthening the deadline.
const { groupWorkByState, projectWork } = await import('./workProjection');
const { WORKER_KIND_GLYPHS } = await import('./workerKindGlyphs');
await import('./WorkItemRow');

describe('WorkItemRow', () => {
    it('keeps a retained Work row clock silent while hidden and reopens with the current completion', async () => {
        const { WorkItemRow } = await import('./WorkItemRow');
        const now = Date.parse('2026-09-30T12:00:00.000Z');
        vi.useFakeTimers({ now });
        const census = installTimerCensus((stack) => stack.includes('sessionListRuntimeClock') ? 'relative-age' : null);
        const onOpen = vi.fn();
        const item: WorkItem = { ...needsYouSession(), atMs: now - 90_000,
            status: { state: 'unread', bucket: 'finished', tone: 'neutral', attentionType: null, word: 'Unread' } };
        const draw = (active: boolean, value = item) => <PluginSurfaceFocusEligibilityProvider active={active}>
            <WorkItemRow item={value} onOpen={onOpen} />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(draw(true));
        try {
            expect(screen.getTextContent()).toContain('1m');
            expect(census.read()).toEqual([{ kind: 'timeout', delayMs: 30_000, consumer: 'relative-age' }]);
            await screen.update(draw(false));
            const before = census.readFires();
            await act(async () => { vi.advanceTimersByTime(300_000); });
            expect(census.readFires()).toEqual(before);
            expect(census.read()).toEqual([]);
            const updated: WorkItem = { ...item, title: 'New completion', atMs: Date.now() - 120_000,
                status: { ...item.status, state: 'finished_unseen', word: 'Newly finished' } };
            await screen.update(draw(false, updated));
            await screen.update(draw(true, updated));
            expect(screen.getTextContent()).toContain('2m');
            expect(screen.getTextContent()).toContain('New completion');
            expect(screen.findByTestId('session-work-row:session:checkout')?.props.accessibilityLabel).toContain('Newly finished');
            await act(async () => { screen.pressByTestId('session-work-row:session:checkout'); });
            expect(onOpen).toHaveBeenCalledWith(updated);
        } finally {
            await screen.unmount();
            census.stop();
            vi.useRealTimers();
        }
    });
    it('uses the same session identity glyph as worker updates', async () => {
        const { presentWorkItem } = await import('./WorkItemRow');
        expect(presentWorkItem(needsYouSession()).iconName).toBe(WORKER_KIND_GLYPHS.session);
    });
    it('keeps an offline row\'s corner quiet: its word says Offline, nothing in it is still going (Recent, lab convo-W2)', async () => {
        const { presentWorkItem } = await import('./WorkItemRow');
        const offline: WorkItem = { ...needsYouSession(), status: { state: 'disconnected', bucket: 'offline', tone: 'neutral', attentionType: null, word: 'Offline' } };
        expect(presentWorkItem(offline).phase).toBe('finished');
        expect(presentWorkItem({ ...needsYouSession(), status: { state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working' } }).phase).toBe('live');
    });
    it('does not repaint unchanged real rows when another projected Session changes', async () => {
        const { WorkItemRow } = await import('./WorkItemRow');
        const source = (id: string) => ({ sessionId: id, managerSessionId: id === 'a' ? 'b' : 'lead', title: id, agentId: 'claude', facts: [],
            statusFacts: readSessionWorkStatusFacts(createSessionListRenderableSessionFixture({ id, active: id === 'a', thinking: id === 'a', thinkingAt: 1000, activeAt: 1000 }), 1000), stalled: false, archived: false });
        const a = source('a');
        const b = source('b');
        const input: WorkProjectionInput = { sessionId: 'lead', reportSessions: [a, b], managedRuns: [], agentEntries: [], workflowHeadlineRuns: [],
            ownTriggerRunIds: new Set(), describeAgentStatus: (entry) => entry.status, describeProgress: () => '' };
        const first = projectWork(input);
        const onOpen = vi.fn();
        const draw = (items: readonly WorkItem[]) => <>{items.map((item) => <WorkItemRow key={item.key} item={item} onOpen={onOpen} />)}</>;
        const firstGroups = groupWorkByState(first);
        // The child lives in another state group: grouping must flatten it without replacing it
        // again on the next unrelated update.
        expect(first.sessions.find((item) => item.key === 'session:a')?.level).toBe(1);
        expect(firstGroups.working.find((item) => item.key === 'session:a')?.level).toBe(0);
        const screen = await renderScreen(draw([...firstGroups.needsYou, ...firstGroups.working, ...firstGroups.recent]));
        const before = rowPaints.get('session-work-summary:session:a');
        expect(before).toBeGreaterThan(0);
        const next = projectWork({ ...input, reportSessions: [a, { ...b, title: 'Updated B' }] }, first);
        const nextGroups = groupWorkByState(next, firstGroups);
        await screen.update(draw([...nextGroups.needsYou, ...nextGroups.working, ...nextGroups.recent]));
        expect(rowPaints.get('session-work-summary:session:a')).toBe(before);
        expect(screen.getTextContent()).toContain('Updated B');
    });
    it('states where the work stands and opens it, with no answer controls on the row (S-1)', async () => {
        const { WorkItemRow } = await import('./WorkItemRow');
        const onOpen = vi.fn();
        const item = needsYouSession();
        const screen = await renderScreen(<WorkItemRow item={item} onOpen={onOpen} />);

        expect(screen.getTextContent()).toContain('Needs your permission');
        expect(screen.getTextContent()).toContain('Checkout UI retry states');
        // One pressable: the row itself. Allow / Deny live on the transcript card, the peek and the Inbox.
        const pressables = screen.findAll((node) => typeof node.props.onPress === 'function' && node.props.testID?.startsWith('session-work-row'));
        expect(pressables.length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toMatch(/Allow|Deny/);

        await act(async () => {
            screen.pressByTestId('session-work-row:session:checkout');
        });
        expect(onOpen).toHaveBeenCalledWith(item);
    });

    it("keeps a title's distinguishing end whole when the row truncates it, so sibling rows stay apart", async () => {
        const { WorkItemRow } = await import('./WorkItemRow');
        const item: WorkItem = { ...needsYouSession(), key: 'session:child-a', title: 'ORC QA seed 13 child A' };
        const screen = await renderScreen(<WorkItemRow item={item} titleTailStart={15} onOpen={vi.fn()} />);

        const tail = screen.findHostByTestId('session-work-summary:session:child-a:title-tail');
        expect(tail?.props.numberOfLines).toBe(1);
        expect(screen.getTextContent()).toContain('child A');
        // The shared start is the part that gives way.
        const head = screen.findHostByTestId('session-work-summary:session:child-a:title');
        expect(JSON.stringify(head?.children)).toContain('ORC QA seed 13');
        expect(JSON.stringify(head?.children)).not.toContain('child A');
    });

    it('says what kind of work a row is first in its subtitle, then what it is doing', async () => {
        const { presentWorkItem } = await import('./WorkItemRow');
        const session = needsYouSession();
        const run: WorkItem = {
            ...session,
            key: 'run:review',
            kind: 'workflow_run',
            agentId: null,
            facts: ['7 of 12'],
            open: { kind: 'workflow_run', runId: 'review' },
        };

        // The Agent mark says the engine; the line says the kind and then what the Session is doing (lab convo-W8full).
        expect(presentWorkItem({ ...session, facts: ['asks a question'] }).facts).toEqual(['sessionWork.kinds.session', 'asks a question']);
        expect(presentWorkItem({ ...session, agentId: null, facts: [] }).facts).toEqual(['sessionWork.kinds.session']);
        expect(presentWorkItem(run).facts).toEqual(['sessionWork.kinds.workflowRun', '7 of 12']);
    });

    it('ends a quiet settled row with when it last moved, strong while unseen, and keeps a word that means something', async () => {
        const { WorkItemRow } = await import('./WorkItemRow');
        const settled = (state: string, word: string, atMs: number | null): WorkItem => ({
            ...needsYouSession(), key: `session:${state}`, title: `Row ${state}`, facts: [], atMs,
            status: { state, bucket: 'finished', tone: 'neutral', attentionType: null, word },
        });
        const unread = await renderScreen(<WorkItemRow item={settled('unread', 'Unread', Date.now() - 18 * 60_000)} onOpen={vi.fn()} />);
        // "Unread" is not a state to read down a list: the time is (the title's weight carries unseen).
        expect(unread.getTextContent()).toContain('18m');
        expect(unread.getTextContent()).not.toContain('Unread');
        await unread.unmount();
        // A state with its own meaning keeps its word.
        const stopped = await renderScreen(<WorkItemRow item={settled('stopped', 'Stopped', Date.now() - 18 * 60_000)} onOpen={vi.fn()} />);
        expect(stopped.getTextContent()).toContain('Stopped');
        expect(stopped.getTextContent()).not.toContain('18m');
        await stopped.unmount();
    });

    it('never says the same words as its title and its kind: an untitled run reads its time, not "Workflow run / Workflow run"', async () => {
        const { presentWorkItem } = await import('./WorkItemRow');
        const { describeWorkKind } = await import('./workerKindGlyphs');
        const untitled: WorkItem = {
            ...needsYouSession(),
            key: 'run:untitled',
            kind: 'workflow_run',
            title: describeWorkKind('workflow_run'),
            agentId: null,
            facts: ['10:42'],
            open: { kind: 'workflow_run', runId: 'untitled' },
        };
        expect(presentWorkItem(untitled).facts).toEqual(['10:42']);
        expect(presentWorkItem({ ...untitled, title: 'Memory upkeep' }).facts).toEqual([describeWorkKind('workflow_run'), '10:42']);
    });
});

function workingRun(runId: string): WorkItem {
    return {
        key: `run:${runId}`,
        kind: 'workflow_run',
        title: 'Review each changed file',
        agentId: null,
        facts: [],
        parentKey: null,
        level: 0,
        status: { state: 'running', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Running' },
        progress: null,
        open: { kind: 'workflow_run', runId },
    };
}

function observedSnapshot(runId: string): SessionWorkflowRunSnapshotV1 {
    return {
        v: 1,
        projectionVersion: 1,
        runId,
        backendId: 'claude',
        title: 'Review each changed file',
        status: 'active',
        recordRevision: '1',
        updatedAt: 1,
        totalAgents: 2,
        completedAgents: 1,
        phases: [{ id: 'review', title: 'Review the files', order: 0, agentIds: ['a1', 'a2'] }],
        agents: [
            { id: 'a1', title: 'Review payments.ts', status: 'complete', updatedAt: 1 },
            { id: 'a2', title: 'Review ledger.ts', status: 'active', updatedAt: 1 },
        ],
    };
}

function workSources(input: Readonly<{
    snapshots?: readonly SessionWorkflowRunSnapshotV1[];
    managedRunIds?: readonly string[];
}>): SessionWorkSources {
    return {
        sessionId: 'lead',
        serverId: 'server-1',
        workflowActivity: {
            headline: null,
            activeRuns: [],
            runDetailById: new Map(),
            loadedRunsById: new Map((input.snapshots ?? []).map((snapshot) => [snapshot.runId, snapshot])),
        },
        managedRuns: {
            phase: 'loaded',
            runs: (input.managedRunIds ?? []).map((id) => createWorkflowRunSummaryFixture({ id })),
            attentionRunIds: new Set(),
            refreshFailed: false,
            retry: () => {},
        },
        // Neither is read by a row's map.
        agentActivity: {} as SessionWorkSources['agentActivity'],
        projection: {} as SessionWorkSources['projection'],
    };
}

/** A scroll owner whose on-screen answer the test decides, as the Work pane's ScrollView does. */
function createTestViewport(initiallyVisible: boolean) {
    let visible = initiallyVisible;
    const observers = new Set<(next: boolean) => void>();
    return {
        viewport: {
            observe: (_target: unknown, onChange: (next: boolean) => void) => {
                observers.add(onChange);
                onChange(visible);
                return () => { observers.delete(onChange); };
            },
        },
        setVisible(next: boolean) {
            visible = next;
            for (const observer of observers) observer(next);
        },
    };
}

const MANAGED_DEFINITION = createWorkflowDefinitionFixture({
    blocks: [
        {
            kind: 'step',
            id: 'analyze',
            name: 'Analyze the repository',
            document: { text: 'Analyze the repository', references: [], attachments: [] },
            input: [],
            result: { kind: 'text' },
        },
        {
            kind: 'step',
            id: 'report',
            name: 'Write the report',
            document: { text: 'Write the report', references: [], attachments: [] },
            input: [],
            result: { kind: 'text' },
        },
    ] as never,
});

function managedInvocations(analyzeLifecycle: 'running' | 'completed') {
    return {
        invocations: [
            createWorkflowInvocationIndexFixture({ id: 'root', runId: 'run-1', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
            createWorkflowInvocationIndexFixture({
                id: 'analyze-row',
                runId: 'run-1',
                parentRecordId: 'root',
                memberOrdinal: '0',
                sequence: '1',
                lifecycle: analyzeLifecycle,
                // A lifecycle change is a new fact about the row.
                contentRevision: analyzeLifecycle === 'running' ? '0' : '1',
            }),
        ],
        parentRevision: 1,
    };
}

/** Lets the reads a render started settle and render (the Action client resolves asynchronously). */
async function settleReads(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('WorkItemRow compact live map (INT §6 I4: workflow runs keep their mini-map)', () => {
    beforeEach(() => {
        detailActions.getRun.mockReset();
        detailActions.listInvocations.mockReset();
        detailActions.getRun.mockResolvedValue({ run: createWorkflowRunSummaryFixture({ id: 'run-1' }), definition: MANAGED_DEFINITION });
        detailActions.listInvocations.mockResolvedValue(managedInvocations('running'));
    });

    it("draws a working run's map from the Session's already-loaded activity, with no read of its own", async () => {
        const { WorkItemRow, WorkViewportContext } = await import('./WorkItemRow');
        const { SessionWorkSourcesProvider } = await import('./sessionWorkSources');
        const viewport = createTestViewport(true);
        const screen = await renderScreen(
            <SessionWorkSourcesProvider value={workSources({ snapshots: [observedSnapshot('wf-1')] })}>
                <WorkViewportContext.Provider value={viewport.viewport}>
                    <WorkItemRow item={workingRun('wf-1')} onOpen={vi.fn()} />
                </WorkViewportContext.Provider>
            </SessionWorkSourcesProvider>,
        );

        expect(screen.findAllHostsByTestId('session-work-minimap:run:wf-1').length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('Review payments.ts');
        expect(screen.getTextContent()).toContain('Review ledger.ts');
        expect(detailActions.getRun).not.toHaveBeenCalled();
    });

    it('mounts the map, and its reads, only while the row is on screen', async () => {
        const { WorkItemRow, WorkViewportContext } = await import('./WorkItemRow');
        const { SessionWorkSourcesProvider } = await import('./sessionWorkSources');
        const viewport = createTestViewport(false);
        const screen = await renderScreen(
            <SessionWorkSourcesProvider value={workSources({ managedRunIds: ['run-1'] })}>
                <WorkViewportContext.Provider value={viewport.viewport}>
                    <WorkItemRow item={workingRun('run-1')} onOpen={vi.fn()} />
                </WorkViewportContext.Provider>
            </SessionWorkSourcesProvider>,
        );
        expect(screen.findAllHostsByTestId('session-work-minimap:run:run-1')).toHaveLength(0);
        expect(detailActions.getRun).not.toHaveBeenCalled();
        expect(detailActions.listInvocations).not.toHaveBeenCalled();

        await act(async () => { viewport.setVisible(true); });
        await settleReads();
        expect(detailActions.getRun).toHaveBeenCalledTimes(1);
        expect(detailActions.listInvocations).toHaveBeenCalledTimes(1);
        expect(screen.findAllHostsByTestId('session-work-minimap:run:run-1').length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('Analyze the repository');
        expect(screen.getTextContent()).toContain('Write the report');
        expect(screen.findAllHostsByTestId('session-work-minimap:run:run-1-node-analyze-state').length).toBeGreaterThan(0);
        expect(screen.findAllHostsByTestId('session-work-minimap:run:run-1-node-report-state')).toHaveLength(0);

        await act(async () => { viewport.setVisible(false); });
        expect(screen.findAllHostsByTestId('session-work-minimap:run:run-1')).toHaveLength(0);
    });

    it("keeps a managed run's map live on the Run's Account-change wake without re-reading its frozen definition", async () => {
        const { WorkItemRow, WorkViewportContext } = await import('./WorkItemRow');
        const { SessionWorkSourcesProvider } = await import('./sessionWorkSources');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const viewport = createTestViewport(true);
        const screen = await renderScreen(
            <SessionWorkSourcesProvider value={workSources({ managedRunIds: ['run-1'] })}>
                <WorkViewportContext.Provider value={viewport.viewport}>
                    <WorkItemRow item={workingRun('run-1')} onOpen={vi.fn()} />
                </WorkViewportContext.Provider>
            </SessionWorkSourcesProvider>,
        );
        const stateText = () => screen
            .findAllByTestId('session-work-minimap:run:run-1-node-analyze-state')
            .map((node) => node.props.lifecycle)
            .filter(Boolean)
            .join('|');
        await settleReads();
        expect(stateText()).toBe('running');
        expect(detailActions.getRun).toHaveBeenCalledTimes(1);

        detailActions.listInvocations.mockResolvedValue(managedInvocations('completed'));
        await act(async () => { publishHomeAccountChange('server-1', ['workflow-run:run-1']); });
        await settleReads();

        expect(detailActions.listInvocations).toHaveBeenCalledTimes(2);
        expect(detailActions.getRun).toHaveBeenCalledTimes(1);
        expect(stateText()).toBe('completed');
    });

    it('measures rows against the Work scroll viewport: a hidden pane or a row scrolled away is off screen', async () => {
        const { useWorkScrollViewport } = await import('./WorkItemRow');
        type Rect = readonly [number, number, number, number];
        const measurable = (rect: Rect) => ({
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(...rect),
        });
        const scrollRect: { current: Rect } = { current: [0, 100, 320, 400] };
        const scrollRef = { current: { getNativeScrollRef: () => ({
            measureInWindow: (callback: (x: number, y: number, w: number, h: number) => void) => callback(...scrollRect.current),
        }) } };
        let api: ReturnType<typeof useWorkScrollViewport> | null = null;
        function Harness() {
            api = useWorkScrollViewport(scrollRef);
            return null;
        }
        await renderScreen(<Harness />);
        const seen: Record<string, boolean[]> = { inside: [], below: [] };
        api!.viewport.observe({ current: measurable([0, 150, 320, 52]) }, (visible) => seen.inside.push(visible));
        api!.viewport.observe({ current: measurable([0, 900, 320, 52]) }, (visible) => seen.below.push(visible));
        expect(seen.inside.at(-1)).toBe(true);
        expect(seen.below.at(-1)).toBe(false);

        // The retained pane is hidden: it lays out at zero size.
        scrollRect.current = [0, 0, 0, 0];
        act(() => { api!.onLayout(); });
        expect(seen.inside.at(-1)).toBe(false);
    });

    it('does not admit live map work when its row or viewport cannot be measured', async () => {
        const { useWorkScrollViewport } = await import('./WorkItemRow');
        const scrollRef = { current: null };
        let api: ReturnType<typeof useWorkScrollViewport> | null = null;
        function Harness() {
            api = useWorkScrollViewport(scrollRef);
            return null;
        }
        await renderScreen(<Harness />);
        const seen: boolean[] = [];
        api!.viewport.observe({ current: null }, (visible) => seen.push(visible));
        expect(seen).toEqual([false]);
    });
});
