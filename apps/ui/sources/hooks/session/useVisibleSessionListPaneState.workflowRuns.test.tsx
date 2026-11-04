import React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkBoardV1} from '@happier-dev/protocol/boards/workBoardV1';
import { normalizeSessionListFilterV1} from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { WorkflowRunListRequestV1Schema} from '@happier-dev/protocol/workflows/actionsV1';
import {
    WorkflowRunRecipientCensusResponseV1Schema} from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { materializeWorkflowAcceptedSnapshotV1} from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import {
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1} from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/run-cause';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowRunListStorageFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { sessionListRuntimeClock } from './sessionListRuntimeClock';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { getActiveServerSnapshot, upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
const { loadHomeViewState, saveHomeViewState, setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { getActiveServerAccountScope, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { useWorkflowRunWindow, resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
const { useBoardMembership } = await import('@/components/boards/model/useBoardContent');
const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
const { useSessionListSelectionState } = await import('./useSessionListSelectionState');
const { clearSessionListViewFilterRetentionForTests } = await import('@/components/sessions/shell/search/useSessionListViewFilters');
const { resetSessionListPaneRetentionForTests } = await import('@/components/sessions/shell/sessionListPaneRetention');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { useSessionListViewFilterController } = await import('@/components/sessions/shell/search/useSessionListViewFilterController');
const { SessionsListPaneContent } = await import('@/components/sessions/shell/SessionsListPaneContent');
const { SessionsListViewWithFilterController } = await import('@/components/sessions/shell/SessionsList');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { UniversalSearchRuntimeProvider } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const route = '/v3/automations/runs/workflow-storage';
// Only the HTTP answer is controlled; Account/Action admission, parsing, projection and Board membership stay real.
const readPage = vi.fn<() => Promise<Readonly<{ runs: readonly WorkflowRunSummaryV1[]; nextCursor?: string; unavailable?: boolean }>>>();
// Markdown is a third-party rendering boundary; these hooks never render Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/' }).module;
});

// The composed destination renders through the canonical platform boundary factories; the
// third-party Legend recycler (every virtualized list's only backend) is the replaced boundary.
const { legendListMock } = await vi.hoisted(async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return { legendListMock: createCapturingLegendListMock({ renderItems: true }) };
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@legendapp/list/react-native')>(),
    ...legendListMock.module,
}));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

let serverId: string;
let previousStorageState = storage.getState();
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousAppliedAvailability = isAppliedActiveServerRuntimeAvailable();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let singleton: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | undefined;

beforeEach(async () => {
    previousStorageState = storage.getState();
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousAppliedAvailability = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    singleton = await loadSyncSingletonForTests();
    serverId = await home.addHome({ serverUrl: 'http://unified-list.test', name: 'List Home', accountId: 'account-a' });
    installPageAnswer(serverId);
    connection = await restoreServerAccountForTest({ serverUrl: 'http://unified-list.test', accountId: 'account-a', request: home.request });
    storage.setState({
        profileScope: { serverId, accountId: 'account-a' },
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true },
            sessionListLayoutV1: 'recent_activity' },
        sessionListIndexByServerId: { [serverId]: null },
        sessionListRowsByServerId: {},
        workflowRunListWindows: {},
        workflowRunsById: {},
    });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    readPage.mockReset();
    expect(getActiveServerAccountScope()).toEqual({ serverId, accountId: 'account-a' });
});

afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
    singleton?.dispose();
    singleton = undefined;
    await home.reset();
    resetServerFeaturesClientForTests();
    clearSessionListViewFilterRetentionForTests();
    resetSessionListPaneRetentionForTests();
    resetWorkflowLibraryReadsForTests();
    retireActiveServerAccountScopeLifetime();
    storage.setState(previousStorageState);
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousAppliedAvailability);
});

