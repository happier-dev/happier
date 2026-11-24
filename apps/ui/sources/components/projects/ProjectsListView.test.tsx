import { replacePersistentUiStateForTest, PersistedPaneScopesSchema } from '@/dev/testkit/harness/persistentUiState';
import { t } from '@/text';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { projectLastMobileSurfaceState, projectLastActiveRootPathState, projectLastActiveWorktreeIdState } from '@/sync/domains/state/navigationUiState';
import * as React from 'react';
import { act } from 'react-test-renderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { CHANGES_AFTER_CURSOR_HTTP_HEADER, ChangesResponseSchema, CurrentCursorResponseSchema, type ChangeEntry } from '@happier-dev/protocol/changes';
import { buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowChangeHintV1Schema, ProjectAccountRowReadRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { Socket } from 'socket.io-client';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ProjectOrganizationRow } from '@/sync/store/domains/projectAccountRows';
import type { ProjectMobileSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { buildProjectPaneScopeId } from './detail/projectPaneScope';
import { buildRealmQualifiedMobileSurfaceStorageKey } from '@/sync/domains/settings/mobileSurfacePersistence';

const projectsHomeUrl = 'https://projects-list.test';
const projectsAccountId = 'account-1';
const homes = createHomeGovernanceHarness();
let accountSocket: Socket | undefined;
const homeProjectRows = new Map<string, ProjectAccountRowV1>();
const homeProjectChanges: ChangeEntry[] = [];

installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    if (serverUrl !== projectsHomeUrl) return;
    accountSocket = socket;
    configureConnectedServerSocketBoundary(socket);
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const folderSelection = vi.hoisted(() => ({ path: null as string | null }));
const draftRecords = vi.hoisted(() => new Map<string, string>());
const routerPushSpy = vi.hoisted(() => vi.fn());
const phoneRowRenders = vi.hoisted(() => new Map<string, number>());
let relationships: WorkspaceSyncRelationshipV1[] = [];
let translationPrefixMock = '';

let serverId: string;
let machinesMock: Machine[] = [];
let workspaceRefsV1Mock: WorkspaceRefV1[] = [];
let organizationsMock: ProjectOrganizationRow[] = [];
let deviceTypeMock: 'phone' | 'tablet' = 'tablet';
let paneScopesMock: Record<string, { right?: { activeTabId?: string | null } }> = {};
let localSettingsMock: Record<string, unknown> = {};
let projectLastMobileSurfacesByWorkspaceRefIdMock: Record<string, ProjectMobileSurface> = {};
let projectLastActiveRootPathsMock: Record<string, string> = {};
let projectLastActiveWorktreeIdsMock: Record<string, string> = {};

vi.mock('react-native', async () => {
    const React = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: any) => {
            // Count real row output at the native boundary; Item and its internal logic stay real.
            if (typeof props.testID === 'string' && props.testID.startsWith('projects-list-item-')) {
                phoneRowRenders.set(props.testID, (phoneRowRenders.get(props.testID) ?? 0) + 1);
            }
            return React.createElement('Pressable', props, props.children);
        },
        Platform: { OS: 'web' },
        Dimensions: { get: () => ({ width: deviceTypeMock === 'phone' ? 390 : 1024, height: 844, scale: 1, fontScale: 1 }),
            addEventListener: () => ({ remove: () => {} }) },
    });
});

vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

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
        translate: (key, params) => {
            const base = typeof params?.machine === 'string' ? `${key}:${params.machine}` : key;
            return `${translationPrefixMock}${base}`;
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPushSpy,
        },
    }).module;
});

const shownModals = vi.hoisted((): unknown[] => []);

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: (config) => {
        shownModals.push(config);
        // Only the modal presentation boundary is substituted; its real deferred-selection adapter runs.
        const candidate = config as Readonly<{ props?: Readonly<{ onResolve?: (path: string | null) => void }> }>;
        if (candidate.props?.onResolve) queueMicrotask(() => candidate.props?.onResolve?.(folderSelection.path));
        return 'modal-id';
    } } }).module;
});

// Device persistence is a system boundary; the actual retained-draft repository and Open entrance stay real.
vi.mock('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage', () => ({
    getSessionDraftPersistenceStorage: () => ({ getString: (key: string) => draftRecords.get(key), getAllKeys: () => [...draftRecords.keys()],
        set: (key: string, value: string) => draftRecords.set(key, value), delete: (key: string) => draftRecords.delete(key),
        flush: async () => {} }),
}));

