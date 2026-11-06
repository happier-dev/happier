import * as React from 'react';
import { t } from '@/text';
import { act } from 'react-test-renderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ProjectOrganizationRow } from '@/sync/store/domains/projectAccountRows';
import type { ProjectMobileSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { buildProjectPaneScopeId } from './detail/projectPaneScope';
import { buildRealmQualifiedMobileSurfaceStorageKey } from '@/sync/domains/settings/mobileSurfacePersistence';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

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

vi.mock('react-native', async () => {
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
        useWindowDimensions: () => ({ width: deviceTypeMock === 'phone' ? 390 : 1024, height: 844, scale: 1, fontScale: 1 }),
        Dimensions: { get: () => ({ width: deviceTypeMock === 'phone' ? 390 : 1024, height: 844, scale: 1, fontScale: 1 }),
            addEventListener: () => ({ remove: () => {} }) },
    });
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
    getSessionDraftPersistenceStorage: () => ({ getString: (key: string) => draftRecords.get(key),
        set: (key: string, value: string) => draftRecords.set(key, value), delete: (key: string) => draftRecords.delete(key),
        flush: async () => {} }),
}));

const { storage } = await import('@/sync/domains/state/storage');
const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { appPaneReduce, createAppPaneState } = await import('@/components/appShell/panes/model/appPaneReducer');
const { serializeDetailsWorkspaceState } = await import('@/components/appShell/panes/details/workspace/migrateLegacyDetailsWorkspaceState');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

