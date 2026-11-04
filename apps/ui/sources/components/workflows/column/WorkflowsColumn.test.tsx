// @vitest-environment jsdom
import * as React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createWorkBoardV1, getBuiltinWorkflowCatalogV1, normalizeSessionListFilterV1 } from '@happier-dev/protocol';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { useBoardMembership } from '@/components/boards/model/useBoardContent';
import { createWorkflowRunSummaryFixture, createWorkflowRunRecentSummaryFixture as recent } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { WorkflowRunStateV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { configureSessionDraftRepository, resetSessionDraftRepositoryForTests, writeNewSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { WorkflowsRunsRoute } from '@/app/(app)/workflows/runs/index';
import { WorkflowsColumn } from './WorkflowsColumn';
import { AppShellColumnContext } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import type { WorkflowDefinitionListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

const searchRuntime = { open: () => {}, buildCommands: () => [] };

function TestAuth({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={boundary?.credentials ?? null}><UniversalSearchRuntimeProvider value={searchRuntime}>{children}</UniversalSearchRuntimeProvider></InjectedAuthProvider>;
}

const executeMock = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const routeState = vi.hoisted(() => ({ pathname: '/workflows', params: {} as Record<string, string> }));
let automationDefinitionResponse: ((url: URL, init?: RequestInit) => Promise<Response | undefined>) | null = null;

// Fixture replies are serialized below the real Action owner by the canonical HTTP boundary.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => routeState.pathname, params: () => routeState.params, router: { push: routerPush } }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// Native recycler boundary: keep the shared list and its real row renderer below it.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original }).module;
});

// Equal-revision merges derive aggregate attention from its invocation/failure evidence.
const waiting = createWorkflowRunSummaryFixture({ id: 'run-waiting', state: 'running', ownerAccountId: 'account-a', startedBy: 'user', attentionRequired: true, invocationAttentionRequired: true });
const running = createWorkflowRunSummaryFixture({ id: 'run-live', state: 'running', ownerAccountId: 'account-a', startedBy: 'user' });

function answerLists() {
    executeMock.mockImplementation(async (actionId: string, input: Record<string, unknown>) => {
        if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
        if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
        if (actionId !== 'workflow.run.list') return { ok: false, error: 'unexpected', errorCode: 'unexpected' };
        if (input.attention === 'required') {
            return { ok: true, result: { runs: [waiting], metadataByRunId: { [waiting.id]: { kind: 'available', value: { title: 'Prepare the release' } } } } };
        }
        if (Array.isArray(input.states)) {
            return { ok: true, result: { runs: [running], metadataByRunId: { [running.id]: { kind: 'available', value: { title: 'Fix a failing test' } } } } };
        }
        return { ok: true, result: { runs: [waiting, running], metadataByRunId: {
            [waiting.id]: { kind: 'available', value: { title: 'Prepare the release' } },
            [running.id]: { kind: 'available', value: { title: 'Fix a failing test' } },
        } } };
    });
}

let previousStorageState = storage.getState();
let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>> | undefined;
let singleton: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
beforeEach(async () => {
    routeState.pathname = '/workflows';
    routeState.params = {};
    previousStorageState = storage.getState();
    webLocks = installWebLockManagerMock();
    singleton = await loadSyncSingletonForTests();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    await runtime.upsertAndActivateServer({ serverUrl: 'http://unified-column.test', scope: 'tab' });
    answerLists();
    // Restore the real Account through its credential and HTTP owners.
    boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'account-a', fixtureResponse: (actionId, input) => executeMock(actionId, input),
        automationDefinitions: async (url, init) => automationDefinitionResponse?.(url, init) });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer(boundary.credentials);
    // Transport restoration does not await the initial cursor/settings acquisition or the
    // endpoint-online resume. Settle those real producers before measuring visible demand;
    // otherwise their snapshot wake races the column and adds an unrelated refresh.
    const { sync } = await import('@/sync/sync');
    expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
    await sync.resumeSync('server-reachable');
    expect(storage.getState().profileScope).toEqual({ serverId: boundary.serverId, accountId: 'account-a' });
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    // The signed-in Account's settings are applied, so the saved-space binding is authoritative (R9).
    storage.setState({
        settingsScope: storage.getState().profileScope, settingsVersion: 1,
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true },
            sessionListLayoutV1: 'projects' },
        sessionListIndexByServerId: { [boundary.serverId]: null }, sessionListRowsByServerId: {},
        workflowRunListWindows: {}, workflowRunsById: {},
    });
    boundary.prime();
});

afterEach(async () => {
    standardCleanup();
    resetSessionDraftRepositoryForTests();
    const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
    resetWorkflowLibraryReadsForTests();
    await boundary?.dispose();
    boundary = undefined;
    singleton?.dispose();
    singleton = undefined;
    automationDefinitionResponse = null;
    executeMock.mockReset();
    routerPush.mockReset();
    storage.setState(previousStorageState);
    webLocks?.restore();
    webLocks = undefined;
});