const { storage } = await import('@/sync/domains/state/storage');
const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { appPaneReduce, createAppPaneState } = await import('@/components/appShell/panes/model/appPaneReducer');
const { serializeDetailsWorkspaceState } = await import('@/components/appShell/panes/details/workspace/migrateLegacyDetailsWorkspaceState');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

/** A closed row mounts only its trigger; the row menu model exists while its menu is open. */
async function openFirstRowMenu(screen: Awaited<ReturnType<typeof renderProjects>>) {
    const trigger = screen.root.findAll(node => String(node.props.accessibilityLabel).startsWith('common.moreActions')
        && typeof node.props.onPress === 'function')[0]!;
    await act(async () => trigger.props.onPress({}));
}
function findRowMenu(screen: Awaited<ReturnType<typeof renderProjects>>) {
    return screen.findAllByType(DropdownMenu).find(menu => menu.props.items?.some((item: { id: string }) => item.id === 'rename'));
}

beforeEach(async () => {
    await homes.reset();
    await loadSyncSingletonForTests();
    accountSocket = undefined;
    homeProjectRows.clear();
    homeProjectChanges.length = 0;
    serverId = await homes.addHome({ name: 'Projects Home', serverUrl: projectsHomeUrl, accountId: projectsAccountId });
    homes.answer(serverId, 'POST /v1/account/project-rows/list', { select: () => ({
        body: { status: 'listed', coverage: 'complete', rows: [...homeProjectRows.values()] },
    }) });
    homes.answer(serverId, 'POST /v1/account/project-rows/read', { select: input => {
        const { key } = ProjectAccountRowReadRequestV1Schema.parse(input);
        const row = homeProjectRows.get(buildProjectAccountRowPhysicalKeyV1(key));
        return { body: row ? { status: 'present', row } : { status: 'absent' } };
    } });
    homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
    homes.answer(serverId, '/v2/cursor', { select: () => ({
        body: CurrentCursorResponseSchema.parse({ cursor: homeProjectChanges.length, changesFloor: 0 }),
    }) });
    homes.answer(serverId, '/v2/changes', { select: (_input, { url, init }) => {
        const query = new URL(url).searchParams;
        const afterHeader = new Headers(init?.headers).get(CHANGES_AFTER_CURSOR_HTTP_HEADER);
        const after = Number(afterHeader ?? query.get('after') ?? 0);
        const limit = Number(query.get('limit') ?? homeProjectChanges.length);
        const changes = homeProjectChanges.slice(after, after + limit);
        const nextCursor = changes.at(-1)?.cursor ?? after;
        return {
            body: ChangesResponseSchema.parse({ changes, nextCursor, full: nextCursor < homeProjectChanges.length }),
            ...(afterHeader === null ? {} : { headers: { [CHANGES_AFTER_CURSOR_HTTP_HEADER]: afterHeader } }),
        };
    } });
    // The returning device has already observed this Home at cursor zero.
    const { saveChangesCursor } = await import('@/sync/domains/state/persistence');
    saveChangesCursor('0', { serverScope: serverId, accountId: projectsAccountId });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: homes.findByServerUrl(projectsHomeUrl)!.token! });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    await createDefaultActionExecutor().execute('projects.list', { serverId });
    draftRecords.clear();
});
afterEach(async () => {
    await standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    await homes.reset();
});

function mobileSurfaces() {
    return Object.fromEntries(Object.entries(projectLastMobileSurfacesByWorkspaceRefIdMock).map(([id, surface]) => [
        buildRealmQualifiedMobileSurfaceStorageKey('project', { serverId, accountId: 'account-1' }, id)!, surface,
    ]));
}
async function publishHomeProjectRows() {
    const socket = accountSocket;
    if (!socket) throw new Error('Project fixture has no connected Account socket');

    const { rows } = createPlainProjectAccountRowListFixture({
        workspaceRefs: workspaceRefsV1Mock, relationships, organizations: organizationsMock,
    });
    const changed = rows.map(row => {
        const entityId = buildProjectAccountRowPhysicalKeyV1(row.key);
        const previous = homeProjectRows.get(entityId);
        const next = { ...row, revision: previous ? previous.revision + 1 : row.revision };
        homeProjectRows.set(entityId, next);
        const change: ChangeEntry = {
            cursor: homeProjectChanges.length + 1, changedAt: 1, kind: 'account', entityId,
            hint: ProjectAccountRowChangeHintV1Schema.parse({ projectAccountRow: true, key: next.key, revision: next.revision }),
        };
        homeProjectChanges.push(change);
        return { entityId, revision: next.revision };
    });
    // The socket announces the changed keys. Their hints and contents are read from the Home.
    const update = UpdateContainerSchema.parse({
        id: `project-rows-${homeProjectChanges.length}`, seq: homeProjectChanges.length, createdAt: 1,
        body: { t: 'account-change', changeKinds: ['account'], entityIds: changed.map(row => row.entityId) },
    });
    await act(async () => {
        for (const listener of socket.listenersAny()) listener('update', update);
        await vi.waitFor(() => {
            const applied = storage.getState().projectAccountRows?.revisionsByPhysicalKey;
            expect(changed.filter(row => applied?.[row.entityId] !== row.revision)).toEqual([]);
        });
    });
}