function installPageAnswer(targetServerId: string, featureServerId = targetServerId) {
    home.answer(targetServerId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    primeServerFeaturesSnapshot({ serverId: featureServerId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    home.answer(targetServerId, route, { select: async (input) => {
        if (!input || typeof input !== 'object' || !('operation' in input) || input.operation !== 'list' || !('request' in input)) {
            throw new Error('Unexpected Workflow storage operation');
        }
        WorkflowRunListRequestV1Schema.parse(input.request);
        const page = await readPage();
        if (page.unavailable) return { status: 503, body: { error: 'content_unavailable' } };
        const acceptedEnvelopesByRunId: Record<string, string> = {};
        const keyCensusByRunId: Record<string, ReturnType<typeof WorkflowRunRecipientCensusResponseV1Schema.parse>> = {};
        for (const run of page.runs) {
            const materialized = await materializeWorkflowAcceptedSnapshotV1({
                definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }] }),
                admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
                context: { source: run.origin.kind === 'automation' ? { kind: 'automation', automationId: run.origin.automationId } : { kind: 'inline' }, inputs: {}, machineId: run.machineId, executionTarget: { kind: 'session' },
                    workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                    ...(run.origin.kind === 'direct' ? { origin: run.origin } : {}), authorization: { principal: { kind: 'host' } },
                    ...(run.origin.kind === 'automation' ? { actionCaller: { kind: 'automationRun' as const, runId: run.id,
                        automationId: run.origin.automationId, cause: AutomationRunCauseSchema.parse(run.origin.cause) } } : {}) },
            });
            if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
            acceptedEnvelopesByRunId[run.id] = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
            keyCensusByRunId[run.id] = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
                access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
                ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        }
        return { body: { runs: page.runs, acceptedEnvelopesByRunId, keyCensusByRunId, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) } };
    } });
}

function filter(show: 'runs' | 'both' | 'sessions' = 'runs') {
    return normalizeSessionListFilterV1({ homeServerIds: [serverId], show });
}

function runFixture(overrides: Parameters<typeof createWorkflowRunSummaryFixture>[0] = {}) {
    return createWorkflowRunSummaryFixture({ ownerAccountId: 'account-a',
        origin: overrides.startedBy === 'trigger' ? { kind: 'automation', automationId: 'automation-1',
            cause: AutomationRunCauseSchema.parse({ kind: 'trigger', triggerId: 'trigger-1', triggerRevision: 1,
                triggerKind: 'schedule', occurrenceKey: 'A'.repeat(43), occurredAt: 1, evidence: { scheduledFor: 1 } }) }
            : { kind: 'direct' }, ...overrides });
}