describe('WorkflowsColumn', () => {
    it('answers Library view Actions from the visible column and rejects hidden or retired scopes', async () => {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const action = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, serverId: boundary!.serverId };
        const column = (visible: boolean) => <PluginSurfaceFocusEligibilityProvider active={visible} presentationActive={visible}>
            <WorkflowsColumn />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(column(true), { wrapper: TestAuth });
        await vi.waitFor(() => expect(screen.findHostByTestId('workflows-column:builtin:builtin:debate')).not.toBeNull());
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true,
            result: { view: 'all', searchQuery: '', visibleKeys: expect.arrayContaining(['builtin:debate']) } });
        await act(async () => {
            expect(await action.execute('workflow.library.view.set', { searchQuery: 'debate' }, context))
                .toEqual({ ok: true, result: { ok: true } });
        });
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true,
            result: { searchQuery: 'debate', visibleKeys: ['builtin:debate'] } });
        expect(screen.findHostByTestId('workflows-column:builtin:builtin:plan-with-a-panel')).toBeNull();
        await act(async () => {
            expect(await action.execute('workflow.library.view.reset', {}, context)).toEqual({ ok: true, result: { ok: true } });
        });
        expect(screen.findHostByTestId('workflows-column:builtin:builtin:plan-with-a-panel')).not.toBeNull();
        expect(await invokeScopeAction('workflow.library.view.set', { searchQuery: 'foreign' }, { runtimeAccountId: 'account-b' }))
            .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        expect(await invokeScopeAction('workflow.library.view.reset', {}, { serverId: 'another-home' }))
            .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        await screen.update(column(false));
        expect(await action.execute('workflow.library.view.get', {}, context))
            .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        await screen.update(column(true));
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true,
            result: { view: 'all', searchQuery: '' } });
        await act(async () => {
            retireActiveServerAccountScopeLifetime();
            expect(await invokeScopeAction('workflow.library.view.set', { searchQuery: 'stale' }, context))
                .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        });
    });

    it('counts held library facts only on value demand without another library or summary read', async () => {
        const answer = executeMock.getMockImplementation()!;
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => {
            if (actionId === 'workflow.definition.list') return Promise.resolve({ ok: true, result: { definitions: ['live', 'quiet'].map(definitionId => ({
                kind: 'workflow-definition.v1', definitionId, metadata: { title: definitionId },
                revision: { headerVersion: 1, bodyVersion: 1 }, contentStatus: 'available', stepCount: 1,
                ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null,
            })) } });
            if (actionId === 'workflow.run.summaries') return Promise.resolve({ ok: true, result: { remainingSourceArtifactIds: [], summaries: [
                { sourceArtifactId: 'live', lastRun: null, recent: [recent({ runId: 'live-run', state: 'running' })], needsYouCount: 0, needsYouRunId: null },
                { sourceArtifactId: 'quiet', lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null },
            ] } });
            return answer(actionId, input);
        });
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await vi.waitFor(() => expect(screen.findHostByTestId('workflows-column:library:quiet')).not.toBeNull());
        await vi.waitFor(() => expect(executeMock.mock.calls.some(call => call[0] === 'workflow.run.summaries')).toBe(true));
        const readCount = () => executeMock.mock.calls.filter(call => call[0] === 'workflow.definition.list' || call[0] === 'workflow.run.summaries').length;
        const reads = readCount();
        await screen.pressByTestIdAsync('workflows-column-space-filter-open');
        await screen.pressByTestIdAsync('collection-filter-add');
        await screen.pressByTestIdAsync('collection-filter-field:view');
        const editor = () => screen.findAll(node => node.props.testID === 'workflows-column-space-editor' && node.props.model)[0]!;
        const options = editor().props.model.availableFields.find((field: { id: string }) => field.id === 'view').valueOptions;
        expect(options).toEqual(expect.arrayContaining([
            expect.objectContaining({ value: 'triggered', count: 0 }), expect.objectContaining({ value: 'running', count: 1 }),
        ]));
        expect(readCount()).toBe(reads);
    });
    it('uses the shared Home reachability line while retaining definitions, and clears it on reconnect', async () => {
        answerLists();
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await act(async () => { storage.setState({ socketStatus: 'error', endpointStatus: 'offline', endpointReason: null }); });
        expect(screen.findHostByTestId('home-unreachable')).not.toBeNull();
        expect(screen.findHostByTestId('home-unreachable-retry')).not.toBeNull();
        expect(screen.findHostByTestId('workflows-column:offline')).toBeNull();
        expect(screen.findHostByTestId('workflows-column:builtin:builtin:plan-with-a-panel')).not.toBeNull();
        await act(async () => { storage.setState({ socketStatus: 'connected', endpointStatus: 'online' }); });
        expect(screen.findHostByTestId('home-unreachable')).toBeNull();
    });
    it('selects only the exact open definition and clears that selection on the library home', async () => {
        answerLists();
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const selected = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAll(node =>
            typeof node.props.testID === 'string' && node.props.testID.startsWith('workflows-column:')
            && typeof node.props.href === 'string' && node.props.selected === true).map(node => node.props.testID);
        const column = () => <DestinationInstanceHost tabId="workflow" ref={{ kind: 'workflows', params: {} }}
            pathname={routeState.pathname} focused visible navigation={{ push: routerPush, replace: () => {}, back: () => {} }}>
            <WorkflowsColumn /></DestinationInstanceHost>;
        routeState.pathname = '/workflows/builtin%3Aplan-with-a-panel';
        const screen = await renderScreen(column(), { wrapper: TestAuth });
        expect(selected(screen)).toEqual(['workflows-column:builtin:builtin:plan-with-a-panel']);
        routeState.pathname = '/workflows/builtin%3Areview-and-converge';
        await screen.update(column());
        expect(selected(screen)).toEqual(['workflows-column:builtin:builtin:review-and-converge']);
        routeState.pathname = '/workflows';
        await screen.update(column());
        expect(selected(screen)).toEqual([]);
    });
    it('shows the reason for unavailable own and shared definitions beside readable neighbors', async () => {
        answerLists();
        const answer = executeMock.getMockImplementation()!;
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => actionId === 'workflow.definition.list'
            ? Promise.resolve({ ok: true, result: { definitions: [
                { kind: 'workflow-definition.v1', definitionId: 'missing-title', metadata: null, revision: null,
                    contentStatus: 'unavailable', contentUnavailableReason: 'invalid_header', stepCount: null,
                    ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null },
                { kind: 'workflow-definition.v1', definitionId: 'shared-bad-body', metadata: { title: 'Shared recipe' }, revision: { headerVersion: 1, bodyVersion: 1 },
                    contentStatus: 'unavailable', contentUnavailableReason: 'invalid_body', stepCount: null,
                    ownerAccountId: 'other-account', access: 'view', triggers: [], nextRunAt: null },
                { kind: 'workflow-definition.v1', definitionId: 'readable', metadata: { title: 'Readable recipe' }, revision: { headerVersion: 1, bodyVersion: 1 },
                    contentStatus: 'available', stepCount: 1, ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null },
            ] } satisfies WorkflowDefinitionListResultV1 }) : answer(actionId, input));
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findHostByTestId('workflows-column:library:readable')).not.toBeNull();
        });
        const { t } = await import('@/text');
        for (const [testID, reason] of [['workflows-column:library:missing-title', 'workflows.contentReasons.invalidHeader'],
            ['workflows-column:shared:shared-bad-body', 'workflows.contentReasons.invalidBody']] as const) {
            const row = screen.findHostByTestId(testID);
            expect(row).not.toBeNull();
            expect(row!.findAll(node => typeof node.props.children === 'string').map(node => node.props.children).join('\n')).toContain(t(reason));
        }
        expect(screen.findHostByTestId('workflows-column:library:readable')).not.toBeNull();
    });
    it('keeps the Library index alive from the shared run summaries: needs you, running, then the last run\'s age', async () => {
        answerLists();
        const answer = executeMock.getMockImplementation()!;
        const definition = (definitionId: string, title: string) => ({ kind: 'workflow-definition.v1', definitionId, metadata: { title },
            revision: { headerVersion: 1, bodyVersion: 1 }, contentStatus: 'available', stepCount: 2, ownerAccountId: 'account-a',
            access: 'owner', triggers: [], nextRunAt: null });
        const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
        const lastRun = (runId: string, state: WorkflowRunStateV1, attentionRequired = false) => ({
            ...recent({ runId, state, attentionRequired, invocationAttentionRequired: attentionRequired }), createdAt: fiveDaysAgo, startedAt: fiveDaysAgo, finishedAt: null });
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => {
            if (actionId === 'workflow.definition.list') return Promise.resolve({ ok: true, result: { definitions: [
                definition('waits', 'Prepare the release'), definition('works', 'Review each file'),
                definition('rests', 'Fix a failing test'), definition('never', 'Triage new issues'),
                definition('interrupted', 'Quiet habit'), definition('paused', 'Daily summary'),
            ] } });
            if (actionId === 'workflow.run.summaries') return Promise.resolve({ ok: true, result: { remainingSourceArtifactIds: [], summaries: [
                { sourceArtifactId: 'waits', lastRun: lastRun('run-w', 'running', true), recent: [recent({ runId: 'run-w', state: 'running', attentionRequired: true, invocationAttentionRequired: true })], needsYouCount: 1, needsYouRunId: 'run-w' },
                { sourceArtifactId: 'works', lastRun: lastRun('run-r', 'running'), recent: [recent({ runId: 'run-r', state: 'running' })], needsYouCount: 0, needsYouRunId: null },
                { sourceArtifactId: 'rests', lastRun: lastRun('run-c', 'succeeded'), recent: [recent({ runId: 'run-c', state: 'succeeded' })], needsYouCount: 0, needsYouRunId: null },
                { sourceArtifactId: 'never', lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null },
                { sourceArtifactId: 'interrupted', lastRun: lastRun('run-i', 'interrupted'), recent: [recent({ runId: 'run-i', state: 'interrupted' })], needsYouCount: 0, needsYouRunId: null },
                { sourceArtifactId: 'paused', lastRun: lastRun('run-p', 'paused'), recent: [recent({ runId: 'run-p', state: 'paused' })], needsYouCount: 0, needsYouRunId: null },
            ] } });
            return answer(actionId, input);
        });
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        const row = (id: string) => screen.findAll(node => node.props.testID === `workflows-column:library:${id}` && typeof node.props.href === 'string')[0]!.props;
        await vi.waitFor(async () => {
            await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
            expect(row('rests').detail).toBeDefined();
        });
        // Needs you and Running are the row's work-status glyph (P4 status words), and Needs you is spoken;
        // a rested one shows how long ago.
        expect(row('waits').accessibilityLabel).toContain('workflows.destination.sections.needsYou');
        expect(row('waits').status).toBeTruthy();
        expect(row('works').status).toBeTruthy();
        expect(row('works').accessibilityLabel).toContain('workflows.destination.sections.running');
        expect(row('works').detail).toBeUndefined();
        expect(row('rests').status).toBeUndefined();
        expect(row('rests').detail).toContain('time.daysAgoShort');
        expect(row('interrupted').detail).toContain('time.daysAgoShort');
        expect(row('paused').detail).toContain('time.daysAgoShort');
        expect(row('never').detail).toBeUndefined();
    });
    it('makes a failed-library retry visibly keyboard focusable with its button role', async () => {
        const answer = executeMock.getMockImplementation()!;
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => actionId === 'workflow.definition.list'
            ? Promise.resolve({ ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId: 'recovered', metadata: { title: 'Recovered workflow' },
                revision: { headerVersion: 1, bodyVersion: 1 }, contentStatus: 'available', stepCount: 1,
                ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null,
            }] } satisfies WorkflowDefinitionListResultV1 }) : answer(actionId, input));
        const artifactRequests: string[] = [];
        let failLibrary = true;
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const http = boundary!;
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            if (target.pathname === '/v1/artifacts' && (target.searchParams.get('kind') === 'other'
                || target.searchParams.get('kinds')?.includes('workflow-definition.v1'))) {
                artifactRequests.push(target.href);
                // Fail the library's filtered header page while metadata bootstrap stays healthy.
                // Breaking both would correctly show the shared Home recovery line.
                if (failLibrary) return Response.json({ items: 'invalid-page' });
            }
            return http.request(url, init);
        });
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await vi.waitFor(async () => {
            await act(async () => {});
            const observation = {
                libraryReads: artifactRequests.length,
                endpoint: storage.getState().endpointStatus,
                endpointReason: storage.getState().endpointReason,
                endpointError: storage.getState().endpointLastErrorMessage,
                homeUnavailable: screen.findHostByTestId('home-unreachable') !== null,
                failed: screen.findHostByTestId('workflows-column:library:failed') !== null,
                retry: screen.findHostByTestId('workflows-column:library:failed:retry') !== null,
            };
            expect(observation.retry, JSON.stringify(observation)).toBe(true);
        });
        // One cause, one message: the column says what the library home says, from the same copy.
        const failedText = screen.getTextContent();
        expect(failedText).toContain('workflows.loadFailedTitle');
        expect(failedText).toContain('workflows.loadFailedBody');
        const target = () => screen.tree.findHostByTestId('workflows-column:library:failed:retry')!;
        // A line recovery paints no ring of its own: the keyboard ring is the shared document ring
        // (theme.css `:where(:focus-visible)`), which only shows while the host neither suppresses the
        // outline inline nor leaves the tab order.
        const hostOutlineStyle = () => StyleSheet.flatten(typeof target().props.style === 'function'
            ? target().props.style({ pressed: false }) : target().props.style)?.outlineStyle;
        expect(target().props.role ?? target().props.accessibilityRole).toBe('button');
        expect(target().props.tabIndex ?? 0).not.toBe(-1);
        expect(hostOutlineStyle()).not.toBe('none');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await act(async () => { target().props.onFocus({ target: { matches: () => true } }); });
        expect(hostOutlineStyle()).not.toBe('none');
        expect(target().props.role ?? target().props.accessibilityRole).toBe('button');
        const requestsBeforeRetry = artifactRequests.length;
        failLibrary = false;
        await screen.pressByTestIdAsync('workflows-column:library:failed:retry');
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(artifactRequests.length).toBeGreaterThan(requestsBeforeRetry);
            expect(screen.findHostByTestId('workflows-column:library:recovered')).not.toBeNull();
            expect(screen.findHostByTestId('workflows-column:library:failed')).toBeNull();
        });
    });

    it('uses the shared starter and attention predicate for a Board Runs filter', async () => {
        answerLists();
        const serverId = storage.getState().profileScope!.serverId;
        const board = { ...createWorkBoardV1({ id: 'run-filter', name: 'Runs' }), source: {
            // Empty is an explicit match-nothing selection. A waiting user Run supplements
            // this agent selection; the ordinary user Run must remain excluded.
            picked: [], filter: normalizeSessionListFilterV1({ show: 'runs', startedBy: ['agents'], homeServerIds: [serverId] }),
        } };
        const hook = await renderHook(() => useBoardMembership(board, {
            activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id) => id === serverId,
        }));
        await vi.waitFor(async () => {
            await act(async () => {});
            const observation = { complete: hook.getCurrent().complete, filter: board.source.filter,
                actions: executeMock.mock.calls.map(([actionId]) => actionId),
                runIds: Object.values(storage.getState().workflowRunsById).map(row => row.id) };
            expect(hook.getCurrent().members.map((member) => [member.ref.kind, member.ref.qualifiedId.id]), JSON.stringify(observation))
                .toEqual([['workflow_run', 'run-waiting']]);
            expect(hook.getCurrent().complete).toBe(true);
        });
    });
    it('opens the Runs deep link as the same list rather than a separate History collection', async () => {
        answerLists();
        // Without a shell column (a phone), the destination's column-as-page opens on Runs.
        routeState.pathname = '/workflows/runs';
        const screen = await renderScreen(<WorkflowsRunsRoute />, { wrapper: TestAuth });
        routeState.pathname = '/workflows';
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findHostByTestId('workflow-run-row:run-waiting')).not.toBeNull();
        });

        expect(screen.tree.root.findAll((node) => node.props?.testID === 'sessions-list-keyboard-frame').length).toBeGreaterThan(0);
        expect(screen.tree.root.findAll((node) => /^workflows-history:view:/.test(String(node.props?.testID ?? '')))).toHaveLength(0);
        const rows = screen.tree.root.findAll((node) => node.props?.testID === 'workflow-run-row:run-waiting' && typeof node.props.onPress === 'function');
        expect(rows.length).toBeGreaterThan(0);
        await act(async () => { rows[0]!.props.onPress(); });
        expect(routerPush).toHaveBeenCalledWith('/workflows/runs/run-waiting?serverId=unified-column.test');
    });

    it('keeps the library in main beside a column that already lists Runs (DESIGN-16 D9)', async () => {
        answerLists();
        routeState.pathname = '/workflows/runs';
        try {
            const screen = await renderScreen(<AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
                <WorkflowsRunsRoute />
            </AppShellColumnContext.Provider>, { wrapper: TestAuth });
            await act(async () => { await Promise.resolve(); await Promise.resolve(); });
            // The column is the one Runs list; main never repeats it.
            expect(screen.findAllHostsByTestId('sessions-list-keyboard-frame')).toHaveLength(0);
        } finally {
            routeState.pathname = '/workflows';
        }
    });

    it('reveals Account triggers from an old link even while the retained column shows Runs', async () => {
        answerLists();
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await screen.pressByTestIdAsync('workflows-column:view:runs');
        routeState.params = { trigger: 'legacy-manual' };
        // The router mock has no navigation subscription; changing a presentation prop delivers its new params.
        await screen.update(<WorkflowsColumn surface="page" />);
        expect(screen.findByTestId('workflows-column:group:builtin')).not.toBeNull();
        expect(screen.findAllHostsByTestId('sessions-list-keyboard-frame')).toHaveLength(0);
    });
    it('lets the Runs view open a run through the shared Sessions list', async () => {
        answerLists();
        const scope = storage.getState().profileScope!;
        configureSessionDraftRepository({ scope, syncEnabled: false });
        const draftId = '99999999-9999-4999-8999-999999999999';
        writeNewSessionDraft({ scope, draftId, patch: { text: 'Unsent Session draft' }, materializationIntent: 'seeded' });
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        const runsTabs = screen.tree.root.findAll((node) => node.props?.testID === 'workflows-column:view:runs' && typeof node.props.onPress === 'function');
        expect(runsTabs.length).toBeGreaterThan(0);
        await act(async () => { runsTabs[0]!.props.onPress(); });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findHostByTestId('workflow-run-row:run-waiting')).not.toBeNull();
        });

        expect(screen.tree.root.findAll((node) => node.props?.testID === 'sessions-list-keyboard-frame').length).toBeGreaterThan(0);
        expect(screen.tree.root.findAll((node) => /workflows-column:(needsYou|running|history):/.test(String(node.props?.testID ?? '')))).toHaveLength(0);
        const runRows = screen.tree.root.findAll((node) => node.props?.testID === 'workflow-run-row:run-waiting' && typeof node.props.onPress === 'function');
        expect(runRows.length).toBeGreaterThan(0);
        expect(screen.findByTestId(`session-draft-row:new-session:${draftId}`)).toBeNull();
        const filterTrigger = screen.findByTestId('session-list-filter-trigger');
        expect(filterTrigger?.props.accessibilityLabel).toContain('sessionsList.filtersShowRuns');
        expect(filterTrigger?.props.accessibilityLabel).not.toContain('sessionsList.filtersMyWork');
        expect(screen.findByTestId('session-list-filter-summary-reset')).toBeTruthy();
        await act(async () => { runRows[0]!.props.onPress(); });
        expect(routerPush).toHaveBeenCalledWith('/workflows/runs/run-waiting?serverId=unified-column.test');

        await screen.pressByTestIdAsync('session-list-search-trigger');
        await act(async () => { screen.changeTextByTestId('session-list-search-input', 'release'); });
        expect(screen.findByTestId('workflow-run-row:run-waiting')).toBeTruthy();
        expect(screen.findAllHostsByTestId('session-list-filtered-no-results')).toHaveLength(0);
        const filteredCounts = screen.tree.root.findAll((node) => node.props.controller?.fixedShow === 'runs' && node.props.filterResult !== undefined);
        expect(filteredCounts.length).toBeGreaterThan(0);
        for (const node of filteredCounts) expect(node.props.filterResult).toMatchObject({ coverage: 'complete', matchedCount: 1 });
        await screen.pressByTestIdAsync('session-list-filter-trigger');
        const { buildSessionListConditionLabels } = await import('@/components/sessions/shell/search/SessionListFilterControl');
        const editors = screen.findAll(node => node.props.fixedShow === 'runs' && node.props.result !== undefined);
        expect(editors.length).toBeGreaterThan(0);
        for (const editor of editors) expect(editor.props.result).toMatchObject({ coverage: 'complete', matchedCount: 1 });
        expect(screen.findHostByTestId('collection-filter-count')?.props.children).toBe(buildSessionListConditionLabels().resultCount(1));
        await screen.pressByTestIdAsync('workflows-column:view:definitions');
        expect(screen.findAllHostsByTestId('session-list-search-input')).toHaveLength(0);
        await screen.pressByTestIdAsync('workflows-column:view:runs');
        expect(screen.findByTestId('session-list-search-input')?.props.value).toBe('release');
    });

    it('switches Definitions and Runs inside one list whose switch stays put, with the spaces only over definitions (R8-7)', async () => {
        answerLists();
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        const list = screen.findHostByTestId('workflows-column:list');
        const tabs = screen.findHostByTestId('workflows-column:view:runs');
        expect(list).not.toBeNull();
        expect(screen.findHostByTestId('workflows-column-space-title')).not.toBeNull();
        await screen.pressByTestIdAsync('workflows-column:view:runs');
        // The same list and switch stay mounted (the thumb glides); Run rows never take a definition space.
        expect(screen.findHostByTestId('workflows-column:list')).toBe(list);
        expect(screen.findHostByTestId('workflows-column:view:runs')).toBe(tabs);
        // It is in the same band under the title in both views, so the title row's width never moves it.
        const inBand = () => screen.findHostByTestId('workflows-column:view-band')!
            .findAll((node) => node.props.testID === 'workflows-column:view:runs').length > 0;
        expect(inBand()).toBe(true);
        expect(screen.findAllHostsByTestId('workflows-column-space-title')).toHaveLength(0);
        expect(screen.findAllHostsByTestId('workflows-column-space-strip')).toHaveLength(0);
        await screen.pressByTestIdAsync('workflows-column:view:definitions');
        expect(screen.findHostByTestId('workflows-column:list')).toBe(list);
        expect(inBand()).toBe(true);
        expect(screen.findHostByTestId('workflows-column-space-title')).not.toBeNull();
    });

    it('narrows the column and the library home through one Workflow draft, built-ins included, without the home\'s own view pills (R8-7)', async () => {
        answerLists();
        const { WorkflowsLibraryHome } = await import('@/components/workflows/library/WorkflowsLibraryHome');
        const screen = await renderScreen(<>
            <WorkflowsColumn />
            <WorkflowsLibraryHome />
        </>, { wrapper: TestAuth });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        const builtins = getBuiltinWorkflowCatalogV1();
        await vi.waitFor(() => expect(screen.findHostByTestId('workflows-home-space-title')).not.toBeNull());
        expect(screen.findAll(node => /^workflows-home:filter:/.test(String(node.props?.testID ?? '')))).toHaveLength(0);
        for (const entry of builtins) {
            expect(screen.findHostByTestId(`workflows-column:builtin:${entry.id}`)).not.toBeNull();
            expect(screen.findHostByTestId(`workflow-builtins:${entry.id}`)).not.toBeNull();
        }
        // The home's search writes the one draft the column reads.
        await act(async () => { screen.changeTextByTestId('workflows-home:search', 'debate'); });
        for (const entry of builtins) {
            const kept = entry.id === 'builtin:debate';
            expect(screen.findHostByTestId(`workflows-column:builtin:${entry.id}`) !== null).toBe(kept);
            expect(screen.findHostByTestId(`workflow-builtins:${entry.id}`) !== null).toBe(kept);
        }
        // A view no built-in matches (none carries a trigger) removes the whole Built-in group from both.
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const action = createDefaultActionExecutor();
        await act(async () => {
            expect(await action.execute('workflow.library.view.set', { filters: { view: 'triggered' }, searchQuery: '' },
                { surface: 'agent', serverId: boundary!.serverId })).toEqual({ ok: true, result: { ok: true } });
        });
        expect(screen.findAllHostsByTestId('workflows-column:group:builtin')).toHaveLength(0);
        for (const entry of builtins) {
            expect(screen.findHostByTestId(`workflows-column:builtin:${entry.id}`)).toBeNull();
            expect(screen.findHostByTestId(`workflow-builtins:${entry.id}`)).toBeNull();
        }
        await act(async () => {
            expect(await action.execute('workflow.library.view.reset', {}, { surface: 'agent', serverId: boundary!.serverId }))
                .toEqual({ ok: true, result: { ok: true } });
        });
        // Retiring the focused page must reveal the still-present column's registration.
        await screen.update(<WorkflowsColumn />);
        expect(await action.execute('workflow.library.view.get', {}, { surface: 'agent', serverId: boundary!.serverId }))
            .toMatchObject({ ok: true, result: { view: 'all', searchQuery: '' } });
        await screen.unmount();
        expect(await action.execute('workflow.library.view.get', {}, { surface: 'agent', serverId: boundary!.serverId }))
            .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        // The neighbouring focused page also answers on its own, without borrowing a column bridge.
        const home = await renderScreen(<WorkflowsLibraryHome />, { wrapper: TestAuth });
        expect(await action.execute('workflow.library.view.get', {}, { surface: 'agent', serverId: boundary!.serverId }))
            .toMatchObject({ ok: true, result: { view: 'all', searchQuery: '' } });
        await act(async () => {
            expect(await action.execute('workflow.library.view.set', { searchQuery: 'debate' },
                { surface: 'agent', serverId: boundary!.serverId })).toEqual({ ok: true, result: { ok: true } });
        });
        expect(home.findHostByTestId('workflow-builtins:builtin:debate')).not.toBeNull();
        expect(home.findHostByTestId('workflow-builtins:builtin:plan-with-a-panel')).toBeNull();
        await act(async () => {
            expect(await action.execute('workflow.library.view.reset', {}, { surface: 'agent', serverId: boundary!.serverId }))
                .toEqual({ ok: true, result: { ok: true } });
        });
        expect(home.findHostByTestId('workflow-builtins:builtin:plan-with-a-panel')).not.toBeNull();
    });

    it('lists the built-ins as the column\'s own navigation rows, leaving their controls to the built-in page', async () => {
        answerLists();
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        expect(screen.findByTestId('workflows-column:group:builtin')).toBeTruthy();
        for (const entry of getBuiltinWorkflowCatalogV1()) {
            // One row anatomy in the column: no inline Run now / Choose a session… beside the row.
            expect(screen.findAllHostsByTestId(`workflow-builtins:${entry.id}:run`)).toHaveLength(0);
            expect(screen.findAllHostsByTestId(`workflow-builtins:${entry.id}:session`)).toHaveLength(0);
            const mark = screen.findAll(node => node.props.testID === `workflows-column:builtin:${entry.id}`)[0]!;
            const marks = mark.findAll(node => typeof node.props.name === 'string').map(node => node.props.name);
            const expectedMark = { goal: 'target', review: 'shield-check', plan: 'list-checks', pull_request: 'git-pull-request' }[entry.purpose];
            expect(marks).toContain(expectedMark);
            await screen.pressByTestIdAsync(`workflows-column:builtin:${entry.id}`);
            expect(routerPush).toHaveBeenLastCalledWith(createWorkflowDefinitionRoute(entry.id));
        }
    });


    it('lists saved and Account Workflows as one Library and opens each at its own target (Q7)', async () => {
        const [{ AutomationDefinitionDetailSchema, AutomationDefinitionListResponseSchema }, { AutomationStoredWorkflowDefinitionRecipeV2Schema },
            { createWorkflowDefinitionFixture }] = await Promise.all([import('@happier-dev/protocol/automations/automationApiV3'),
            import('@happier-dev/protocol/automations/automationWorkflowRecipeV2'), import('@/dev/testkit/fixtures/workflowRunFixtures')]);
        const definitionId = '10000000-0000-4000-8000-000000000071';
        const inlineDefinition = createWorkflowDefinitionFixture({
            defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
            blocks: [{ kind: 'step', id: 'first', document: { text: 'Morning digest', references: [], attachments: [] },
                input: [], result: { kind: 'text' } }],
        });
        const detail = AutomationDefinitionDetailSchema.parse({ id: 'digest', name: 'Morning digest', description: null, enabled: true,
            workflowDefinitionId: null, scopeSessionId: null, targetType: null, existingSessionId: null,
            templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 5,
            assignments: [{ machineId: 'm1', enabled: true, priority: 0, updatedAt: 1 }],
            executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 1,
                workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition } },
                triggerEvidence: null }),
            triggers: [{ id: 't1', revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'schedule',
                triggerDefinitionEnvelope: null, nextRunAt: null,
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } }],
        });
        const { executionRecipe: _privateRecipe, triggers, ...listItem } = detail;
        const list = AutomationDefinitionListResponseSchema.parse({ automations: [{ ...listItem,
            triggers: triggers.map(({ triggerDefinitionEnvelope: _privateEnvelope, ...trigger }) => trigger) }], nextCursor: null });
        automationDefinitionResponse = async (url, init) => {
            if (url.pathname === '/v3/automations/query' && init?.method === 'POST') {
                const { AutomationDefinitionDetailsRequestSchema } = await import('@happier-dev/protocol/automations/automationApiV3');
                const query = AutomationDefinitionDetailsRequestSchema.parse(JSON.parse(String(init.body)));
                return Response.json({ automations: query.scope === 'account_inline' ? [detail] : [], nextCursor: null });
            }
            return url.pathname === '/v3/automations' ? Response.json(list)
                : url.pathname === '/v3/automations/digest' ? Response.json(detail) : undefined;
        };
        const answer = executeMock.getMockImplementation()!;
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => {
            if (actionId === 'workflow.definition.list') return Promise.resolve({ ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId, metadata: { title: 'Release notes' }, updatedAt: 1,
                revision: { headerVersion: 1, bodyVersion: 1 }, contentStatus: 'available', stepCount: 1,
                ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null,
            }] } });
            return answer(actionId, input);
        });
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth,
            createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(40, 40, 120, 40) }) });
        await vi.waitFor(() => expect(screen.findByTestId('workflows-column:library:account-trigger:digest')).not.toBeNull());
        await vi.waitFor(() => expect(screen.findByTestId(`workflows-column:library:${definitionId}`)).not.toBeNull());
        // One list: one heading counting both kinds, no separate trigger group, the owner's one order.
        expect(screen.findByTestId('workflows-column:group:triggers')).toBeNull();
        expect(screen.findAll(node => node.props?.testID === 'workflows-column:group:library' && 'count' in node.props)[0]?.props.count).toBe(2);
        const libraryRows = screen.findAll(node => typeof node.props?.testID === 'string' && typeof node.props.onPress === 'function'
            && /^workflows-column:library:/.test(node.props.testID) && node.props.title !== undefined).map(node => node.props.testID as string);
        expect([...new Set(libraryRows)]).toEqual(['workflows-column:library:account-trigger:digest', `workflows-column:library:${definitionId}`]);
        // The Account Workflow's trigger is its quiet line; it carries no switch of its own.
        expect(screen.findAll(node => node.props?.testID === 'workflows-column:library:account-trigger:digest' && 'subtitle' in node.props)[0]
            ?.props.subtitle).toBe('workflows.triggers.summary.everyDayAt(time=9:00 AM)');
        expect(screen.findByTestId('workflows-column:trigger:digest-switch')).toBeNull();
        // A saved workflow opens its editor; an Account Workflow opens its settings where it stands.
        await screen.pressByTestIdAsync(`workflows-column:library:${definitionId}`);
        expect(routerPush).toHaveBeenCalledWith(createWorkflowDefinitionRoute(definitionId));
        await screen.pressByTestIdAsync('workflows-column:library:account-trigger:digest');
        await vi.waitFor(() => expect(screen.findByTestId('workflows-column-trigger-popover')).not.toBeNull());
        expect(routerPush).toHaveBeenCalledTimes(1);
    });
});
// Third-party rendering boundary; the collection does not render Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
