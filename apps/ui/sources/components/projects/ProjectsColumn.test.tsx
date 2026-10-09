import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());
const routeState = vi.hoisted(() => ({ pathname: '/projects' }));

let serverId: string;
let machinesMock: Machine[] = [];
let workspaceRefsV1Mock: WorkspaceRefV1[] = [];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        Platform: { OS: 'web' },
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
    return createTextModuleMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => routeState.pathname,
        router: {
            push: routerPushSpy,
        },
    }).module;
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

const { storage } = await import('@/sync/domains/state/storage');
const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');

beforeEach(async () => {
    await homes.reset();
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Projects Home', serverUrl: 'https://projects-column.test',
        accountId: 'account-1' });
    homes.answer(serverId, 'POST /v1/account/project-rows/list', { body: { status: 'listed', coverage: 'complete', rows: [] } });
    homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
    homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://projects-column.test')!.token! });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    await createDefaultActionExecutor().execute('projects.list', { serverId });
    storage.setState({ localSettings: { ...localSettingsDefaults } });
    storage.getState().clearProjectAccountRowsScope();
    routerPushSpy.mockClear();
});
afterEach(async () => {
    await standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    await homes.reset();
});

async function renderProjects(element: React.ReactElement) {
    storage.getState().applyMachines(machinesMock, true);
    const accountScope = storage.getState().profileScope;
    if (!accountScope) throw new Error('Project fixture has no connected Account');
    storage.getState().activateProjectAccountRowsScope(accountScope);
    homes.answer(serverId, 'POST /v1/account/project-rows/list', { body: createPlainProjectAccountRowListFixture({ workspaceRefs: workspaceRefsV1Mock }) });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const result = await createDefaultActionExecutor().execute('projects.list', { serverId });
    expect(result.ok).toBe(true);
    expect(storage.getState().projectAccountRows?.workspaceRefs.map(ref => ref.id), JSON.stringify({
        scope: storage.getState().profileScope, rows: storage.getState().projectAccountRows, result,
        requests: homes.requestsFor('/v1/account/project-rows/list'),
    })).toEqual(workspaceRefsV1Mock.map(ref => ref.id));
    return renderScreen(element);
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

function workspaceRef(id: string, machineId: string, rootPath: string): WorkspaceRefV1 {
    return { id, serverId, machineId, rootPath, createdAtMs: 1 };
}

describe('ProjectsColumn', () => {
    it('shows saved Sources as content without repeating a no-projects message', async () => {
        workspaceRefsV1Mock = [];
        homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, { body: {
            ok: true, sources: [{ id: 'saved', revision: 1, name: 'Saved repository', createdByAccountId: 'account-1', audience: [],
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' } }], coverage: { complete: true, nextCursor: null },
        } });
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);
        await vi.waitFor(() => expect(screen.findByTestId('projects-column:tree-saved-saved')).toBeTruthy());
        expect(screen.findByTestId('projects-column:empty')).toBeNull();
    });
    beforeEach(() => {
        standardCleanup();
        routeState.pathname = '/projects';
        machinesMock = [
            createMachine({ id: 'm1', host: 'studio' }),
            createMachine({ id: 'm2', host: 'laptop' }),
        ];
        workspaceRefsV1Mock = [
            workspaceRef('ref-a', 'm1', '/Users/tester/alpha'),
            workspaceRef('ref-b', 'm1', '/Users/tester/beta'),
            workspaceRef('ref-c', 'm2', '/Users/tester/gamma'),
        ];
        routerPushSpy.mockReset();
    });

    const rowIds = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root
        .findAll((node) => typeof node.type === 'string' || typeof node.type === 'function')
        .map((node) => node.props?.testID)
        .filter((testID): testID is string => typeof testID === 'string' && testID.startsWith('projects-column:tree-row-'))
        .filter((testID, index, all) => all.indexOf(testID) === index);

    it('draws each Project as one tree row, marks the open checkout, and folds a machine with several checkouts', async () => {
        routeState.pathname = '/projects/ref-b/code';
        workspaceRefsV1Mock = [
            { ...workspaceRef('ref-a', 'm1', '/Users/tester/alpha'), projectKey: 'alpha' },
            { ...workspaceRef('ref-b', 'm1', '/Users/tester/alpha-wt/fix'), projectKey: 'alpha' },
            workspaceRef('ref-c', 'm2', '/Users/tester/gamma'),
        ];
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);

        // alpha has two checkouts on one machine: the machine folds into the Project row, which opens
        // because it holds the open checkout; gamma is a single row.
        const alphaRowId = 'projects-column:tree-row-alpha/' + JSON.stringify([serverId, 'm1', '/Users/tester/alpha', 'ref-a']);
        const fixRowId = 'projects-column:tree-row-alpha/' + JSON.stringify([serverId, 'm1', '/Users/tester/alpha-wt/fix', 'ref-b']);
        expect(rowIds(screen)).toEqual([
            'projects-column:tree-row-alpha',
            alphaRowId,
            fixRowId,
            'projects-column:tree-row-ref-c',
        ]);
        expect(screen.findAllByTestId(fixRowId)[0]?.props.selected).toBe(true);
        expect(screen.findAllByTestId(alphaRowId)[0]?.props.selected).toBe(false);
    });

    it('opens the exact checkout from a leaf row', async () => {
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);
        await act(async () => {
            screen.findAllByTestId('projects-column:tree-row-ref-a')[0]?.props.onPress();
        });
        expect(routerPushSpy).toHaveBeenCalledWith(expect.stringContaining('/projects/ref-a'));
    });
});

