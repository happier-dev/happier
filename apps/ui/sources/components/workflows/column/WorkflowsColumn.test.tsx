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
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { configureSessionDraftRepository, resetSessionDraftRepositoryForTests, writeNewSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { WorkflowsRunsRoute } from '@/app/(app)/workflows/runs/index';
import { WorkflowsColumn } from './WorkflowsColumn';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

const searchRuntime = { open: () => {}, buildCommands: () => [] };

function TestAuth({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={null}><UniversalSearchRuntimeProvider value={searchRuntime}>{children}</UniversalSearchRuntimeProvider></InjectedAuthProvider>;
}

const executeMock = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const routeState = vi.hoisted(() => ({ pathname: '/workflows', params: {} as Record<string, string> }));

// The Action front door is the transport boundary; the list clients, parsers, Run store and
// projections below it stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>(),
    createFrontDoorActionExecute: () => executeMock,
}));

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

// The capability API and applied network identity are boundaries; their real feature and Account
// scope owners decide whether the mounted list can read the returned Run window.
vi.mock('@/sync/api/capabilities/serverFeaturesClient', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/api/capabilities/serverFeaturesClient')>();
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const snapshot = { status: 'ready' as const, features: createRootLayoutFeaturesResponse() };
    return { ...original, getCachedServerFeaturesSnapshot: () => snapshot, getServerFeaturesSnapshot: async () => snapshot };
});
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return { ...original, TokenStorage: { ...original.TokenStorage,
        getCredentialsForServerUrl: async () => ({ token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ==.signature' }),
    } };
});
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];

const waiting = createWorkflowRunSummaryFixture({ id: 'run-waiting', state: 'running', ownerAccountId: 'account-a', startedBy: 'user', attentionRequired: true });
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
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    routeState.pathname = '/workflows';
    routeState.params = {};
    previousStorageState = storage.getState();
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    await loadSyncSingletonForTests();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    appliedSnapshot = runtime.getActiveServerSnapshot;
    const profile = await runtime.upsertAndActivateServer({ serverUrl: 'http://unified-column.test', name: 'Column Home' });
    publishAppliedActiveServerSnapshot(appliedSnapshot());
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    storage.setState({
        profileScope: { serverId: profile.id, accountId: 'account-a' },
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true },
            sessionListSectionModeV1: 'single', sessionListOrderingModeV1: 'updated' },
        sessionListIndexByServerId: { [profile.id]: null }, sessionListRowsByServerId: {},
        workflowRunListWindows: {}, workflowRunsById: {}, socketStatus: 'connected', socketLastConnectedAt: 1,
    });
});

afterEach(async () => {
    standardCleanup();
    resetSessionDraftRepositoryForTests();
    const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
    resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    executeMock.mockReset();
    routerPush.mockReset();
    storage.setState(previousStorageState);
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
});