describe('the mounted unified list feed', () => {
    it('pages full private Runs for the mounted Session list across the Machines journey', async () => {
        const { Dimensions } = await import('react-native');
        const { HAPPIER_COLLECTION_ROW_METRICS } = await import('@happier-dev/plugin-ui/presentation');
        // Exercise a ten-row viewport using the same metric as the Run window owner.
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1200, height: 10 * HAPPIER_COLLECTION_ROW_METRICS.height.compact, scale: 1, fontScale: 1 });
        const runs = Array.from({ length: 37 }, (_, index) => runFixture({
            id: `viewport-run-${String(index).padStart(2, '0')}`,
            createdAt: new Date(Date.UTC(2026, 8, 8) - index * 1000).toISOString(),
        }));
        const corpus = await createWorkflowRunListStorageFixture({ runs,
            definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
                document: { text: 'Accepted private context. '.repeat(8000), references: [], attachments: [] } }] }),
            metadata: { title: 'Private accepted title' },
        });
        const bodyFor = (page: readonly WorkflowRunSummaryV1[], nextCursor?: string) => ({
            runs: page, acceptedEnvelopesByRunId: Object.fromEntries(page.map(run => [run.id, corpus.acceptedEnvelopesByRunId[run.id]])),
            keyCensusByRunId: Object.fromEntries(page.map(run => [run.id, corpus.keyCensusByRunId[run.id]])),
            ...(nextCursor ? { nextCursor } : {}),
        });
        const transfers: { rows: number; bytes: number }[] = [];
        // Only the HTTP boundary is scripted. Real Account admission, Actions,
        // private-envelope opening, list projection and the shared store run beneath it.
        home.answer(serverId, route, { select: input => {
            if (!input || typeof input !== 'object' || !('operation' in input) || input.operation !== 'list' || !('request' in input)) {
                throw new Error('Unexpected Workflow storage operation');
            }
            const request = WorkflowRunListRequestV1Schema.parse(input.request);
            const start = request.cursor ? runs.findIndex(run => run.id === request.cursor) + 1 : 0;
            const page = runs.slice(start, start + (request.limit ?? runs.length));
            const body = bodyFor(page, start + page.length < runs.length ? page.at(-1)!.id : undefined);
            transfers.push({ rows: page.length, bytes: Buffer.byteLength(JSON.stringify(body)) });
            return { body };
        } });
        const hook = await renderHook(({ pathname }: { pathname: string }) =>
            useVisibleSessionListPaneState('all', { pathname, workFilter: filter('both') }),
        { initialProps: { pathname: '/' } });
        await flushHookEffects();
        console.info('Workflow viewport transfer', { corpusRows: runs.length,
            unpagedBytes: Buffer.byteLength(JSON.stringify(bodyFor(runs))), initial: transfers[0] });
        expect(transfers.map(page => page.rows)).toEqual([10]);
        expect(hook.getCurrent().workflowRunWindow?.rows).toHaveLength(10);
        for (const pathname of ['/machines', '/machines/all', '/machines/machine-1']) {
            await hook.rerender({ pathname });
        }
        expect(transfers).toHaveLength(1);
        for (let page = 1; hook.getCurrent().workflowRunWindow?.hasMore && page <= runs.length; page++) {
            await act(async () => { hook.getCurrent().workflowRunWindow?.loadMore(); });
            await flushHookEffects();
        }
        const window = hook.getCurrent().workflowRunWindow;
        expect(window?.hasMore).toBe(false);
        expect(window?.runIds).toEqual(runs.map(run => run.id));
        expect(transfers.map(page => page.rows)).toEqual([10, 10, 10, 7]);
        expect(window?.rows.every(row => row.metadata?.kind === 'available'
            && row.metadata.value.title === 'Private accepted title'
            && row.summary?.where?.directory === '/repo' && row.callerAccess?.canEdit === true)).toBe(true);
    });

    it('retains the Sessions pane projection when a row age advances the shared clock', async () => {
        vi.useFakeTimers();
        const row = createSessionListRenderableSessionFixture({ id: 'quiet-session', active: false,
            metadata: { path: '/repo' } });
        storage.getState().applyServerScopedSessionListRows(serverId, [row], { source: 'ordinary', mode: 'replace' });
        const options = { workFilter: filter('sessions') };
        let publications = 0;
        const hook = await renderHook(() => {
            const pane = useVisibleSessionListPaneState('all', options);
            React.useEffect(() => { publications++; }, [pane]);
            return pane;
        });
        const rowClock = {};
        try {
            await flushHookEffects({ cycles: 1, turns: 2 });
            expect(hook.getCurrent().visibleSessionListIndex?.some(item => item.type === 'session' && item.sessionId === row.id)).toBe(true);
            const before = hook.getCurrent();
            const settledPublications = publications;
            sessionListRuntimeClock.requestWake(rowClock, Date.now() + 60_000);
            await flushHookEffects({ advanceTimersMs: 60_000, cycles: 1, turns: 2 });
            expect(publications).toBe(settledPublications);
            expect(hook.getCurrent()).toBe(before);
            expect(home.requestsFor(route)).toEqual([]);
        } finally {
            sessionListRuntimeClock.clearWake(rowClock);
            await hook.unmount();
            vi.useRealTimers();
        }
    });

    it.each(['you', 'triggers'] as const)('switches the Sessions destination from Sessions to Runs through its shared filter controller for %s', async (starter) => {
        readPage.mockResolvedValue({ runs: [
            runFixture({ id: 'user-run', startedBy: 'user' }),
            runFixture({ id: 'trigger-run', startedBy: 'trigger' }),
        ] });
        storage.getState().mergeSessionListRowsForServerScope(serverId, [createSessionListRenderableSessionFixture()]);
        storage.setState({
            ordinarySessionListMembershipByServerId: { [serverId]: ['session-1'] },
            sessionListIndexByServerId: { [serverId]: [{ type: 'session', serverId, sessionId: 'session-1', groupKey: 'sessions', groupKind: 'project' }] },
        });
        await prepareSessionDraftPersistenceStorage();
        const screen = await renderScreen(
            <InjectedAuthProvider credentials={null}>
                <UniversalSearchRuntimeProvider value={{ open: () => {}, buildCommands: () => [] }}>
                    <SessionsListPaneContent storageKind="all" fallbackGuidanceVariant="sidebar" pathname="/" />
                </UniversalSearchRuntimeProvider>
            </InjectedAuthProvider>,
        );
        const controller = screen.findByType(SessionsListViewWithFilterController).props.filterController as ReturnType<typeof useSessionListViewFilterController>;
        await act(async () => { controller.updateFilters(current => ({ ...current, show: 'runs', startedBy: [starter] })); });
        await flushHookEffects();
        const selectedRunId = starter === 'you' ? 'user-run' : 'trigger-run';
        const excludedRunId = starter === 'you' ? 'trigger-run' : 'user-run';
        const pane = screen.findByType(SessionsListViewWithFilterController).props.paneState;
        expect(pane.visibleSessionListIndex.filter((item: { type: string }) => item.type !== 'header')).toEqual([
            expect.objectContaining({ type: 'workflow_run', runId: selectedRunId, serverId }),
        ]);
        expect(screen.findByTestId(`workflow-run-row:${selectedRunId}`)).toBeTruthy();
        expect(screen.findByTestId(`workflow-run-row:${excludedRunId}`)).toBeNull();
        await act(async () => { controller.updateFilters(current => ({ ...current, show: 'sessions' })); });
        await flushHookEffects();
        expect(screen.findByTestId(`workflow-run-row:${selectedRunId}`)).toBeNull();
        const sessionsPane = screen.findByType(SessionsListViewWithFilterController).props.paneState;
        expect(sessionsPane.visibleSessionListIndex.filter((item: { type: string }) => item.type !== 'header')).toEqual([
            expect.objectContaining({ type: 'session', sessionId: 'session-1', serverId }),
        ]);
    });

    it('renders and counts a loaded Run while the Sessions source is null', async () => {
        readPage.mockResolvedValue({ runs: [runFixture({ startedBy: 'user' })] });
        const hook = await renderHook(() => useVisibleSessionListPaneState('all', { workFilter: filter() }));
        await flushHookEffects();
        expect(hook.getCurrent().visibleSessionListIndex).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'workflow_run', runId: 'run-1', serverId }),
        ]));
        expect(hook.getCurrent().summary).toEqual({ sessionsReady: true, sessionCount: 1 });
        expect(hook.getCurrent().queryPresentation).toEqual({ kind: 'ready', complete: true });
    });

    it('makes a loaded empty Runs window ready and reports a failed read instead of onboarding', async () => {
        readPage.mockResolvedValueOnce({ runs: [] });
        const hook = await renderHook(() => useVisibleSessionListPaneState('all', { workFilter: filter() }));
        await flushHookEffects();
        expect(hook.getCurrent().summary).toEqual({ sessionsReady: true, sessionCount: 0 });
        expect(hook.getCurrent().visibleSessionListIndex).toEqual([]);
        expect(hook.getCurrent().showEmptyState).toBe(false);
        readPage.mockResolvedValueOnce({ runs: [], unavailable: true });
        await act(async () => { hook.getCurrent().workflowRunWindow?.retry(); });
        await flushHookEffects();
        expect(hook.getCurrent().queryPresentation).toEqual({ kind: 'error', retainedRows: false });
    });

    it('invalidates retained projection when the starter filter changes, preserving attention runs', async () => {
        readPage.mockResolvedValue({ runs: [
            runFixture({ id: 'user-run', startedBy: 'user' }),
            runFixture({ id: 'trigger-run', startedBy: 'trigger' }),
            runFixture({ id: 'attention-run', startedBy: 'trigger', attentionRequired: true }),
        ] });
        let workFilter = filter();
        const hook = await renderHook(() => useVisibleSessionListPaneState('all', { workFilter }));
        await flushHookEffects();
        const ids = () => hook.getCurrent().visibleSessionListIndex?.flatMap((item) => item.type === 'workflow_run' ? [item.runId] : []);
        expect(ids()).toEqual(expect.arrayContaining(['user-run', 'attention-run']));
        expect(ids()).not.toContain('trigger-run');
        workFilter = normalizeSessionListFilterV1({ ...workFilter, startedBy: ['triggers'] });
        await hook.rerender();
        expect(ids()).toEqual(expect.arrayContaining(['trigger-run', 'attention-run']));
        expect(ids()).not.toContain('user-run');
    });

    it('issues no Run read for an inactive, archived or Sessions-only surface', async () => {
        for (const options of [
            { workFilter: filter(), sessionListSurfaceDataActive: false },
            { workFilter: filter(), corpusStorage: 'archived' as const },
            { workFilter: filter('sessions') },
        ]) {
            const hook = await renderHook(() => useVisibleSessionListPaneState('all', options));
            await flushHookEffects();
            await hook.unmount();
        }
        expect(home.requestsFor(route)).toEqual([]);
    });

    it('uses the same FIN Run window and filter for Board membership, preserving paged incompleteness', async () => {
        readPage.mockResolvedValue({ runs: [
            runFixture({ id: 'user-run', startedBy: 'user' }),
            runFixture({ id: 'trigger-run', startedBy: 'trigger' }),
            runFixture({ id: 'attention-run', startedBy: 'trigger', attentionRequired: true }),
        ], nextCursor: 'page-2' });
        const board = { ...createWorkBoardV1({ id: 'board-1', name: 'Runs' }), source: { filter: filter(), picked: [] } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await flushHookEffects();
        expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['user-run', 'attention-run']);
        expect(hook.getCurrent().complete).toBe(false);
    });

    it('does not authorize Board pruning after the Run window fails with retained members', async () => {
        readPage.mockResolvedValueOnce({ runs: [runFixture({ startedBy: 'user' })] });
        const board = { ...createWorkBoardV1({ id: 'board-1', name: 'Runs' }), source: { filter: filter(), picked: [] } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const hook = await renderHook(() => ({ membership: useBoardMembership(board, homes), window: useWorkflowRunWindow('all') }));
        await flushHookEffects();
        expect(hook.getCurrent().membership.complete).toBe(true);
        expect(hook.getCurrent().membership.members.map((member) => member.ref.qualifiedId.id)).toEqual(['run-1']);
        readPage.mockResolvedValueOnce({ runs: [], unavailable: true });
        await act(async () => { hook.getCurrent().window.retry(); });
        await flushHookEffects();
        expect(hook.getCurrent().membership.complete).toBe(false);
        expect(hook.getCurrent().membership.members.map((member) => member.ref.qualifiedId.id)).toEqual(['run-1']);
    });

    it('qualifies a Run by portable Home identity when the filter names its saved alias', async () => {
        await connection?.dispose();
        const id = await home.addHome({ serverUrl: 'http://unified-list-alias.test', name: 'Alias Home', accountId: 'account-a' });
        const profile = { id, serverUrl: 'http://unified-list-alias.test' };
        const portableId = 'srv_unified-list-alias';
        const identified = await setServerProfileIdentityForUrl(profile.serverUrl, portableId);
        expect(identified).not.toBeNull();
        expect(identified?.serverIdentityId).toBe(portableId);
        installPageAnswer(profile.id, portableId);
        connection = await restoreServerAccountForTest({ serverUrl: profile.serverUrl,
            serverIdentityId: portableId, accountId: 'account-a', request: home.request });
        storage.setState({
            profileScope: { serverId: portableId, accountId: 'account-a' },
            sessionListIndexByServerId: { [profile.id]: null },
        });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        expect(getActiveServerAccountScope()).toEqual({ serverId: portableId, accountId: 'account-a' });
        readPage.mockResolvedValue({ runs: [runFixture({ startedBy: 'user' })] });
        const workFilter = normalizeSessionListFilterV1({ homeServerIds: [profile.id], show: 'runs' });
        const hook = await renderHook(() => useVisibleSessionListPaneState('all', { workFilter }));
        await flushHookEffects();
        expect(hook.getCurrent().visibleSessionListIndex).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'workflow_run', runId: 'run-1', serverId: portableId }),
        ]));
    });

    it('keeps the active Home Run visible and reports the mounted second Home as unavailable', async () => {
        const other = await upsertServerProfileOnly({ serverUrl: 'http://unified-list-second.test', name: 'Second Home' });
        const previousView = loadHomeViewState();
        await saveHomeViewState({ version: 1, groups: [{ id: 'two-homes', name: 'Two Homes',
            serverIds: [serverId, other.id], presentation: 'grouped' }],
            activeTargetKind: 'group', activeTargetId: 'two-homes' });
        try {
            readPage.mockResolvedValue({ runs: [
                runFixture({ startedBy: 'user' }),
            ] });
            const workFilter = normalizeSessionListFilterV1({ show: 'runs', homeServerIds: [serverId, other.id] });
            const hook = await renderHook(() => ({
                selection: useSessionListSelectionState(),
                pane: useVisibleSessionListPaneState('all', { workFilter }),
            }));
            await flushHookEffects();
            expect(hook.getCurrent().selection.allowedServerIds).toEqual(expect.arrayContaining([serverId, other.id]));
            expect(hook.getCurrent().pane.visibleSessionListIndex).toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'workflow_run', runId: 'run-1', serverId }),
            ]));
            expect(hook.getCurrent().pane.queryPresentation).toEqual({ kind: 'partial',
                unavailableHomes: [{ serverId: other.id, reason: 'unsupported' }],
            });
            expect(hook.getCurrent().pane.summary).toEqual({ sessionsReady: true, sessionCount: 1 });
            await hook.unmount();
        } finally {
            await saveHomeViewState(previousView ?? { version: 1, groups: [], activeTargetKind: 'server', activeTargetId: serverId });
        }
    });
});
