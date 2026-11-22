// @vitest-environment jsdom
import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createWorkBoardV1} from '@happier-dev/protocol/boards/workBoardV1';
import { getBuiltinWorkflowCatalogV1} from '@happier-dev/protocol/workflows/builtins/catalog';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { useBoardMembership } from '@/components/boards/model/useBoardContent';
import { createWorkflowRunSummaryFixture, createWorkflowRunRecentSummaryFixture as recent } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { WorkflowRunStateV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { CollectionProps } from '@happier-dev/plugin-ui';
import type { WorkflowRunCollectionRow } from '../library/useWorkflowRunCollection';
import { configureSessionDraftRepository, resetSessionDraftRepositoryForTests, writeNewSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { WorkflowsRunsRoute } from '@/app/(app)/workflows/runs/index';
import { WorkflowsColumn } from './WorkflowsColumn';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
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

const phoneWindow = vi.hoisted(() => ({ on: false }));
// Window size is an environment adapter: a test may present a phone-sized window; otherwise the real reading stands.
vi.mock('@/utils/platform/useViewportClass', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/utils/platform/useViewportClass')>();
    return { ...original, useViewportClass: () => (phoneWindow.on ? 'compact' : original.useViewportClass()) };
});
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return { ...original, useDeviceType: () => (phoneWindow.on ? 'phone' : original.useDeviceType()) };
});

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
    // Only after the tree unmounts: a mounted tree re-rendering across the flip would change its hook order.
    phoneWindow.on = false;
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

/** A view switch reaches its owner after the pressed segment has painted (`useHappierTabSelection`). */
async function pressView(screen: Awaited<ReturnType<typeof renderScreen>>, view: 'definitions' | 'runs') {
    await screen.pressByTestIdAsync(`workflows-column:view:${view}`);
    await flushHookEffects({ frames: 2 });
}