async function renderProjects(element: React.ReactElement) {
    let panes = createAppPaneState({ maxScopesInMemory: 12 });
    for (const [scopeId, scope] of Object.entries(paneScopesMock)) {
        if (scope.right?.activeTabId) panes = appPaneReduce(panes, { type: 'openRight', scopeId, tabId: scope.right.activeTabId });
    }
    replacePersistentUiStateForTest(paneUiState, PersistedPaneScopesSchema.parse(Object.fromEntries(Object.entries(panes.scopes).map(([id, scope]) => [id,
        { mainHidden: scope.mainHidden, right: scope.right, bottom: scope.bottom, details: serializeDetailsWorkspaceState(scope.details) }]))));
    replacePersistentUiStateForTest(projectLastMobileSurfaceState, mobileSurfaces());
    replacePersistentUiStateForTest(projectLastActiveRootPathState, projectLastActiveRootPathsMock);
    replacePersistentUiStateForTest(projectLastActiveWorktreeIdState, projectLastActiveWorktreeIdsMock);
    storage.setState({ localSettings: { ...localSettingsDefaults, ...localSettingsMock } });
    storage.getState().applyMachines(machinesMock, true);
    // A synced Account: its Machine inventory has arrived (even when it holds none of these Machines).
    storage.getState().applyReady();
    const accountScope = storage.getState().profileScope;
    if (!accountScope) throw new Error('Project fixture has no connected Account');
    await publishHomeProjectRows();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const result = await createDefaultActionExecutor().execute('projects.list', { serverId });
    expect(result.ok).toBe(true);
    expect(storage.getState().projectAccountRows?.workspaceRefs.map(ref => ref.id), JSON.stringify({
        scope: storage.getState().profileScope, rows: storage.getState().projectAccountRows, result,
        requests: homes.requestsFor('/v1/account/project-rows/list'),
    })).toEqual(workspaceRefsV1Mock.map(ref => ref.id));
    return renderScreen(<AppPaneProvider>{element}</AppPaneProvider>);
}

function createMachine(params: Readonly<{
    id: string;
    host: string;
    active?: boolean;
    activeAt?: number;
}>): Machine {
    return createMachineFixture({
        id: params.id,
        active: params.active ?? true,
        activeAt: params.activeAt ?? 1,
        metadata: {
            host: params.host,
            platform: 'darwin',
            happyCliVersion: '0',
            happyHomeDir: '/tmp/.happy',
            homeDir: '/Users/tester',
        },
    });
}