describe('WorkflowsColumn', () => {
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
            ] } }) : answer(actionId, input));
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        const { t } = await import('@/text');
        for (const [testID, reason] of [['workflows-column:library:missing-title', 'workflows.contentReasons.invalidHeader'],
            ['workflows-column:shared:shared-bad-body', 'workflows.contentReasons.invalidBody']] as const) {
            const row = screen.findHostByTestId(testID);
            expect(row).not.toBeNull();
            expect(row!.findAll(node => typeof node.props.children === 'string').map(node => node.props.children).join('\n')).toContain(t(reason));
        }
        expect(screen.findHostByTestId('workflows-column:library:readable')).not.toBeNull();
    });
    it('makes a failed-library retry visibly keyboard focusable without changing its link role', async () => {
        answerLists();
        const answer = executeMock.getMockImplementation()!;
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => actionId === 'workflow.definition.list'
            ? Promise.resolve({ ok: false, error: 'unavailable', errorCode: 'unavailable' }) : answer(actionId, input));
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        const target = () => screen.tree.findHostByTestId('workflows-column:library:failed:retry')!;
        const flattened = () => StyleSheet.flatten(typeof target().props.style === 'function'
            ? target().props.style({ pressed: false }) : target().props.style);
        expect(target().props.role ?? target().props.accessibilityRole).toBe('link');
        const restingOutline = flattened()?.outlineColor;
        await act(async () => { target().props.onFocus({ target: { matches: () => true } }); });
        expect(flattened()?.outlineStyle).toBe('solid');
        expect(flattened()?.outlineWidth).toBeGreaterThan(0);
        expect(flattened()?.outlineColor).toBeTruthy();
        expect(flattened()?.outlineColor).not.toBe(restingOutline);
        await screen.pressByTestIdAsync('workflows-column:library:failed:retry');
        expect(executeMock.mock.calls.filter(([actionId]) => actionId === 'workflow.definition.list').length).toBeGreaterThan(1);
    });

    it('uses the shared starter and attention predicate for a Board Runs filter', async () => {
        answerLists();
        const serverId = storage.getState().profileScope!.serverId;
        const board = { ...createWorkBoardV1({ id: 'run-filter', name: 'Runs' }), source: {
            picked: [], filter: normalizeSessionListFilterV1({ show: 'runs', startedBy: [], homeServerIds: [serverId] }),
        } };
        const hook = await renderHook(() => useBoardMembership(board, {
            activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id) => id === serverId,
        }));
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(hook.getCurrent().members.map((member) => [member.ref.kind, member.ref.qualifiedId.id]))
            .toEqual([['workflow_run', 'run-waiting']]);
        expect(hook.getCurrent().complete).toBe(true);
    });
    it('opens the Runs deep link as the same list rather than a separate History collection', async () => {
        answerLists();
        const screen = await renderScreen(<WorkflowsRunsRoute />, { wrapper: TestAuth });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        expect(screen.tree.root.findAll((node) => node.props?.testID === 'sessions-list-keyboard-frame').length).toBeGreaterThan(0);
        expect(screen.tree.root.findAll((node) => /^workflows-history:view:/.test(String(node.props?.testID ?? '')))).toHaveLength(0);
        const rows = screen.tree.root.findAll((node) => node.props?.testID === 'workflow-run-row:run-waiting' && typeof node.props.onPress === 'function');
        expect(rows.length).toBeGreaterThan(0);
        await act(async () => { rows[0]!.props.onPress(); });
        expect(routerPush).toHaveBeenCalledWith('/workflows/runs/run-waiting');
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
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        const runsTabs = screen.tree.root.findAll((node) => node.props?.testID === 'workflows-column:view:runs' && typeof node.props.onPress === 'function');
        expect(runsTabs.length).toBeGreaterThan(0);
        await act(async () => { runsTabs[0]!.props.onPress(); });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        expect(screen.tree.root.findAll((node) => node.props?.testID === 'sessions-list-keyboard-frame').length).toBeGreaterThan(0);
        expect(screen.tree.root.findAll((node) => /workflows-column:(needsYou|running|history):/.test(String(node.props?.testID ?? '')))).toHaveLength(0);
        const runRows = screen.tree.root.findAll((node) => node.props?.testID === 'workflow-run-row:run-waiting' && typeof node.props.onPress === 'function');
        expect(runRows.length).toBeGreaterThan(0);
        expect(screen.findByTestId(`session-draft-row:new-session:${draftId}`)).toBeNull();
        await act(async () => { runRows[0]!.props.onPress(); });
        expect(routerPush).toHaveBeenCalledWith('/workflows/runs/run-waiting');

        await screen.pressByTestIdAsync('session-list-search-trigger');
        await act(async () => { screen.changeTextByTestId('session-list-search-input', 'release'); });
        expect(screen.findByTestId('workflow-run-row:run-waiting')).toBeTruthy();
        expect(screen.findAllHostsByTestId('session-list-filtered-no-results')).toHaveLength(0);
        const filteredCounts = screen.tree.root.findAll((node) => node.props.controller?.fixedShow === 'runs' && typeof node.props.resultCount === 'number');
        expect(filteredCounts.length).toBeGreaterThan(0);
        expect(filteredCounts.map((node) => node.props.resultCount)).toEqual(filteredCounts.map(() => 1));
        await screen.pressByTestIdAsync('workflows-column:view:definitions');
        expect(screen.findAllHostsByTestId('session-list-search-input')).toHaveLength(0);
        await screen.pressByTestIdAsync('workflows-column:view:runs');
        expect(screen.findByTestId('session-list-search-input')?.props.value).toBe('release');
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

});
// Third-party rendering boundary; the collection does not render Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