beforeEach(async () => {
    await homes.reset();
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Projects Home', serverUrl: 'https://projects-list.test',
        accountId: 'account-1' });
    homes.answer(serverId, 'POST /v1/account/project-rows/list', { body: { status: 'listed', coverage: 'complete', rows: [] } });
    homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
    homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://projects-list.test')!.token! });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    await createDefaultActionExecutor().execute('projects.list', { serverId });
    storage.getState().clearProjectAccountRowsScope();
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
async function renderProjects(element: React.ReactElement) {
    let panes = createAppPaneState({ maxScopesInMemory: 12 });
    for (const [scopeId, scope] of Object.entries(paneScopesMock)) {
        if (scope.right?.activeTabId) panes = appPaneReduce(panes, { type: 'openRight', scopeId, tabId: scope.right.activeTabId });
    }
    storage.setState({ localSettings: { ...localSettingsDefaults, ...localSettingsMock,
        projectLastMobileSurfaceByWorkspaceRefId: mobileSurfaces(),
        appPaneScopesV1: Object.fromEntries(Object.entries(panes.scopes).map(([id, scope]) => [id,
            { mainHidden: scope.mainHidden, right: scope.right, bottom: scope.bottom, details: serializeDetailsWorkspaceState(scope.details) }])) } });
    storage.getState().applyMachines(machinesMock, true);
    // A synced Account: its Machine inventory has arrived (even when it holds none of these Machines).
    storage.getState().applyReady();
    const accountScope = storage.getState().profileScope;
    if (!accountScope) throw new Error('Project fixture has no connected Account');
    storage.getState().activateProjectAccountRowsScope(accountScope);
    homes.answer(serverId, 'POST /v1/account/project-rows/list', { body: createPlainProjectAccountRowListFixture({
        workspaceRefs: workspaceRefsV1Mock, relationships, organizations: organizationsMock,
    }) });
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
        translationPrefixMock = '';
        folderSelection.path = null;
        relationships = [];
        routerPushSpy.mockReset();
        shownModals.length = 0;
        phoneRowRenders.clear();
    });

    it('PF3 renders only the changed phone row among 150 Projects on one checkout fact change', async () => {
        deviceTypeMock = 'phone';
        const nowMs = Date.now();
        machinesMock = [createMachine({ id: 'machine', host: 'Machine', activeAt: nowMs })];
        workspaceRefsV1Mock = Array.from({ length: 150 }, (_, index) => ({
            id: `ref-${index}`, serverId, machineId: 'machine', rootPath: `/repo-${index}`,
            projectKey: `project-${index}`, createdAtMs: 1,
        }));
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

    it('names the page with its large title in the phone tab shell, and leaves other hosts to their own head', async () => {
        const { PhoneTabNavRowProvider } = await import('@/components/navigation/shell/phoneTabNavRow');
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        const { ProjectsListView } = await import('./ProjectsListView');

        const inShell = await renderProjects(<PhoneTabNavRowProvider leading={null} trailing={null}><ProjectsListView /></PhoneTabNavRowProvider>);
        expect(inShell.findByType(PageHeader).props.title).toBe(t('tabs.projects'));

        const elsewhere = await renderProjects(<ProjectsListView />);
        expect(elsewhere.tree.root.findAllByType(PageHeader)).toHaveLength(0);
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
        expect(screen.findByTestId('projects-list:add-row')).toBeTruthy();
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

        expect(screen.findByTestId('projects-list:add-row')).toBeTruthy();
        const add = screen.findAllByType(DropdownMenu).find((menu) => menu.props.items?.some((item: { id: string }) => item.id === 'clone'));
        expect(add?.props.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(['clone', 'manage']));
    });

    it('opens Save as a source with no repository guess when the exact checkout has no hosting identity', async () => {
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

        const firstDropdown = screen.findAllByType(DropdownMenu)[0];
        expect(firstDropdown).toBeTruthy();
        const firstItems = firstDropdown?.props?.items;
        const firstOnSelect = firstDropdown?.props?.onSelect;

        projectLastMobileSurfacesByWorkspaceRefIdMock = { wr_1: 'git' };

        await act(async () => {
            storage.getState().applyLocalSettings({ projectLastMobileSurfaceByWorkspaceRefId: mobileSurfaces() }, { persist: false });
        });
        await screen.update(<AppPaneProvider><ProjectsListView /></AppPaneProvider>);

        const secondDropdown = screen.findAllByType(DropdownMenu)[0];
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
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/repo/.worktrees/feature-auth' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_feature' },
        };

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
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/repo/.worktrees/feature-auth' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_feature' },
        };
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
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/repo/.worktrees/feature-auth' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_feature' },
        };
        projectLastMobileSurfacesByWorkspaceRefIdMock = { wr_1: 'terminal' };

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderProjects(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-list-item-wr_1');

        expect(routerPushSpy).toHaveBeenCalledWith(`/projects/wr_1/overview?worktreeId=gitwt_feature&serverId=${encodeURIComponent(serverId)}&mobileSurface=terminal`);
    });

    it('anchors project row menus below the trigger', async () => {
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

        const dropdowns = screen.findAllByType(DropdownMenu);
        expect(dropdowns.length).toBeGreaterThan(0);
        expect(dropdowns[0]?.props.placement).toBe('bottom');
        expect(dropdowns[0]?.props.popoverAnchorAlign).toBe('end');
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
            workspaceRefsV1Mock = [targetWorkspaceRef(), { id: 'wr_source', serverId,
                machineId: 'm2', rootPath: '/source', createdAtMs: 1 }];
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

        const englishDropdown = screen.findAllByType(DropdownMenu)[0];
        expect(englishDropdown).toBeTruthy();
        expect(englishDropdown?.props.items.find((item: { id: string; title: string }) => item.id === 'rename')?.title)
            .toBe('sessionsList.renameWorkspace');

        translationPrefixMock = 'es:';
        const secondOnRemove = vi.fn();
        await act(async () => {
            screen.tree.update(
                <ProjectsListItemMenu
                    workspaceRef={workspaceRef}
                    pinAction="pin"
                    onTogglePinned={vi.fn()}
                    onRename={vi.fn()}
                    onReset={vi.fn()}
                    onRemove={secondOnRemove}
                />,
            );
        });

        const spanishDropdown = screen.findAllByType(DropdownMenu)[0];
        expect(spanishDropdown?.props.items.find((item: { id: string; title: string }) => item.id === 'rename')?.title)
            .toBe('es:sessionsList.renameWorkspace');
    });
});