describe('WorkflowsColumn', () => {
    it('offers Events through the same mounted command as the tab on page and column', async () => {
        let commands: ReturnType<typeof useCurrentUiContextComposedCommands> = [];
        function Commands() { commands = useCurrentUiContextComposedCommands(); return null; }
        const authority = captureActiveServerAccountScopeLifetime();
        const screen = await renderScreen(<CurrentUiContextCommandsProvider authority={authority}>
            <Commands /><WorkflowsColumn />
        </CurrentUiContextCommandsProvider>, { wrapper: TestAuth });
        const events = commands.find(row => row.title === 'workflows.tabs.events');
        expect(events?.command.kind).toBe('hostLocal');
        if (events?.command.kind !== 'hostLocal') throw new Error('Events command unavailable');
        await act(async () => { expect(await events.command.invoke({ signal: new AbortController().signal,
            context: { surface: 'agent' } })).toMatchObject({ ok: true }); });
        expect(screen.findHostByTestId('workflows-column:view:events')?.props.accessibilityState).toMatchObject({ selected: true });
        expect(routerPush).toHaveBeenCalledWith('/workflows/events');
        await screen.update(<CurrentUiContextCommandsProvider authority={authority}>
            <Commands /><WorkflowsColumn surface="page" definitionsContent={<View />} />
        </CurrentUiContextCommandsProvider>);
        await pressView(screen, 'definitions');
        routerPush.mockClear();
        const pageEvents = commands.find(row => row.title === 'workflows.tabs.events');
        if (pageEvents?.command.kind !== 'hostLocal') throw new Error('Page Events command unavailable');
        await act(async () => { expect(await pageEvents.command.invoke({ signal: new AbortController().signal,
            context: { surface: 'agent' } })).toMatchObject({ ok: true }); });
        expect(screen.findHostByTestId('workflows-column:view:events')?.props.accessibilityState).toMatchObject({ selected: true });
        expect(routerPush).not.toHaveBeenCalled();
    });
    it('opens Events from the tab press even when the current context cannot resolve its mounted command (QA-LIVE ship3)', async () => {
        // The navigation column is not always the surface the current context publishes; a press is the person's
        // own choice and must not depend on that resolution.
        const authority = captureActiveServerAccountScopeLifetime();
        const screen = await renderScreen(<CurrentUiContextCommandsProvider authority={authority}>
            <WorkflowsColumn />
        </CurrentUiContextCommandsProvider>, { wrapper: TestAuth });
        await screen.pressByTestIdAsync('workflows-column:view:events');
        await flushHookEffects({ frames: 2 });
        expect(screen.findHostByTestId('workflows-column:view:events')?.props.accessibilityState).toMatchObject({ selected: true });
        expect(routerPush).toHaveBeenCalledWith('/workflows/events');
    });
    it('leaves the desktop Events detail when Definitions is selected', async () => {
        routeState.pathname = '/workflows/events/observed-session';
        const screen = await renderScreen(<WorkflowsColumn surface="plane" />, { wrapper: TestAuth });
        try {
            expect(screen.findHostByTestId('workflows-column:view:events')?.props.accessibilityState).toMatchObject({ selected: true });
            await pressView(screen, 'definitions');
            expect(routerPush).toHaveBeenCalledWith('/workflows');
        } finally { await screen.unmount(); }
    });
    it('opens the page form on its name, with the Definitions and Runs switch under it in both views (FIN-DESIGN-REVIEW L6)', async () => {
        const screen = await renderScreen(<WorkflowsColumn surface="page" definitionsContent={<View testID="workflow-definitions-content" />} />, { wrapper: TestAuth });
        const order = () => screen.tree.root.findAll((node) => typeof node.type === 'string'
            && (node.props.testID === 'workflows-column:header' || node.props.testID === 'workflows-column:view:definitions'))
            .map((node) => node.props.testID as string);
        expect(order()[0]).toBe('workflows-column:header');
        expect(order()).toContain('workflows-column:view:definitions');
        await pressView(screen, 'runs');
        expect(order()[0]).toBe('workflows-column:header');
    });
    it('opens a new sentence builder through the mounted New automation command', async () => {
        const { WorkflowsColumnActions } = await import('./WorkflowsColumnActions');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } = await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
        let commands: ReturnType<typeof useCurrentUiContextComposedCommands> = [];
        function Commands() { commands = useCurrentUiContextComposedCommands(); return null; }
        const authority = captureActiveServerAccountScopeLifetime();
        const screen = await renderScreen(<CurrentUiContextCommandsProvider authority={authority}>
            <Commands /><WorkflowsColumnActions canCreate />
        </CurrentUiContextCommandsProvider>, { wrapper: TestAuth });
        const create = commands.find(row => row.title === 'workflows.triggers.editor.title');
        expect(create?.command.kind).toBe('hostLocal');
        if (create?.command.kind !== 'hostLocal') throw new Error('New automation command unavailable');
        await act(async () => { expect(await create.command.invoke({ signal: new AbortController().signal,
            context: { surface: 'agent' } })).toMatchObject({ ok: true }); });
        expect(screen.findHostByTestId('workflow-builder')).not.toBeNull();
    });
    it('opens New automation from the sidebar menus when the current context cannot resolve their command', async () => {
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const { WorkflowsColumnActions } = await import('./WorkflowsColumnActions');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { CurrentUiContextCommandsProvider } = await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
        const authority = captureActiveServerAccountScopeLifetime();
        const tree = (canCreate: boolean) => <CurrentUiContextCommandsProvider authority={authority}>
            <WorkflowsColumnActions canCreate={canCreate} />
        </CurrentUiContextCommandsProvider>;
        const screen = await renderScreen(tree(true), { wrapper: TestAuth });
        const select = async (menuId: string) => {
            const menu = screen.findAllByType(DropdownMenu).find(node => node.props.testID === menuId)!;
            await act(async () => { menu.props.onSelect('trigger'); });
            expect(screen.findHostByTestId('workflow-builder')).not.toBeNull();
        };
        await select('workflows-column:add:menu');
        await screen.pressByTestIdAsync('workflow-builder-cancel');
        await screen.update(tree(false));
        await select('workflows-column:more:menu');
    });
    it('heads the phone page with the space as its title, search behind the magnifier and the bar "+" (owner 11-11)', async () => {
        // A phone-sized window: the window-size adapters are the boundary; the column decides from them.
        phoneWindow.on = true;
        {
            const { WorkflowsLibraryHome } = await import('@/components/workflows/library/WorkflowsLibraryHome');
            const { usePageCreateAction } = await import('@/components/navigation/mobile/chrome/pageCreateAction');
            const { t } = await import('@/text');
            const bar: { action: ReturnType<typeof usePageCreateAction> } = { action: null };
            function Bar() { bar.action = usePageCreateAction(); return null; }
            const screen = await renderScreen(<><Bar /><WorkflowsColumn surface="page" definitionsContent={<WorkflowsLibraryHome />} /></>, { wrapper: TestAuth });
            // The title is the space ("All workflows ⌄") on the page's title row; the home draws no second scope line.
            await vi.waitFor(() => expect(screen.findHostByTestId('workflows-column-space-title')).not.toBeNull());
            expect(screen.findHostByTestId('workflows-home:scope-line')).toBeNull();
            // Search waits behind the magnifier on the title row.
            expect(screen.findHostByTestId('workflows-search')).toBeNull();
            await screen.pressByTestIdAsync('workflows-search:toggle');
            expect(screen.findHostByTestId('workflows-search')).not.toBeNull();
            // The bar's "+" is the page's add.
            expect(bar.action?.label).toBe(t('workflows.destination.addAccessibility'));
        }
    });
    it.each([false, true])('reveals the Workflow filter search anchor from retained Runs (page=%s)', async page => {
        const content = page ? <View testID="workflow-definitions-content" /> : undefined;
        const screen = await renderScreen(<WorkflowsColumn surface="plane" definitionsContent={content} />, { wrapper: TestAuth });
        await pressView(screen, 'runs');
        expect(screen.findHostByTestId('workflows-column:view:runs')?.props.accessibilityState).toMatchObject({ selected: true });
        routeState.params = { setting: 'workflow.list.filters' };
        await screen.update(<WorkflowsColumn surface="page" definitionsContent={content} />);
        expect(screen.findHostByTestId('workflows-column:view:definitions')?.props.accessibilityState).toMatchObject({ selected: true });
        // The request reveals once; a deliberate subsequent choice still belongs to the tab owner.
        await pressView(screen, 'runs');
        expect(screen.findHostByTestId('workflows-column:view:runs')?.props.accessibilityState).toMatchObject({ selected: true });
    });
    it('offers all four workflow starts plus automatic setup directly (FIN-JOURNEY F10)', async () => {
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const { WorkflowsColumnActions } = await import('./WorkflowsColumnActions');
        const { WORKFLOWS_NEW_ROUTE } = await import('../workflowsRoutes');
        const screen = await renderScreen(<WorkflowsColumnActions canCreate />, { wrapper: TestAuth,
            createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(40, 40, 120, 40) }),
        });
        const menu = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'workflows-column:add:menu')!;
        const items = menu.props.items as readonly import('@/components/ui/forms/dropdown/DropdownMenu').DropdownMenuItem[];
        expect(items.map(item => item.id)).toEqual(['blank', 'trigger', 'agent', 'example', 'import']);
        await act(async () => menu.props.onSelect('blank'));
        expect(routerPush).toHaveBeenCalledWith(WORKFLOWS_NEW_ROUTE);
        await act(async () => menu.props.onSelect('trigger'));
        await vi.waitFor(() => expect(screen.findHostByTestId('workflow-builder')).not.toBeNull());
        expect(routerPush).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('workflow-builder-cancel');
        await screen.update(<WorkflowsColumnActions canCreate={false} />);
        const more = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'workflows-column:more:menu')!;
        await act(async () => more.props.onSelect('trigger'));
        await vi.waitFor(() => expect(screen.findHostByTestId('workflow-builder')).not.toBeNull());
        expect(routerPush).toHaveBeenCalledTimes(1);
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
                return Response.json({ automations: query.scope !== 'account_saved' ? [detail] : [], nextCursor: null });
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
        // Hiding Definitions releases its demand but keeps its last-good rows: a return shows the same rows,
        // never a rebuilt list (P03-TAB-CONTENT-2 W6). Identity, compared as booleans.
        const accountRow = screen.findHostByTestId('workflows-column:library:account-trigger:digest');
        const savedRow = screen.findHostByTestId(`workflows-column:library:${definitionId}`);
        await pressView(screen, 'runs');
        await pressView(screen, 'definitions');
        expect({ accountRowKept: screen.findHostByTestId('workflows-column:library:account-trigger:digest') === accountRow,
            savedRowKept: screen.findHostByTestId(`workflows-column:library:${definitionId}`) === savedRow })
            .toEqual({ accountRowKept: true, savedRowKept: true });
        // Every Library row would carry the same workflow glyph, so none draws a leading mark: the names start
        // on the list's edge, while built-ins keep their own marks (LIST-ICONS-1108).
        // What a workflow uses ends its row (scene 8); it is never a leading mark.
        const leadingMarks = screen.findAll(node => /^workflows-column:library:/.test(String(node.props?.testID ?? ''))
            && node.props.title !== undefined && 'needsYou' in node.props).map(row => row.props.icon).filter(icon => icon !== undefined);
        expect(leadingMarks).toEqual([]);
        // The Account Workflow's trigger is its quiet line; it carries no switch of its own.
        expect(screen.findAll(node => node.props?.testID === 'workflows-column:library:account-trigger:digest' && 'subtitle' in node.props)[0]
            // The one app clock words the time (34a1cd1dc10): the sidebar, table, card and History read the same.
            ?.props.subtitle).toBe(`workflows.triggers.summary.everyDayAt(time=${(await import('../triggers/triggerSchedule')).formatClockTime({ hour: 9, minute: 0 })})`);
        expect(screen.findByTestId('workflows-column:trigger:digest-switch')).toBeNull();
        // A saved workflow opens its editor; an Account Workflow opens its settings where it stands.
        await screen.pressByTestIdAsync(`workflows-column:library:${definitionId}`);
        expect(routerPush).toHaveBeenCalledWith(createWorkflowDefinitionRoute(definitionId));
        await screen.pressByTestIdAsync('workflows-column:library:account-trigger:digest');
        await vi.waitFor(() => expect(screen.findByTestId('workflows-column-trigger-popover')).not.toBeNull());
        // The Runs tab opened its table in main; the Account Workflow itself navigated nowhere.
        expect(routerPush.mock.calls.filter(([route]) => route !== '/workflows/runs')).toHaveLength(1);
    });
    it('demands definitions and summaries only for presented Definitions while a second reader stays current', async () => {
        const { useWorkflowLibraryView } = await import('../library/useWorkflowLibraryView');
        const { publishHomeAccountChange, subscribeHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const definitionId = '10000000-0000-4000-8000-000000000099';
        const answer = executeMock.getMockImplementation()!;
        let revision = 1;
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => {
            if (actionId === 'workflow.definition.list') return Promise.resolve({ ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId, metadata: { title: 'Visible' },
                revision: { headerVersion: revision, bodyVersion: revision }, contentStatus: 'available', stepCount: 1,
                ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null,
            }] } });
            if (actionId === 'workflow.run.summaries') return Promise.resolve({ ok: true, result: {
                remainingSourceArtifactIds: [], summaries: [{ sourceArtifactId: definitionId, lastRun: null,
                    recent: [], needsYouCount: 0, needsYouRunId: null }],
            } });
            return answer(actionId, input);
        });
        const reads = () => executeMock.mock.calls.filter(([id]) => id === 'workflow.definition.list' || id === 'workflow.run.summaries');
        routeState.pathname = '/workflows/runs';
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        expect(reads()).toHaveLength(0);
        const changes: unknown[] = [];
        const stop = subscribeHomeAccountChange(event => changes.push({ source: event.source, kinds: event.changeKinds,
            definitions: event.workflowDefinitionsAffect, triggers: event.workflowTriggersAffect }));
        try {
            await pressView(screen, 'definitions');
            await vi.waitFor(() => expect(reads(), JSON.stringify({ reads: reads().map(([id]) => id), changes })).toHaveLength(2));
        } finally { stop(); }
        revision = 2;
        const homeReader = await renderHook(({ focused }: { focused: boolean }) => useWorkflowLibraryView(focused), {
            initialProps: { focused: true },
        });
        // Mounts share the retained inventory; the committed Home wake owns revision refresh.
        await act(async () => publishHomeAccountChange(boundary!.serverId, undefined, { changeKinds: ['artifact'] }));
        await vi.waitFor(() => expect(homeReader.getCurrent().library.definitions[0]?.revision?.bodyVersion).toBe(2));
        await pressView(screen, 'runs');
        const before = reads().length;
        const inventoryReads = () => reads().filter(([id]) => id === 'workflow.definition.list').length;
        const beforeInventory = inventoryReads();
        revision = 3;
        const { encodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        const stored = boundary!.artifacts.read(definitionId);
        if (!stored) throw new Error('Expected the served Workflow Artifact');
        boundary!.artifacts.replaceStoredRow({ ...stored, headerVersion: revision, bodyVersion: revision,
            header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId,
                revision: { headerVersion: revision, bodyVersion: revision }, metadata: { title: 'Visible' }, previewSteps: [] }) });
        await act(async () => publishHomeAccountChange(boundary!.serverId, [definitionId], { changeKinds: ['artifact'] }));
        // Exact Artifact refresh reads that record and revalidates its shared Run summary,
        // not another Library inventory. The HTTP fixture serves the committed row above.
        await vi.waitFor(() => expect(reads().length).toBe(before + 1));
        await vi.waitFor(() => expect(homeReader.getCurrent().library.definitions[0]?.revision?.bodyVersion).toBe(3));
        expect(inventoryReads()).toBe(beforeInventory);
        await homeReader.rerender({ focused: false });
        const hidden = reads().length;
        revision = 4;
        // This mutation changes the inventory fixture; its coarse wake refreshes that inventory on focus.
        await act(async () => publishHomeAccountChange(boundary!.serverId, undefined, { changeKinds: ['artifact'] }));
        expect(reads()).toHaveLength(hidden);
        await homeReader.rerender({ focused: true });
        await vi.waitFor(() => expect(reads().length).toBe(hidden + 2));
        await vi.waitFor(() => expect(homeReader.getCurrent().library.definitions[0]?.revision?.bodyVersion).toBe(4));
    });

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
        // The column as the page (no library home beside it) owns the space and its filter (owner 2026-11-12).
        const screen = await renderScreen(<WorkflowsColumn surface="page" />, { wrapper: TestAuth });
        await vi.waitFor(() => expect(screen.findHostByTestId('workflows-column:library:quiet')).not.toBeNull());
        await vi.waitFor(() => expect(executeMock.mock.calls.some(call => call[0] === 'workflow.run.summaries')).toBe(true));
        const readCount = () => executeMock.mock.calls.filter(call => call[0] === 'workflow.definition.list' || call[0] === 'workflow.run.summaries').length;
        const reads = readCount();
        await screen.pressByTestIdAsync('workflows-column-space-filter-open');
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
        const selected = (screen: Awaited<ReturnType<typeof renderScreen>>) => [...new Set(screen.findAll(node =>
            typeof node.props.testID === 'string' && node.props.testID.startsWith('workflows-column:')
            && typeof node.props.href === 'string' && node.props.selected === true).map(node => node.props.testID))];
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
    it('groups its rows by Project when the page does: one Group by per kind (scene 8 D3)', async () => {
        answerLists();
        const answer = executeMock.getMockImplementation()!;
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => actionId === 'workflow.definition.list'
            ? Promise.resolve({ ok: true, result: { definitions: [
                { kind: 'workflow-definition.v1', definitionId: 'own', metadata: { title: 'Own recipe' }, revision: { headerVersion: 1, bodyVersion: 1 },
                    contentStatus: 'available', stepCount: 1, ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null },
                { kind: 'workflow-definition.v1', definitionId: 'shared', metadata: { title: 'Shared recipe' }, revision: { headerVersion: 1, bodyVersion: 1 },
                    contentStatus: 'available', stepCount: 1, ownerAccountId: 'other-account', access: 'view', triggers: [], nextRunAt: null },
            ] } satisfies WorkflowDefinitionListResultV1 }) : answer(actionId, input));
        const { settings } = storage.getState();
        storage.setState({ settings: { ...settings, collectionDisplayPreferencesV1: { ...settings.collectionDisplayPreferencesV1,
            workflow: { ...settings.collectionDisplayPreferencesV1.workflow, groupBy: 'project' } } } });
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findHostByTestId('workflows-column:library:own')).not.toBeNull();
        });
        // Neither row has a project placement, so both stand under "No project" instead of Library and Shared with you.
        expect(screen.findAll(node => node.props?.testID === 'workflows-column:group:project:noProject' && 'count' in node.props)[0]?.props.count).toBe(2);
        expect({ library: screen.findByTestId('workflows-column:group:library'), shared: screen.findByTestId('workflows-column:group:sharedWithYou') })
            .toEqual({ library: null, shared: null });
    });
    // B1 list review 3: the sidebar consumes the same Row details the page and the View menu offer.
    it('draws a sidebar workflow row\'s step count at Lines 3 when its Steps detail is on', async () => {
        answerLists();
        const answer = executeMock.getMockImplementation()!;
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => actionId === 'workflow.definition.list'
            ? Promise.resolve({ ok: true, result: { definitions: [
                { kind: 'workflow-definition.v1', definitionId: 'stepped', metadata: { title: 'Stepped recipe' }, revision: { headerVersion: 1, bodyVersion: 1 },
                    contentStatus: 'available', stepCount: 3, ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null },
            ] } satisfies WorkflowDefinitionListResultV1 }) : answer(actionId, input));
        const { settings } = storage.getState();
        storage.setState({ settings: { ...settings, collectionDisplayPreferencesV1: { ...settings.collectionDisplayPreferencesV1,
            workflow: { ...settings.collectionDisplayPreferencesV1.workflow, lines: 3, details: { steps: true } } } } });
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findHostByTestId('workflows-column:library:stepped')).not.toBeNull();
        });
        const text = screen.findHostByTestId('workflows-column:library:stepped')!.findAll((node) => typeof node.props.children === 'string')
            .map((node) => node.props.children).join('\n');
        expect(text).toContain('workflows.examples.stepCount');
        // Lines 3 is its own line under line 2 (lab scene 8 "Lines × details", F-AUDIT row 39), not more of line 2.
        // The shared column row the workflow row draws (the node that receives its lines).
        const row = screen.findAll((node) => node.props?.testID === 'workflows-column:library:stepped' && 'lines' in node.props)[0]!;
        expect(String(row.props.subtitle ?? '')).not.toContain('workflows.examples.stepCount');
        expect(row.props.lines?.[0]?.start).toContain('workflows.examples.stepCount');
    });
    // B1 list review 2: Run rows read the Run display projection (Lines and Row details).
    it('draws a sidebar Run row at the Run Lines, with its Started by detail on Lines 3', async () => {
        answerLists();
        // What the row says under its name: line 2 (its subtitle) and, at Lines 3, its own third line.
        const subtitleOf = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
            const row = screen.findAll((node) => node.props?.testID === 'workflows-column:runs:row:run-live' && 'title' in node.props
                && 'accessibilityLabel' in node.props)[0];
            const said = [row?.props.subtitle, ...(row?.props.lines ?? []).map((line: { start?: string }) => line.start)].filter(Boolean);
            return said.length === 0 ? undefined : said.join(' | ');
        };
        const render = async (workflowRun: Readonly<Record<string, unknown>>) => {
            const { settings } = storage.getState();
            storage.setState({ settings: { ...settings, collectionDisplayPreferencesV1: { ...settings.collectionDisplayPreferencesV1, workflowRun } } });
            const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
            await pressView(screen, 'runs');
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(screen.findHostByTestId('workflows-column:runs:row:run-live')).not.toBeNull();
            });
            const subtitle = subtitleOf(screen);
            await screen.unmount();
            return subtitle;
        };
        const oneLine = await render({ lines: 1 });
        const threeLines = await render({ lines: 3, details: { startedBy: true } });
        const threeLinesOff = await render({ lines: 3, details: { startedBy: false } });
        expect(oneLine).toBeUndefined();
        expect(threeLines).toBeDefined();
        expect(threeLines).not.toBe(threeLinesOff);
    });
    // B1 list review 2: the Runs table chooses its Columns through the one Collection Columns owner.
    it('lets the Runs table choose its Columns, so a default-hidden column can be turned on', async () => {
        answerLists();
        routeState.pathname = '/workflows/runs';
        try {
            const { HostCollection } = await import('@happier-dev/plugin-ui');
            const { CollectionColumnsMenuButton } = await import('@/components/ui/lists/collection/CollectionColumnsMenu');
            const screen = await renderScreen(<AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
                <WorkflowsRunsRoute />
            </AppShellColumnContext.Provider>, { wrapper: TestAuth });
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(screen.findAllByType(HostCollection).find((node) => node.props.testID === 'workflow-runs:collection')).toBeDefined();
            });
            const table = screen.findAllByType(HostCollection).find((node) => node.props.testID === 'workflow-runs:collection')!;
            const collectionId = table.props.columns?.collectionId;
            expect(collectionId).toEqual(expect.any(String));
            const menu = screen.findAllByType(CollectionColumnsMenuButton)[0];
            expect(menu?.props.collectionId).toBe(collectionId);
            // Every declared field (contributed columns included) is a choice in the menu.
            const fieldKeys = (table.props.anatomy.fields ?? []).map((field: { key: string }) => field.key);
            const choices = (menu?.props.columns ?? []).map((column: { id: string }) => column.id);
            expect(choices).toEqual(expect.arrayContaining(fieldKeys));
        } finally {
            routeState.pathname = '/workflows';
        }
    });
    it('keeps the Library index alive from the shared run summaries: needs you and running speak, every row keeps its strip', async () => {
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
        // The shared navigation row's own props (the workflow row passes it the name, state and end).
        const rowNode = (id: string) => screen.findAll(node => node.props.testID === `workflows-column:library:${id}`
            && typeof node.props.href === 'string' && 'needsYou' in node.props)[0]!;
        const row = (id: string) => rowNode(id).props;
        const strip = (id: string) => rowNode(id)
            .findAll(node => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('workflows.destination.strip'));
        await vi.waitFor(async () => {
            await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
            expect(row('works').accessibilityLabel).toContain('workflows.destination.sections.running');
        });
        // Scene 8 Lines 2: the state word speaks only when it matters (Needs you, Running) and is spoken with the name;
        // every row that has run history ends with its run strip, a rested or never-run row says nothing more.
        expect(row('waits').accessibilityLabel).toContain('workflows.destination.sections.needsYou');
        expect(row('waits').needsYou).toBe(true);
        expect(row('rests').accessibilityLabel).toBe('Fix a failing test');
        expect(row('never').accessibilityLabel).toBe('Triage new issues');
        for (const id of ['waits', 'works', 'rests', 'never']) expect(strip(id).length).toBeGreaterThan(0);
    });
    it('mounts only the column rows near its viewport for a large Library, keeping the open row', async () => {
        const answer = executeMock.getMockImplementation()!;
        const ids = Array.from({ length: 300 }, (_, index) => `10000000-0000-4000-8000-0000000003${String(index).padStart(2, '0')}`);
        routeState.pathname = `/workflows/${ids[299]}`;
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => {
            if (actionId === 'workflow.definition.list') return Promise.resolve({ ok: true, result: { definitions: ids.map((definitionId, index) => ({
                kind: 'workflow-definition.v1', definitionId, metadata: { title: `Workflow ${index}` }, updatedAt: 1000 - index,
                revision: { headerVersion: 1, bodyVersion: 1 }, contentStatus: 'available', stepCount: 1,
                ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null,
            })) } });
            if (actionId === 'workflow.run.summaries') return Promise.resolve({ ok: true, result: { remainingSourceArtifactIds: [],
                summaries: ids.map(sourceArtifactId => ({ sourceArtifactId, lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null })) } });
            return answer(actionId, input);
        });
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        const mounted = () => screen.findAll(node => typeof node.type === 'string'
            && /^workflows-column:library:/.test(String(node.props.testID ?? ''))).map(node => String(node.props.testID));
        await vi.waitFor(() => expect(mounted().length).toBeGreaterThan(0));
        await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 50)); });
        const rows = new Set(mounted());
        // The whole Library is 300 rows: only those near the viewport are built.
        expect(rows.size).toBeLessThan(150);
        expect(rows.has(`workflows-column:library:${ids[0]}`)).toBe(true);
        // The open row stays mounted (its selected chip) even when it is far below the fold.
        expect(rows.has(`workflows-column:library:${ids[299]}`)).toBe(true);
        await screen.unmount();
    });

    it('re-renders only the changed Library row when one saved workflow changes', async () => {
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const answer = executeMock.getMockImplementation()!;
        const ids = Array.from({ length: 12 }, (_, index) => `10000000-0000-4000-8000-0000000002${String(index).padStart(2, '0')}`);
        const titles = new Map(ids.map((id, index) => [id, `Workflow ${index}`]));
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => {
            if (actionId === 'workflow.definition.list') return Promise.resolve({ ok: true, result: { definitions: ids.map((definitionId, index) => ({
                kind: 'workflow-definition.v1', definitionId, metadata: { title: titles.get(definitionId) }, updatedAt: 100 - index,
                revision: { headerVersion: 1, bodyVersion: 1 }, contentStatus: 'available', stepCount: 1,
                ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null,
            })) } });
            if (actionId === 'workflow.run.summaries') return Promise.resolve({ ok: true, result: { remainingSourceArtifactIds: [],
                summaries: ids.map(sourceArtifactId => ({ sourceArtifactId, lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null })) } });
        // One cause, one message: the column says what the library home says, from the same copy.
        const failedText = screen.getTextContent();
        expect(failedText).toContain('workflows.loadFailedTitle');
        expect(failedText).toContain('workflows.loadFailedBody');
            return answer(actionId, input);
        });
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        // A host element keeps its props object only while nothing above it renders again.
        // Each row's own host (its parts carry testIDs of their own under the same prefix).
        const rowIds = new Set(ids.map(id => `workflows-column:library:${id}`));
        const rowProps = () => new Map(screen.findAll(node => typeof node.type === 'string'
            && rowIds.has(String(node.props.testID ?? ''))).map(node => [String(node.props.testID), node.props]));
        await vi.waitFor(() => expect(rowProps().size).toBe(ids.length));
        await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 50)); });
        const before = rowProps();
        const changed = ids[3]!;
        const { encodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        const stored = boundary!.artifacts.read(changed);
        if (!stored) throw new Error('Expected the served Workflow Artifact');
        titles.set(changed, 'Renamed');
        boundary!.artifacts.replaceStoredRow({ ...stored, headerVersion: 2, bodyVersion: 2,
            header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId: changed,
                revision: { headerVersion: 2, bodyVersion: 2 }, metadata: { title: 'Renamed' }, previewSteps: [] }) });
        await act(async () => publishHomeAccountChange(boundary!.serverId, [changed], { changeKinds: ['artifact'] }));
        await vi.waitFor(() => expect(screen.findAll(node => node.props?.testID === `workflows-column:library:${changed}`
            && node.props.title === 'Renamed').length).toBeGreaterThan(0));
        await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 50)); });
        const after = rowProps();
        const rerendered = [...after].filter(([testID, props]) => before.get(testID) !== props).map(([testID]) => testID);
        // 12 rows; one changed. Before: every row re-rendered with the list.
        expect(rerendered.filter(testID => testID !== `workflows-column:library:${changed}`)).toEqual([]);
        await screen.unmount();
    });
    it.each(['column', 'home'] as const)('discloses a failed saved-library refresh alongside retained rows and recovers through Retry in the %s', async surface => {
        const answer = executeMock.getMockImplementation()!;
        let title = 'Retained workflow';
        executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => actionId === 'workflow.definition.list'
            ? Promise.resolve({ ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId: 'retained', metadata: { title },
                revision: { headerVersion: 1, bodyVersion: 1 }, contentStatus: 'available', stepCount: 1,
                ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null,
            }] } satisfies WorkflowDefinitionListResultV1 }) : answer(actionId, input));
        let failLibrary = false;
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const http = boundary!;
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            if (failLibrary && target.pathname === '/v1/artifacts' && (target.searchParams.get('kind') === 'other'
                || target.searchParams.get('kinds')?.includes('workflow-definition.v1'))) {
                return Response.json({ items: 'invalid-page' });
            }
            return http.request(url, init);
        });
        const { WorkflowsLibraryHome } = await import('../library/WorkflowsLibraryHome');
        const screen = await renderScreen(surface === 'column' ? <WorkflowsColumn /> : <WorkflowsLibraryHome />,
            { wrapper: TestAuth });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Retained workflow'));
        expect(screen.findHostByTestId('workflow-library:refresh-failed')).toBeNull();
        failLibrary = true;
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        await act(async () => publishHomeAccountChange(http.serverId, undefined, { changeKinds: ['artifact'] }));
        await vi.waitFor(() => expect(screen.findHostByTestId('workflow-library:refresh-failed')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Retained workflow');
        expect(screen.findHostByTestId('home-unreachable')).toBeNull();
        failLibrary = false;
        title = 'Refreshed workflow';
        await screen.pressByTestIdAsync('workflow-library:refresh-failed-action');
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('Refreshed workflow');
            expect(screen.findHostByTestId('workflow-library:refresh-failed')).toBeNull();
        });
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
        // Without a shell column (a phone), the destination's column-as-page opens on Runs: the one Run collection's rows.
        routeState.pathname = '/workflows/runs';
        const screen = await renderScreen(<WorkflowsRunsRoute />, { wrapper: TestAuth });
        routeState.pathname = '/workflows';
        const row = () => screen.findAll((node) => node.props?.testID === 'workflows-page:runs:row:run-waiting' && typeof node.props.onPress === 'function')[0];
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(row()).toBeDefined();
        });
        expect(screen.tree.root.findAll((node) => node.props?.testID === 'sessions-list-keyboard-frame')).toHaveLength(0);
        expect(screen.tree.root.findAll((node) => /^workflows-history:view:/.test(String(node.props?.testID ?? '')))).toHaveLength(0);
        // Runs only: every row would lead with the same Run glyph, so none does (LIST-ICONS-1108).
        expect(row()!.props.icon).toBeUndefined();
        await act(async () => { row()!.props.onPress(); });
        expect(routerPush).toHaveBeenCalledWith(
            '/workflows/runs/run-waiting?target=occurrence&automationId=automation-1&serverId=unified-column.test',
        );
    });

    it('opens the Runs table in main beside the column, never a second Sessions list (scene 8 D2)', async () => {
        answerLists();
        routeState.pathname = '/workflows/runs';
        try {
            const screen = await renderScreen(<AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
                <WorkflowsRunsRoute />
            </AppShellColumnContext.Provider>, { wrapper: TestAuth });
            await act(async () => { await Promise.resolve(); await Promise.resolve(); });
            // Main holds the Runs table (owner D2); it never repeats a Sessions list.
            expect(screen.findAllHostsByTestId('sessions-list-keyboard-frame')).toHaveLength(0);
            await vi.waitFor(() => expect(screen.findHostByTestId('workflow-runs:header')).not.toBeNull());
            const { HostCollection } = await import('@happier-dev/plugin-ui');
            const readTable = () => screen.findAllByType(HostCollection)
                .find(node => node.props.testID === 'workflow-runs:collection')
                ?.props as CollectionProps<WorkflowRunCollectionRow> | undefined;
            const readRow = () => readTable()?.model.sections.flatMap(section => section.items).find(row => row.key === running.id);
            await vi.waitFor(() => expect(readRow()).toBeDefined());
            // Use the mounted table's field before the native viewport has measured its visible columns.
            const result = readTable()!.anatomy.fields?.find(field => field.key === 'result');
            const cell = await renderScreen(<>{result?.render(readRow()!)}</>, { wrapper: TestAuth });
            expect(cell.findHostByTestId(`workflow-runs:row:${running.id}:result`)).not.toBeNull();
            expect(cell.findHostByTestId(`session-row-attention-indicator-run-result-${running.id}`)).not.toBeNull();
        } finally {
            routeState.pathname = '/workflows';
        }
    });

    it('shares the open Runs search and conditions between the page and agent Actions', async () => {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { WORKFLOW_RUN_VIEW_ACTION_IDS: { get, set, reset } } = await import('@happier-dev/protocol/actions/scopeActionIdsV1');
        const { createDefaultCollectionSpaceV1 } = await import('@happier-dev/protocol/collections/spaces/collectionSpacesV1');
        const { collectionSpaceSettingRefs } = await import('@/components/settings/session/collectionSpaceSettings');
        const { HostCollection } = await import('@happier-dev/plugin-ui');
        answerLists();
        const allRuns = createDefaultCollectionSpaceV1('workflowRun');
        const results = { include: ['succeeded' as const], exclude: [] };
        const saved = { ...allRuns, id: 'succeeded', name: 'Succeeded runs', filter: { results } };
        routeState.pathname = '/workflows/runs';
        const screen = await renderScreen(<AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
            <WorkflowsRunsRoute />
        </AppShellColumnContext.Provider>, { wrapper: TestAuth });
        await vi.waitFor(() => expect(screen.findHostByTestId('workflow-runs:search')).not.toBeNull());

        const action = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, serverId: boundary!.serverId };
        await vi.waitFor(() => expect(action.execute(get, {}, context)).resolves.toMatchObject({
            ok: true, result: { searchQuery: '', visibleKeys: expect.arrayContaining([waiting.id, running.id]) },
        }));

        const table = () => screen.findAllByType(HostCollection).find(node => node.props.testID === 'workflow-runs:collection');
        expect(table()?.props.presentation).toBe('table');
        await act(async () => { screen.pressByTestId('workflow-runs:view'); });
        for (const grouping of ['project', 'workflow', 'date'] as const) {
            await act(async () => { screen.pressByTestId(`workflow-runs:view:group:${grouping}`); });
            await vi.waitFor(() => expect(storage.getState().settings.collectionDisplayPreferencesV1?.workflowRun?.groupBy).toBe(grouping));
            const model = table()?.props.model as CollectionProps<WorkflowRunCollectionRow>['model'] | undefined;
            const section = model?.sections.find(candidate => candidate.items.some(row => row.key === waiting.id));
            const row = section?.items.find(candidate => candidate.key === waiting.id);
            expect(row).toBeDefined();
            expect(section?.group).toMatchObject({ key: row![grouping].key, title: row![grouping].title });
        }
        await act(async () => { screen.pressByTestId('workflow-runs:view'); });

        await act(async () => { screen.changeTextByTestId('workflow-runs:search', 'release'); });
        expect(await action.execute(get, {}, context)).toMatchObject({
            ok: true, result: { searchQuery: 'release', visibleKeys: [waiting.id] },
        });

        await act(async () => {
            expect(await action.execute(set, { filters: { results }, searchQuery: 'test' }, context))
                .toEqual({ ok: true, result: { ok: true } });
        });
        expect(screen.findHostByTestId('workflow-runs:search')?.props.value).toBe('test');
        expect(await action.execute(get, {}, context)).toMatchObject({
            ok: true, result: { searchQuery: 'test', filters: { results }, visibleKeys: [] },
        });
        await act(async () => {
            expect(await action.execute(reset, {}, context)).toEqual({ ok: true, result: { ok: true } });
        });
        expect(screen.findHostByTestId('workflow-runs:search')?.props.value).toBe('');
        expect(await action.execute(get, {}, context)).toMatchObject({
            ok: true, result: { filters: {}, visibleKeys: expect.arrayContaining([waiting.id, running.id]) },
        });
        await act(async () => {
            expect(await action.execute('settings.invoke', {
                anchor: collectionSpaceSettingRefs('workflowRun').spaces.anchor,
                input: { kind: 'collection_space', entityKind: 'workflowRun', mutation: { op: 'create', space: saved } },
            }, { ...context, surface: 'ui' })).toMatchObject({ ok: true, result: { status: 'completed' } });
        });
        await vi.waitFor(() => expect(screen.findHostByTestId('workflow-runs-space-strip:succeeded')).not.toBeNull());
        await vi.waitFor(() => expect(action.execute(get, {}, context)).resolves.toMatchObject({
            ok: true, result: { filters: { results }, visibleKeys: [] },
        }));
        await act(async () => { screen.pressByTestId(`workflow-runs-space-strip:${allRuns.id}`); });
        await vi.waitFor(() => expect(action.execute(get, {}, context)).resolves.toMatchObject({
            ok: true, result: { filters: {}, visibleKeys: expect.arrayContaining([waiting.id, running.id]) },
        }));
        await act(async () => { screen.pressByTestId('workflow-runs-space-strip:succeeded'); });
        await vi.waitFor(() => expect(action.execute(get, {}, context)).resolves.toMatchObject({
            ok: true, result: { filters: { results }, visibleKeys: [] },
        }));
        await screen.unmount();
        expect(await action.execute(get, {}, context)).toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
    });

    it('groups Runs by saved Workflow title or a distinct label for each unavailable Workflow', async () => {
        const { createPlainArtifactHttpFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const definitionId = '10000000-0000-4000-8000-000000000009';
        const laterDefinitionId = '10000000-0000-4000-8000-00000000000c';
        const http = boundary!;
        for (const [id, title] of [[definitionId, 'Release workflow'], [laterDefinitionId, 'Deploy workflow']] as const) {
            http.artifacts.replaceStoredRow(createPlainArtifactHttpFixture({
                id, title, isDecrypted: true, seq: 1, headerVersion: 1, bodyVersion: 1, createdAt: 1, updatedAt: 1,
                rawHeader: { kind: 'workflow-definition.v1', definitionId: id, metadata: { title },
                    revision: { headerVersion: 1, bodyVersion: 1 }, previewSteps: [] },
            }, 'account-a'));
        }
        const exactReads: unknown[] = [];
        setRuntimeFetch(async (url, init) => {
            if (new URL(String(url)).pathname === '/v1/artifacts/read') exactReads.push(JSON.parse(String(init?.body)));
            return http.request(url, init);
        });
        const runRows = [
            ...[waiting, running].map(run => ({ ...run, sourceArtifactId: definitionId })),
            { ...waiting, id: 'run-unavailable-a', sourceArtifactId: '10000000-0000-4000-8000-00000000000a' },
            { ...waiting, id: 'run-unavailable-b', sourceArtifactId: '10000000-0000-4000-8000-00000000000b' },
        ];
        executeMock.mockImplementation(async (actionId: string, input: Record<string, unknown>) => {
            if (actionId === 'workflow.definition.list') {
                const definitions: WorkflowDefinitionListResultV1['definitions'] = [{
                    kind: 'workflow-definition.v1',
                    definitionId: '10000000-0000-4000-8000-000000000001',
                    metadata: { title: 'Another workflow' }, revision: { headerVersion: 1, bodyVersion: 1 }, contentStatus: 'available',
                    stepCount: 1, ownerAccountId: 'account-a', access: 'owner', triggers: [], nextRunAt: null,
                }];
                return { ok: true, result: { definitions } };
            }
            if (actionId === 'workflow.run.list' && input.cursor === 'more-runs') return { ok: true, result: {
                runs: [{ ...waiting, id: 'later-run', sourceArtifactId: laterDefinitionId }],
                metadataByRunId: { 'later-run': { kind: 'available', value: { title: 'Deploy the release' } } },
            } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: runRows, nextCursor: 'more-runs', metadataByRunId: {
                [waiting.id]: { kind: 'available', value: { title: 'Prepare the release' } },
                [running.id]: { kind: 'unavailable', reason: 'content_unavailable' },
            } } };
            return { ok: false, error: 'unexpected', errorCode: 'unexpected' };
        });
        const { settings } = storage.getState();
        storage.setState({ settings: { ...settings, collectionDisplayPreferencesV1: {
            ...settings.collectionDisplayPreferencesV1, workflowRun: { groupBy: 'workflow' },
        } } });
        routeState.pathname = '/workflows/runs';
        const screen = await renderScreen(<AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
            <WorkflowsRunsRoute />
        </AppShellColumnContext.Provider>, { wrapper: TestAuth });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Release workflow'));
        expect(screen.getTextContent()).toContain('Prepare the release');
        expect(screen.getTextContent()).toContain('workflows.destination.display.workflow · 0000000a');
        expect(screen.getTextContent()).toContain('workflows.destination.display.workflow · 0000000b');
        const sourceIds = [...new Set(runRows.map(run => run.sourceArtifactId))];
        expect(exactReads).toEqual([expect.objectContaining({ projection: 'headers', artifactIds: expect.arrayContaining(sourceIds) })]);
        expect(exactReads[0]).toMatchObject({ artifactIds: { length: sourceIds.length } });
        await act(async () => { screen.pressByTestId('workflow-runs:collection:continuation:more'); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Deploy workflow'));
        expect(screen.getTextContent()).toContain('Release workflow');
        expect(exactReads.at(-1)).toMatchObject({ projection: 'headers', artifactIds: expect.arrayContaining([laterDefinitionId]) });
        expect(executeMock.mock.calls.some(([id]) => id === 'workflow.definition.list' || id === 'workflow.definition.get')).toBe(false);
        await screen.unmount();
    });

    it('reveals Account triggers from an old link even while the retained column shows Runs', async () => {
        answerLists();
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await pressView(screen, 'runs');
        routeState.params = { trigger: 'legacy-manual' };
        // The router mock has no navigation subscription; changing a presentation prop delivers its new params.
        await screen.update(<WorkflowsColumn surface="page" />);
        expect(screen.findByTestId('workflows-column:group:builtin')).not.toBeNull();
        // Runs stay built for the next switch, but only Definitions are presented.
        expect(screen.findHostByTestId('workflows-column:runs')?.props.pointerEvents).toBe('none');
    });
    it('lets the Runs view open a run from the one Run collection, never a Session draft', async () => {
        answerLists();
        const scope = storage.getState().profileScope!;
        configureSessionDraftRepository({ scope, syncEnabled: false });
        const draftId = '99999999-9999-4999-8999-999999999999';
        writeNewSessionDraft({ scope, draftId, patch: { text: 'Unsent Session draft' }, materializationIntent: 'seeded' });
        const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await pressView(screen, 'runs');
        const row = () => screen.findAll((node) => node.props?.testID === 'workflows-column:runs:row:run-waiting' && typeof node.props.onPress === 'function')[0];
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(row()).toBeDefined();
        });
        // The sidebar's Runs read the Run collection (scene 8 D2): its own space title, no Sessions list, no drafts.
        expect(screen.findHostByTestId('workflows-column-runs-space-title')).not.toBeNull();
        expect(screen.tree.root.findAll((node) => node.props?.testID === 'sessions-list-keyboard-frame')).toHaveLength(0);
        expect(screen.findByTestId(`session-draft-row:new-session:${draftId}`)).toBeNull();
        await act(async () => { row()!.props.onPress(); });
        expect(routerPush).toHaveBeenCalledWith(
            '/workflows/runs/run-waiting?target=occurrence&automationId=automation-1&serverId=unified-column.test',
        );
        await pressView(screen, 'definitions');
        expect(screen.findHostByTestId('workflows-column:runs')?.props.pointerEvents).toBe('none');
    });

    it('switches Definitions and Runs inside one list whose switch stays put, with each view’s own spaces (R8-7, D2)', async () => {
        answerLists();
        // Beside the library home the sidebar keeps its own space title, filter and search, as the Sessions sidebar does
        // (owner 2026-11-19 15:10Z); both narrow through the one Workflow draft.
        const beside = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(beside.findHostByTestId('workflows-column:view:runs')).not.toBeNull();
        expect(beside.findHostByTestId('workflows-column-space-title')).not.toBeNull();
        expect(beside.findHostByTestId('workflows-column-space-filter-open')).not.toBeNull();
        // In a shell column the search waits behind its magnifier; elsewhere the field stands open.
        expect(beside.findHostByTestId('workflows-column:search:toggle') ?? beside.findHostByTestId('workflows-column:search')).not.toBeNull();
        await beside.unmount();
        const screen = await renderScreen(<WorkflowsColumn surface="page" />, { wrapper: TestAuth });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        const list = screen.findHostByTestId('workflows-column:list');
        const tabs = screen.findHostByTestId('workflows-column:view:runs');
        expect(list).not.toBeNull();
        expect(screen.findHostByTestId('workflows-column-space-title')).not.toBeNull();
        await pressView(screen, 'runs');
        // The same list and switch stay mounted (the thumb glides); Run rows never take a definition space.
        expect(screen.findHostByTestId('workflows-column:list')).toBe(list);
        expect(screen.findHostByTestId('workflows-column:view:runs')).toBe(tabs);
        // It is in the same band under the title in both views, so the title row's width never moves it.
        const inBand = () => screen.findHostByTestId('workflows-column:view-band')!
            .findAll((node) => node.props.testID === 'workflows-column:view:runs').length > 0;
        expect(inBand()).toBe(true);
        expect(screen.findAllHostsByTestId('workflows-column-space-title')).toHaveLength(0);
        expect(screen.findAllHostsByTestId('workflows-column-space-strip')).toHaveLength(0);
        // Runs carry their own space over the one Run collection (owner 2026-11-19 15:10Z, D2).
        expect(screen.findHostByTestId('workflows-column-runs-space-title')).not.toBeNull();
        await pressView(screen, 'definitions');
        expect(screen.findHostByTestId('workflows-column:list')).toBe(list);
        expect(inBand()).toBe(true);
        expect(screen.findHostByTestId('workflows-column-space-title')).not.toBeNull();
    });

    it('keeps both views built across Definitions and Runs switches and presents only the chosen one', async () => {
        answerLists();
        const screen = await renderScreen(<WorkflowsColumn surface="page" />, { wrapper: TestAuth });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        const presented = (testID: string) => screen.findHostByTestId(testID)?.props.pointerEvents === 'auto';
        const definitions = screen.findHostByTestId('workflows-column:group:library');
        expect(definitions).not.toBeNull();
        await pressView(screen, 'runs');
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findHostByTestId('workflows-column:runs:row:run-waiting')).not.toBeNull();
        });
        const runs = screen.findHostByTestId('workflows-column:runs:row:run-waiting');
        expect(runs).not.toBeNull();
        for (const view of ['definitions', 'runs', 'definitions'] as const) {
            await pressView(screen, view);
            // A switch shows the other list as it stood: neither list is built again (P03-TAB-CONTENT W6).
            // Identity, compared as a boolean: a failing match would print both whole render trees.
            expect({ view, definitionsKept: screen.findHostByTestId('workflows-column:group:library') === definitions,
                runsKept: screen.findHostByTestId('workflows-column:runs:row:run-waiting') === runs })
                .toEqual({ view, definitionsKept: true, runsKept: true });
            expect(presented('workflows-column:definitions')).toBe(view === 'definitions');
            expect(presented('workflows-column:runs')).toBe(view === 'runs');
        }
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

    describe('one-time schedules (WF-ONCE-UI)', () => {
        const scheduledAt = Date.UTC(2026, 10, 10, 8, 54);
        /** A Library of Account Workflows, each one Once trigger, answered through the real list, detail and summary owners. */
        async function serveOnceWorkflows(workflows: readonly Readonly<{ id: string; remaining: 0 | 1; lastRun: WorkflowRunStateV1 | null }>[]) {
            const [{ AutomationDefinitionDetailSchema }, { AutomationStoredWorkflowDefinitionRecipeV2Schema },
                { createWorkflowDefinitionFixture }] = await Promise.all([import('@happier-dev/protocol/automations/automationApiV3'),
                import('@happier-dev/protocol/automations/automationWorkflowRecipeV2'), import('@/dev/testkit/fixtures/workflowRunFixtures')]);
            const inlineDefinition = createWorkflowDefinitionFixture({
                defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
                blocks: [{ kind: 'step', id: 'first', document: { text: 'Send the weekly report', references: [], attachments: [] },
                    input: [], result: { kind: 'text' } }],
            });
            const details = workflows.map(workflow => AutomationDefinitionDetailSchema.parse({ id: workflow.id, name: 'Send the weekly report',
                description: null, enabled: true, workflowDefinitionId: null, scopeSessionId: null, targetType: null, existingSessionId: null,
                templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 5,
                assignments: [{ machineId: 'm1', enabled: true, priority: 0, updatedAt: 1 }],
                executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 1,
                    workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition } },
                    triggerEvidence: null }),
                triggers: [{ id: `${workflow.id}-once`, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'schedule',
                    triggerDefinitionEnvelope: null, nextRunAt: workflow.remaining === 1 ? scheduledAt : null,
                    remainingOccurrences: workflow.remaining, schedule: { kind: 'once', scheduledAt } }],
            }));
            automationDefinitionResponse = async (url, init) => {
                if (url.pathname === '/v3/automations/query' && init?.method === 'POST') {
                    const { AutomationDefinitionDetailsRequestSchema } = await import('@happier-dev/protocol/automations/automationApiV3');
                    const query = AutomationDefinitionDetailsRequestSchema.parse(JSON.parse(String(init.body)));
                    return Response.json({ automations: query.scope !== 'account_saved' ? details : [], nextCursor: null });
                }
                const detail = details.find(candidate => url.pathname === `/v3/automations/${candidate.id}`);
                return detail ? Response.json(detail) : undefined;
            };
            const ranAt = new Date(scheduledAt).toISOString();
            const answer = executeMock.getMockImplementation()!;
            executeMock.mockImplementation((actionId: string, input: Record<string, unknown>) => {
                if (actionId === 'workflow.run.summaries' && Array.isArray(input.automationIds)) return Promise.resolve({ ok: true, result: {
                    remainingAutomationIds: [], automationSummaries: (input.automationIds as string[]).map(automationId => {
                        const state = workflows.find(workflow => workflow.id === automationId)?.lastRun ?? null;
                        return { automationId, lastRun: state === null ? null : { id: `run-${automationId}`, state, workflowCustodyState: 'settled',
                            attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, createdAt: ranAt, startedAt: ranAt } };
                    }),
                } });
                return answer(actionId, input);
            });
        }
        const subtitleOf = (screen: Awaited<ReturnType<typeof renderScreen>>, id: string) => screen.findAll(node =>
            node.props?.testID === `workflows-column:library:account-trigger:${id}` && 'subtitle' in node.props)[0]?.props.subtitle as string | undefined;

        it('reads Succeeded or Missed from the occurrence Run\'s own state, and a pending one by its due time', async () => {
            await serveOnceWorkflows([{ id: 'ran', remaining: 0, lastRun: 'succeeded' }, { id: 'missed', remaining: 0, lastRun: 'missed' },
                { id: 'due', remaining: 1, lastRun: null }]);
            const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth });
            await vi.waitFor(() => expect(subtitleOf(screen, 'missed')).toMatch(/^workflows\.runState\.missed · /u));
            expect(subtitleOf(screen, 'ran')).toMatch(/^workflows\.runState\.succeeded · workflows\.triggers\.once\.at\(/u);
            expect(subtitleOf(screen, 'missed')).toContain('workflows.triggers.once.at(');
            expect(subtitleOf(screen, 'due')).toMatch(/^workflows\.triggers\.once\.at\(/u);
        });

        it('opens History inside the trigger\'s own settings and returns to them', async () => {
            await serveOnceWorkflows([{ id: 'ran', remaining: 0, lastRun: 'succeeded' }]);
            const screen = await renderScreen(<WorkflowsColumn />, { wrapper: TestAuth,
                createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(40, 40, 120, 40) }) });
            await vi.waitFor(() => expect(screen.findByTestId('workflows-column:library:account-trigger:ran')).not.toBeNull());
            await screen.pressByTestIdAsync('workflows-column:library:account-trigger:ran');
            await vi.waitFor(() => expect(screen.findByTestId('workflows-column-trigger-popover-history')).not.toBeNull());
            await screen.pressByTestIdAsync('workflows-column-trigger-popover-history');
            // History is the settings' pushed page, where the person already is, not a group appended under the whole Library.
            await vi.waitFor(() => expect(screen.findByTestId('session-work-trigger-history:ran')).not.toBeNull());
            // The spent schedule's History says how it ended before its Run rows.
            expect(screen.findAll(node => node.props?.testID === 'session-work-trigger-history:ran-once' && 'title' in node.props)[0]
                ?.props.title).toBe('workflows.runState.succeeded');
            const back = screen.findByTestId('workflows-column-trigger-popover-back');
            expect(back).not.toBeNull();
            await screen.pressByTestIdAsync('workflows-column-trigger-popover-back');
            await vi.waitFor(() => expect(screen.findByTestId('workflows-column-trigger-popover')).not.toBeNull());
            expect(screen.findByTestId('session-work-trigger-history:ran')).toBeNull();
        });
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
            // Each built-in names its own mark (owner 2026-11-12); the host draws it as that glyph.
            const expectedMark = entry.icon === 'scan-search' ? 'magnifying-glass' : entry.icon;
            expect(marks).toContain(expectedMark);
            await screen.pressByTestIdAsync(`workflows-column:builtin:${entry.id}`);
            expect(routerPush).toHaveBeenLastCalledWith(createWorkflowDefinitionRoute(entry.id));
        }
    });

});
// Third-party rendering boundary; the collection does not render Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