describe('Projects index', () => {
    it('invites opening a saved Source without rendering a duplicate Add affordance below it', async () => {
        workspaceRefsV1Mock = [];
        homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, { body: {
            ok: true, sources: [{ id: 'saved', revision: 1, name: 'Saved repository', createdByAccountId: 'account-1', audience: [],
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' } }], coverage: { complete: true, nextCursor: null },
        } });
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const { ProjectsIndexView } = await import('./ProjectsIndexView');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const screen = await renderProjects(<AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}><ProjectsIndexView /></AppShellColumnContext.Provider>);
        await vi.waitFor(() => expect(screen.findByTestId('projects-none-open:open-source')).toBeTruthy());
        expect(screen.findByTestId('projects-none-open:add')).toBeNull();
        await act(async () => { await screen.findAllByType(RoundButton).find(node => node.props.testID === 'projects-none-open:open-source')!.props.action(); });
        // On a computer Open is the dialog over the page, addressed by its retained draft (never a pushed page).
        const { Modal } = await import('@/modal');
        const openings = () => [
            ...vi.mocked(Modal.show).mock.calls.map(([config]) => ({ dialog: config })),
            ...routerPushSpy.mock.calls.filter(([route]) => (route as { pathname?: string })?.pathname === '/projects/open').map(([route]) => ({ page: route })),
        ];
        await vi.waitFor(() => expect(openings().length).toBeGreaterThan(0));
        expect(openings()).toEqual([{ dialog: expect.objectContaining({
            chrome: expect.objectContaining({ testID: 'projects.open.dialog' }),
            props: { routeParams: expect.objectContaining({ draftId: expect.any(String) }) },
        }) }]);
    });
    beforeEach(() => {
        standardCleanup();
        machinesMock = [createMachine({ id: 'm1', host: 'studio' })];
        workspaceRefsV1Mock = [workspaceRef('ref-a', 'm1', '/Users/tester/alpha')];
    });

    it('does not repeat the list beside the Projects column: it says no project is open', async () => {
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const { ProjectsIndexView } = await import('./ProjectsIndexView');
        const beside = await renderProjects(
            <AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
                <ProjectsIndexView />
            </AppShellColumnContext.Provider>,
        );
        expect(beside.findByTestId('projects-none-open')).toBeTruthy();
        expect(beside.findByTestId('projects-list')).toBeNull();

        // Collapsed column, or a phone: the page is the list.
        const alone = await renderProjects(
            <AppShellColumnContext.Provider value={{ present: true, columnVisible: false }}>
                <ProjectsIndexView />
            </AppShellColumnContext.Provider>,
        );
        expect(alone.findByTestId('projects-list')).toBeTruthy();
        expect(alone.findByTestId('projects-none-open')).toBeNull();
    });
});