describe('ProjectsListView', () => {
    beforeEach(() => {
        standardCleanup();
        machinesMock = [];
        workspaceRefsV1Mock = [];
        organizationsMock = [];
        deviceTypeMock = 'tablet';
        paneScopesMock = {};
        localSettingsMock = {};
        projectLastMobileSurfacesByWorkspaceRefIdMock = {};
        projectLastActiveRootPathsMock = {};
        projectLastActiveWorktreeIdsMock = {};
        translationPrefixMock = '';
        folderSelection.path = null;
        relationships = [];
        routerPushSpy.mockReset();
        shownModals.length = 0;
        phoneRowRenders.clear();
    });

    it('keeps the elected Project title across checkout sort, search and refresh', async () => {
        deviceTypeMock = 'phone';
        machinesMock = [createMachine({ id: 'machine', host: 'Machine' })];
        workspaceRefsV1Mock = [
            { id: 'young', serverId, machineId: 'machine', rootPath: '/a-young', projectKey: 'anchor', createdAtMs: 2 },
            { id: 'old', serverId, machineId: 'machine', rootPath: '/z-baseline', projectKey: 'anchor', createdAtMs: 1 },
        ];
        const { ProjectsListView } = await import('./ProjectsListView');
        const { PhoneTabNavRowProvider } = await import('@/components/navigation/shell/phoneTabNavRow');
        const { useProjectPickerOptions } = await import('./useProjectPickerOptions');
        const { listWidgetGroupProjects } = await import('@/components/widgets/group/widgetGroupCopy');
        let choices: ReturnType<typeof useProjectPickerOptions> = [];
        function Choices() { choices = useProjectPickerOptions(); return null; }
        storage.getState().applyMachines(machinesMock, true);
        storage.getState().applyReady();
        applyProjectAccountRowsFixture(storage, { workspaceRefs: workspaceRefsV1Mock, organizations: [
            { key: { kind: 'project-organization', serverId, projectKey: 'anchor' }, revision: 0, value: { hidden: false } },
        ] });
        const screen = await renderScreen(<AppPaneProvider><PhoneTabNavRowProvider leading={null} trailing={null}>
            <Choices /><ProjectsListView />
        </PhoneTabNavRowProvider></AppPaneProvider>);
        const titles = () => screen.root.findAll(node => typeof node.type === 'string')
            .flatMap(node => node.children.filter(child => typeof child === 'string'));
        expect(titles()).toContain('z-baseline');
        expect(choices.find(choice => choice.projectKey === 'anchor')?.label).toBe('z-baseline');
        expect(listWidgetGroupProjects(workspaceRefsV1Mock, serverId)).toEqual([{ projectId: 'anchor', label: 'z-baseline' }]);
        await act(async () => { screen.findByTestId('projects-search:toggle')!.props.onPress(); });
        await act(async () => { screen.findByTestId('projects-search')!.props.onChangeText('a-young'); });
        expect(titles()).toContain('z-baseline');
        await act(async () => { screen.findByTestId('projects-search')!.props.onChangeText(''); });
        expect(titles()).toContain('z-baseline');
        const held = storage.getState().projectAccountRows!;
        await act(async () => applyProjectAccountRowsFixture(storage, { ...held, status: 'loading',
            workspaceRefs: [...workspaceRefsV1Mock].reverse().map(ref => ({ ...ref, lastOpenedAtMs: ref.id === 'old' ? 100 : 0 })) }));
        expect(titles()).toContain('z-baseline');
        expect(choices.find(choice => choice.projectKey === 'anchor')?.label).toBe('z-baseline');
        await act(async () => applyProjectAccountRowsFixture(storage, { ...held, organizations: [
            { key: { kind: 'project-organization', serverId, projectKey: 'anchor' }, revision: 1,
                value: { hidden: false, label: 'Named project' } },
        ] }));
        expect(titles()).toContain('Named project');
        expect(choices.find(choice => choice.projectKey === 'anchor')?.label).toBe('Named project');
        expect(listWidgetGroupProjects(workspaceRefsV1Mock, serverId, storage.getState().projectAccountRows!.organizations))
            .toEqual([{ projectId: 'anchor', label: 'Named project' }]);
    });

    it('PF3 renders only the changed phone row among 150 Projects on one checkout fact change', async () => {
        deviceTypeMock = 'phone';
        const nowMs = Date.now();
        machinesMock = [createMachine({ id: 'machine', host: 'Machine', activeAt: nowMs })];
        workspaceRefsV1Mock = Array.from({ length: 150 }, (_, index) => ({
            id: `ref-${index}`, serverId, machineId: 'machine', rootPath: `/repo-${index}`,
            projectKey: `project-${index}`, createdAtMs: 1,
        })).sort((left, right) => left.id.localeCompare(right.id));
        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);
        expect(screen.findByTestId('projects-list-item-ref-149')).not.toBeNull();
        expect(phoneRowRenders.size).toBe(150);
        phoneRowRenders.clear();
        const session = createSessionListRenderableSessionFixture({ id: 'session', active: true, activeAt: nowMs,
            thinking: true, thinkingAt: nowMs, metadata: { machineId: 'machine', path: '/repo-0' } });
        await act(async () => storage.setState({ sessionListRowsByServerId: { [serverId]: { session } },
            sessionListRenderableDelta: { revision: 1, changedSessionIds: ['session'], removedSessionIds: [], rebuiltSessionListIndex: false } }));
        expect(phoneRowRenders.get('projects-list-item-ref-0')).toBe(1);
        expect([...phoneRowRenders.keys()].filter(key => key !== 'projects-list-item-ref-0').length).toBe(0);
    });

    // F2/F4: wherever the list is the whole page (a phone tab, a collapsed column) it heads with the main-screen head.
    it('names the page with its title in the phone tab shell and wherever it is the whole page', async () => {
        const { PhoneTabNavRowProvider } = await import('@/components/navigation/shell/phoneTabNavRow');
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        const { ProjectsListView } = await import('./ProjectsListView');

        const inShell = await renderProjects(<PhoneTabNavRowProvider leading={null} trailing={null}><ProjectsListView /></PhoneTabNavRowProvider>);
        expect(inShell.findByType(PageHeader).props.title).toBe(t('tabs.projects'));

        const elsewhere = await renderProjects(<ProjectsListView />);
        expect(elsewhere.findByType(PageHeader).props.title).toBe(t('tabs.projects'));
    });

    it('heads the phone main screen with search and "+" on the title row and lends the bar its "+" (owner 11-11)', async () => {
        deviceTypeMock = 'phone';
        machinesMock = [createMachine({ id: 'm1', host: 'studio' })];
        const { PhoneTabNavRowProvider } = await import('@/components/navigation/shell/phoneTabNavRow');
        const { usePageCreateAction } = await import('@/components/navigation/mobile/chrome/pageCreateAction');
        const { ProjectsListView } = await import('./ProjectsListView');
        const bar: { action: ReturnType<typeof usePageCreateAction> } = { action: null };
        function Bar() { bar.action = usePageCreateAction(); return null; }
        const screen = await renderProjects(<PhoneTabNavRowProvider leading={null} trailing={null}><Bar /><ProjectsListView /></PhoneTabNavRowProvider>);

        // The "+" replaces the inline add row; the bar's "+" opens the same add menu.
        expect(screen.findByTestId('projects-list:add-row')).toBeNull();
        expect(screen.findByTestId('projects-add:header')).not.toBeNull();
        expect(bar.action?.label).toBe(t('projects.actions.addProject'));
        const menu = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects-list:add:menu');
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(['clone', 'manage']));

        // The magnifier opens the field; closing it again clears the query.
        expect(screen.findByTestId('projects-search')).toBeNull();
        await act(async () => { screen.findByTestId('projects-search:toggle')!.props.onPress(); });
        expect(screen.findByTestId('projects-search')).not.toBeNull();
    });

    it('keeps hidden Projects reachable through the phone Hidden group without rendering checkout leaves', async () => {
        workspaceRefsV1Mock = [{ id: 'hidden-ref', serverId, machineId: 'machine', rootPath: '/work/hidden',
            createdAtMs: 1, projectKey: 'anchor' }];
        organizationsMock = [{ key: { kind: 'project-organization', serverId, projectKey: 'anchor' },
            revision: 1, value: { hidden: true, pinned: true } }];
        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);
        expect(screen.findByTestId('projects-list-item-hidden-ref')).toBeNull();
        const hidden = screen.findByTestId('projects-list-organization-hidden');
        expect(hidden).not.toBeNull();
        await act(async () => { hidden!.props.onPress(); });
        expect(screen.findByTestId('projects-list-organization-show-anchor')).not.toBeNull();
    });

    it('offers distinct online same-name Machine choices in the single add entrance', async () => {
        const nowMs = Date.now();
        machinesMock = [
            createMachine({ id: 'm1', host: 'leeroy-mbp', active: true, activeAt: nowMs }),
            createMachine({ id: 'm2', host: 'leeroy-mbp', active: true, activeAt: nowMs - 1 }),
            createMachine({ id: 'm3', host: 'leeroy-mbp', active: false, activeAt: 1 }),
        ];

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);

        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const menu = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects-list:add:menu');
        expect(menu?.props.items.find((item: { id: string }) => item.id === 'folder')?.submenu.items
            .map((item: { id: string; title: string }) => ({ id: item.id, title: item.title })))
            .toEqual([{ id: 'machine:m1', title: 'leeroy-mbp · m1' }, { id: 'machine:m2', title: 'leeroy-mbp · m2' }]);
        expect(screen.findByTestId('projects-add:header')).toBeTruthy();
        expect(screen.findByTestId('projects-add-first-machine:m1')).toBeNull();
        expect(screen.findByTestId('projects-add-first-machine:m2')).toBeNull();
    });

    it('does not create a Project or navigate when folder selection is cancelled', async () => {
        const nowMs = Date.now();
        machinesMock = [
            createMachine({ id: 'm1', host: 'leeroy-mbp', active: true, activeAt: nowMs }),
        ];
        folderSelection.path = null;

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);

        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        await act(async () => { screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects-list:add:menu')!.props.onSelect('machine:m1'); });

        expect(routerPushSpy).toHaveBeenCalledTimes(0);
        expect(storage.getState().projectAccountRows?.workspaceRefs).toEqual([]);
    });

    it('retains the chosen folder in Open without creating a renderer-owned checkout', async () => {
        machinesMock = [createMachine({ id: 'm1', host: 'leeroy-mbp', activeAt: Date.now() })];
        folderSelection.path = '/repo';

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        await act(async () => { screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects-list:add:menu')!.props.onSelect('machine:m1'); });

        // On a computer Open is the dialog over the page; its address is the retained draft.
        const dialog = shownModals.find((config) => (config as { chrome?: { testID?: string } }).chrome?.testID === 'projects.open.dialog') as
            { props: { routeParams: { serverId: string; draftId: string } } } | undefined;
        expect(routerPushSpy).not.toHaveBeenCalled();
        const route = { params: dialog!.props.routeParams };
        expect(route.params).toMatchObject({ serverId, draftId: expect.any(String) });
        const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        expect(getSessionDraftSnapshot({ serverId, accountId: 'account-1' }, { kind: 'projectOpen', draftId: route.params.draftId })?.document)
            .toMatchObject({ selection: { value: { serverId, machineId: 'm1', source: { kind: 'folder', path: '/repo' },
                materialization: { kind: 'attach' } } } });
        expect(storage.getState().projectAccountRows?.workspaceRefs).toEqual([]);
    });

    it('opens the last active mobile project subroute from the projects list', async () => {
        deviceTypeMock = 'phone';
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId,
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];
        paneScopesMock = {
            [buildProjectPaneScopeId('wr_1', serverId)]: {
                right: { activeTabId: 'git' },
            },
        };

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-list-item-wr_1');

        expect(routerPushSpy).toHaveBeenCalledWith(`/projects/wr_1/changes?worktreeId=%40root&serverId=${encodeURIComponent(serverId)}&mobileSurface=git`);
    });

    it('opens a Project with several checkouts from its row on the latest one, and discloses it only from its chevron', async () => {
        deviceTypeMock = 'phone';
        workspaceRefsV1Mock = [
            { id: 'wr_a', serverId, machineId: 'm1', rootPath: '/repo-a', label: 'Repo', projectKey: 'repo', createdAtMs: 1, lastOpenedAtMs: 5 },
            { id: 'wr_b', serverId, machineId: 'm2', rootPath: '/repo-b', label: 'Repo', projectKey: 'repo', createdAtMs: 1, lastOpenedAtMs: 9 },
        ];

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);
        const projectRow = 'projects-list-project-repo';
        expect(screen.findByTestId('projects-list-item-wr_b')).toBeNull();

        await screen.pressByTestIdAsync(`${projectRow}:disclosure`);
        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('projects-list-item-wr_b')).not.toBeNull();

        await screen.pressByTestIdAsync(projectRow);
        expect(routerPushSpy).toHaveBeenCalledWith(`/projects/wr_b/overview?worktreeId=%40root&serverId=${encodeURIComponent(serverId)}`);
        // Still open: the row's press opened the Project, it did not close the Project's checkouts.
        expect(screen.findByTestId('projects-list-item-wr_a')).not.toBeNull();
    });

    it('defaults mobile project opens to Overview when no page is remembered', async () => {
        deviceTypeMock = 'phone';
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId,
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-list-item-wr_1');

        expect(routerPushSpy).toHaveBeenCalledWith(`/projects/wr_1/overview?worktreeId=%40root&serverId=${encodeURIComponent(serverId)}`);
    });

    it('offers the same + composition as the column: a folder, a clone, Sources and Manage', async () => {
        machinesMock = [createMachine({ id: 'm1', host: 'studio' })];
        workspaceRefsV1Mock = [{ id: 'wr_1', serverId, machineId: 'm1', rootPath: '/repo', label: 'Repo', createdAtMs: 1 }];
        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);

        expect(screen.findByTestId('projects-add:header')).toBeTruthy();
        const add = screen.findAllByType(DropdownMenu).find((menu) => menu.props.items?.some((item: { id: string }) => item.id === 'clone'));
        expect(add?.props.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(['clone', 'manage']));
    });

    it('opens Save as a source with no repository guess when the exact checkout has no hosting identity', async () => {
        // bb44bd45886 lists added Projects; a census checkout alone stays in From your sessions.
        organizationsMock = [{ key: { kind: 'project-organization', serverId, projectKey: 'wr_1' },
            revision: 1, value: { hidden: false } }];
        workspaceRefsV1Mock = [{ id: 'wr_1', serverId, machineId: 'm1', rootPath: '/repo', label: 'Repo', createdAtMs: 1 }];
        homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, { body: {
            ok: true,
            sources: [{ id: 'unrelated', revision: 1, name: 'Unrelated source', createdByAccountId: 'account-1', audience: [],
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'octocat/Hello-World' }, protocol: 'https' } }],
            coverage: { complete: true, nextCursor: null },
        } });
        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);
        await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)
            .some(node => node.props.items?.some((item: { id: string }) => item.id === 'source:unrelated'))).toBe(true));
        const menu = screen.root.findAll((node) => typeof node.props?.onSaveAsSource === 'function' && node.props.workspaceRef?.id === 'wr_1')[0]!;

        await act(async () => { await menu.props.onSaveAsSource(menu.props.workspaceRef); });

        const sheet = shownModals.find((config) => (config as { chrome?: { testID?: string } }).chrome?.testID === 'projects-save-as-source') as
            | Readonly<{ props: Readonly<{ controller: { getSnapshot(): { creationDraft: { name: string } | null; addressSaveDisabledReason: string | null } }; discard(): void }> }>
            | undefined;
        expect(sheet).toBeTruthy();
        expect(sheet!.props.controller.getSnapshot().creationDraft?.name).toBe('Repo');
        expect(sheet!.props.controller.getSnapshot().creationDraft).toMatchObject({ address: '', repository: null });
        expect(sheet!.props.controller.getSnapshot().addressSaveDisabledReason).toBe('projects.sources.saveNeedsAddress');

        await act(async () => { sheet!.props.discard(); });
        expect(sheet!.props.controller.getSnapshot().creationDraft).toBeNull();
    });

    it('keeps project row menu props stable across unrelated cockpit-state rerenders', async () => {
        // bb44bd45886 lists added Projects; a census checkout alone stays in From your sessions.
        organizationsMock = [{ key: { kind: 'project-organization', serverId, projectKey: 'wr_1' },
            revision: 1, value: { hidden: false } }];
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId,
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);

        await openFirstRowMenu(screen);
        const firstDropdown = findRowMenu(screen);
        expect(firstDropdown).toBeTruthy();
        const firstItems = firstDropdown?.props?.items;
        const firstOnSelect = firstDropdown?.props?.onSelect;

        projectLastMobileSurfacesByWorkspaceRefIdMock = { wr_1: 'git' };

        await act(async () => {
            replacePersistentUiStateForTest(projectLastMobileSurfaceState, mobileSurfaces());
        });
        await screen.update(<AppPaneProvider><ProjectsListView /></AppPaneProvider>);

        const secondDropdown = findRowMenu(screen);
        expect(secondDropdown?.props?.items).toBe(firstItems);
        expect(secondDropdown?.props?.onSelect).toBe(firstOnSelect);
    });

    it('reopens the remembered mobile worktree path without reviving the retired route setting', async () => {
        deviceTypeMock = 'phone';
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId,
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];
        localSettingsMock = {
            projectLastMobileRouteByWorkspaceRefId: { wr_1: 'git' },
        };
        projectLastActiveRootPathsMock = { wr_1: '/repo/.worktrees/feature-auth' };
        projectLastActiveWorktreeIdsMock = { wr_1: 'gitwt_feature' };

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-list-item-wr_1');

        expect(routerPushSpy).toHaveBeenCalledWith(`/projects/wr_1/overview?worktreeId=gitwt_feature&serverId=${encodeURIComponent(serverId)}`);
    });

    it('reopens the remembered cockpit-era mobile surface from local project state', async () => {
        deviceTypeMock = 'phone';
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId,
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];
        projectLastActiveRootPathsMock = { wr_1: '/repo/.worktrees/feature-auth' };
        projectLastActiveWorktreeIdsMock = { wr_1: 'gitwt_feature' };
        projectLastMobileSurfacesByWorkspaceRefIdMock = { wr_1: 'overview' };

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-list-item-wr_1');

        expect(routerPushSpy).toHaveBeenCalledWith(`/projects/wr_1/overview?worktreeId=gitwt_feature&serverId=${encodeURIComponent(serverId)}`);
    });

    it('reopens the remembered cockpit terminal surface from local project state', async () => {
        deviceTypeMock = 'phone';
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId,
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];
        projectLastActiveRootPathsMock = { wr_1: '/repo/.worktrees/feature-auth' };
        projectLastActiveWorktreeIdsMock = { wr_1: 'gitwt_feature' };
        projectLastMobileSurfacesByWorkspaceRefIdMock = { wr_1: 'terminal' };

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-list-item-wr_1');

        expect(routerPushSpy).toHaveBeenCalledWith(`/projects/wr_1/overview?worktreeId=gitwt_feature&serverId=${encodeURIComponent(serverId)}&mobileSurface=terminal`);
    });

    it('anchors project row menus below the trigger', async () => {
        // bb44bd45886 lists added Projects; a census checkout alone stays in From your sessions.
        organizationsMock = [{ key: { kind: 'project-organization', serverId, projectKey: 'wr_1' },
            revision: 1, value: { hidden: false } }];
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId,
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);

        await openFirstRowMenu(screen);
        const rowMenu = findRowMenu(screen);
        expect(rowMenu).toBeTruthy();
        expect(rowMenu?.props.placement).toBe('bottom');
        expect(rowMenu?.props.popoverAnchorAlign).toBe('end');
    });

    describe('workspace-sync row presentation', () => {
        const targetWorkspaceRef = (): WorkspaceRefV1 => ({
            id: 'wr_target',
            serverId,
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
            lastOpenedAtMs: null,
        });
        const contentPolicy = { v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [] } as const;
        const relationship: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: 'relationship-1', controllerMachineId: 'm2',
                alphaWorkspaceRefId: 'wr_source', betaWorkspaceRefId: 'wr_target', mode: 'keep_synced',
                contentPolicy: { ...contentPolicy, policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicy) },
                enabled: true, createdAtMs: 1, updatedAtMs: 1 };

        it('reports unavailable sync status without inventing a conflict in a closed project row', async () => {
            machinesMock = [createMachine({ id: 'm1', host: 'leeroy-mbp' })];
            workspaceRefsV1Mock = [{ id: 'wr_source', serverId,
                machineId: 'm2', rootPath: '/source', createdAtMs: 1 }, targetWorkspaceRef()];
            // The accepted source checkout has no reachable Machine; structural refs remain valid.
            relationships = [relationship];
            const { ProjectsListView } = await import('./ProjectsListView');
            const screen = await renderProjects(<ProjectsListView />);
            const subtitle = screen.findAllByTestId('projects-list-item-wr_target')
                .map((node) => node.props.subtitle)
                .find((value) => typeof value === 'string');
            expect(typeof subtitle).toBe('string');
            expect(subtitle).toContain('workspaceSync.attention.unavailableLinks');
            expect(subtitle).not.toContain('workspaceSync.attention.conflictedLinks');
        });

    });

    it('refreshes project row menu labels after the translation output changes', async () => {
        const workspaceRef = {
            id: 'wr_1',
            serverId,
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        };
        const { ProjectsListItemMenu } = await import('./ProjectsListItemMenu');
        const firstOnRemove = vi.fn();
        const screen = await renderScreen(
            <ProjectsListItemMenu
                workspaceRef={workspaceRef}
                pinAction="pin"
                onTogglePinned={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                onRemove={firstOnRemove}
            />,
        );

        // A closed row mounts only its trigger; the menu model exists while the menu is open.
        expect(findRowMenu(screen)).toBeUndefined();
        await openFirstRowMenu(screen);
        const englishDropdown = findRowMenu(screen);
        expect(englishDropdown).toBeTruthy();
        expect(englishDropdown?.props.items.find((item: { id: string; title: string }) => item.id === 'rename')?.title)
            .toBe('sessionsList.renameWorkspace');

        translationPrefixMock = 'es:';
        const secondOnRemove = vi.fn();
        await screen.update(
            <ProjectsListItemMenu
                workspaceRef={workspaceRef}
                pinAction="pin"
                onTogglePinned={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                onRemove={secondOnRemove}
            />,
        );
        const spanishDropdown = findRowMenu(screen);
        expect(spanishDropdown?.props.items.find((item: { id: string; title: string }) => item.id === 'rename')?.title)
            .toBe('es:sessionsList.renameWorkspace');
    });
});
