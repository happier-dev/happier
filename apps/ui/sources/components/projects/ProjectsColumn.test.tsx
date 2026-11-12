import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit';
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
const boundaryRowRenders = vi.hoisted(() => new Map<string, number>());

const rowMenuProbe = vi.hoisted(() => ({ mounts: 0, unmounts: 0, triggerRenders: 0 }));

let serverId: string;
let machinesMock: Machine[] = [];
let workspaceRefsV1Mock: WorkspaceRefV1[] = [];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode; testID?: string }) => {
            if (props.testID?.startsWith('projects-column:tree-row-')) {
                boundaryRowRenders.set(props.testID, (boundaryRowRenders.get(props.testID) ?? 0) + 1);
            }
            return React.createElement('Pressable', props, props.children);
        },
        Platform: { OS: 'web' },
    });
});

// Instrumentation only: the real DropdownMenu and RowActionRevealSlot render; the wrappers count row-menu
// mounts (a Projects row menu is the DropdownMenu that carries a `rename` item) and trigger renders.
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/forms/dropdown/DropdownMenu')>();
    return {
        ...actual,
        DropdownMenu: (props: React.ComponentProps<typeof actual.DropdownMenu>) => {
            const isRowMenu = React.useRef(props.items.some(item => item.id === 'rename')).current;
            React.useEffect(() => {
                if (!isRowMenu) return undefined;
                rowMenuProbe.mounts += 1;
                return () => { rowMenuProbe.unmounts += 1; };
            }, [isRowMenu]);
            return React.createElement(actual.DropdownMenu, props);
        },
    };
});
vi.mock('@/components/ui/lists/RowActionRevealSlot', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/lists/RowActionRevealSlot')>();
    return {
        ...actual,
        RowActionRevealSlot: (props: React.ComponentProps<typeof actual.RowActionRevealSlot>) => {
            rowMenuProbe.triggerRenders += 1;
            return React.createElement(actual.RowActionRevealSlot, props);
        },
    };
});

// The recycler is a third-party boundary: it builds only the rows its measured viewport reaches. `limit`
// stands in for that viewport (undefined: every row reaches it); the column's own logic stays real.
const legendWindow = vi.hoisted(() => ({ limit: undefined as number | undefined, state: null as null | { refHandle: { scrollToIndex: { mock: { calls: unknown[][] } } } } }));
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true, memoizeItems: true, get renderItemLimit() { return legendWindow.limit; } },
        (state) => { legendWindow.state = state as never; });
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

// Counting probe only: the real Projects model runs; the test counts how often a surface evaluates it.
const listModelRuns = vi.hoisted(() => ({ count: 0 }));
vi.mock('./useProjectsListModel', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./useProjectsListModel')>();
    return { ...actual, useProjectsListModel: () => { listModelRuns.count += 1; return actual.useProjectsListModel(); } };
});
const { storage } = await import('@/sync/domains/state/storage');
const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');

beforeEach(async () => {
    legendWindow.limit = undefined;
    boundaryRowRenders.clear();
    Object.assign(rowMenuProbe, { mounts: 0, unmounts: 0, triggerRenders: 0 });
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
    it('keeps 150 unchanged Project rows quiet when a refresh failure re-renders the real column', async () => {
        machinesMock = [createMachine({ id: 'machine', host: 'Machine', activeAt: Date.now() })];
        workspaceRefsV1Mock = Array.from({ length: 150 }, (_, index) => ({
            id: `ref-${index}`, serverId, machineId: 'machine', rootPath: `/repo-${index}`,
            projectKey: `project-${index}`, createdAtMs: 1,
        }));
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);
        expect(boundaryRowRenders.size).toBe(150);
        const originalMenu = screen.root.findAll(node => node.props.workspaceRef?.id === 'ref-27'
            && typeof node.props.onRename === 'function' && 'pinAction' in node.props)[0]!;
        const { onRename, workspaceRef: originalRef } = originalMenu.props;
        const renameFromMountedMenu = () => onRename(originalRef);
        boundaryRowRenders.clear();
        await act(async () => storage.getState().setProjectAccountRowsStatusForScope(storage.getState().profileScope!, 'error'));
        expect(screen.findByTestId('projects-column:stale')).not.toBeNull();
        expect([...boundaryRowRenders]).toEqual([]);

        const previousRefs = storage.getState().projectAccountRows!.workspaceRefs;
        const renamed = workspaceRefsV1Mock.map((ref, index) => index === 27 ? { ...ref, label: 'Renamed Project' } : ref);
        const response = createPlainProjectAccountRowListFixture({ workspaceRefs: renamed });
        if (response.status !== 'listed') throw new Error('expected a listed census fixture');
        for (const row of response.rows) {
            if (row.key.kind === 'workspace-ref' && row.key.id === 'ref-27') row.revision = 1;
        }
        homes.answer(serverId, 'POST /v1/account/project-rows/list', { body: response });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        await act(async () => {
            expect((await createDefaultActionExecutor().execute('projects.list', { serverId })).ok).toBe(true);
        });
        expect(storage.getState().projectAccountRows!.workspaceRefs.filter((ref, index) => ref !== previousRefs[index])).toHaveLength(1);
        expect(screen.findByTestId('projects-column:tree-row-project-27')!.findAll(node => node.props.children === 'Renamed Project').length).toBeGreaterThan(0);
        expect([...boundaryRowRenders]).toEqual([['projects-column:tree-row-project-27', 1]]);
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.prompt).mockClear();
        await act(async () => { await renameFromMountedMenu(); });
        expect(Modal.prompt).toHaveBeenLastCalledWith(expect.any(String), undefined,
            expect.objectContaining({ defaultValue: 'Renamed Project' }));
        boundaryRowRenders.clear();
        const menusFor = (id: string) => screen.root.findAll(node => node.props.workspaceRef?.id === id
            && typeof node.props.onTogglePinned === 'function' && 'pinAction' in node.props);
        expect(menusFor('ref-27').some(menu => menu.props.pinAction === 'pin')).toBe(true);
        await act(async () => storage.setState({ pinnedWorkspaceRefIds: ['ref-27'] }));
        expect(menusFor('ref-27').every(menu => menu.props.pinAction === 'unpin')).toBe(true);
        expect(menusFor('ref-28').every(menu => menu.props.pinAction === 'pin')).toBe(true);
        expect([...boundaryRowRenders]).toEqual([]);
        await act(async () => storage.setState({ pinnedWorkspaceRefIds: [] }));
        expect(menusFor('ref-27').every(menu => menu.props.pinAction === 'pin')).toBe(true);
        expect([...boundaryRowRenders]).toEqual([]);
    });

    it('builds only the Project rows its viewport reaches when the column opens over 150 Projects', async () => {
        machinesMock = [createMachine({ id: 'machine', host: 'Machine', activeAt: Date.now() })];
        workspaceRefsV1Mock = Array.from({ length: 150 }, (_, index) => ({
            id: `ref-${index}`, serverId, machineId: 'machine', rootPath: `/repo-${index}`,
            projectKey: `project-${index}`, createdAtMs: 1,
        }));
        legendWindow.limit = 20;
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);
        // Opening the column mounts the rows in view, not one row per Project.
        expect(boundaryRowRenders.size).toBe(20);
        // Each built row says where it stands in the whole tree, not among the rows the window built.
        const positions = [...boundaryRowRenders.keys()].map(id => {
            const row = screen.root.findAll(node => node.props.testID === id && node.props.accessibilityLevel !== undefined)[0]!;
            return [row.props.accessibilityLevel, row.props.accessibilitySetSize, row.props.accessibilityPositionInSet];
        });
        expect(positions).toEqual(Array.from({ length: 20 }, (_, index) => [1, 150, index + 1]));
        // The column's own entries and state lines are not tree items: they stand beside the tree, not in it.
        const head = screen.findByTestId('projects-column:tree:head');
        expect(head).not.toBeNull();
        expect(screen.findByTestId('projects-column:tree')!.findAll(node => node === head)).toHaveLength(0);
        // The keyboard still walks the whole tree: moving past the last built row scrolls the list to it.
        const lastBuilt = [...boundaryRowRenders.keys()].at(-1)!;
        const last = screen.findByTestId(lastBuilt)!.findAll(node => typeof node.props.onKeyDown === 'function')[0]!;
        await act(async () => { last.props.onKeyDown({ key: 'ArrowDown', nativeEvent: { key: 'ArrowDown' }, preventDefault: () => {} }); });
        expect(legendWindow.state!.refHandle.scrollToIndex.mock.calls.at(-1)?.[0]).toMatchObject({ index: 20 });
    });

    it('mounts a row menu only when it is opened, and re-renders only the row whose pin state changed', async () => {
        machinesMock = [createMachine({ id: 'machine', host: 'Machine', activeAt: Date.now() })];
        workspaceRefsV1Mock = Array.from({ length: 40 }, (_, index) => ({
            id: `ref-${index}`, serverId, machineId: 'machine', rootPath: `/repo-${index}`,
            projectKey: `project-${index}`, createdAtMs: 1,
        }));
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);
        const triggers = () => screen.root.findAll(node => node.props.accessibilityLabel === 'common.moreActions'
            && typeof node.props.onPress === 'function' && typeof node.type === 'function');
        expect(triggers().length).toBeGreaterThanOrEqual(40);
        expect(rowMenuProbe.triggerRenders).toBeGreaterThanOrEqual(40);
        expect(rowMenuProbe.mounts).toBe(0);

        rowMenuProbe.triggerRenders = 0;
        await act(async () => storage.setState({ sessionListRowsByServerId: { [serverId]: {} } }));
        expect(rowMenuProbe.triggerRenders).toBe(0);
        await act(async () => storage.setState({ pinnedWorkspaceRefIds: ['ref-27'] }));
        expect(rowMenuProbe.triggerRenders).toBe(1);
        expect(rowMenuProbe.mounts).toBe(0);

        const openRow = screen.root.findAll(node => node.props.workspaceRef?.id === 'ref-27' && 'pinAction' in node.props)[0]!;
        const trigger = openRow.findAll(node => node.props.accessibilityLabel === 'common.moreActions' && typeof node.props.onPress === 'function')[0]!;
        await act(async () => trigger.props.onPress({}));
        expect(rowMenuProbe.mounts).toBe(1);
        const menu = screen.root.findAll(node => Array.isArray(node.props.items) && node.props.items.some((item: { id: string }) => item.id === 'rename'))[0]!;
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual(['new-session', 'save-source', 'unpin', 'browse-store', 'rename', 'reset', 'hide', 'remove']);
    });

    it('PF3 keeps the production column quiet for five unrelated Session arrivals with 150 Projects', async () => {
        machinesMock = [createMachine({ id: 'machine', host: 'Machine', activeAt: Date.now() })];
        workspaceRefsV1Mock = Array.from({ length: 150 }, (_, index) => ({
            id: `ref-${index}`, serverId, machineId: 'machine', rootPath: `/repo-${index}`,
            projectKey: `project-${index}`, createdAtMs: 1,
        }));
        const { ProjectsColumn } = await import('./ProjectsColumn');
        let commits = 0;
        const screen = await renderProjects(<React.Profiler id="projects-column" onRender={() => { commits += 1; }}>
            <ProjectsColumn />
        </React.Profiler>);
        expect(screen.findByTestId('projects-column:tree-row-project-149')).not.toBeNull();
        commits = 0;
        for (let index = 0; index < 5; index += 1) {
            const row = createSessionListRenderableSessionFixture({ id: 'unrelated', active: true,
                activeAt: Date.now(), thinking: Boolean(index % 2),
                metadata: { machineId: 'machine', path: '/outside-the-tree' } });
            await act(async () => storage.setState({ sessionListRowsByServerId: { [serverId]: { unrelated: row } },
                sessionListRenderableDelta: { revision: index + 1, changedSessionIds: ['unrelated'], removedSessionIds: [], rebuiltSessionListIndex: false } }));
        }
        expect(commits).toBe(0);
    });

    it('does not call a Source "not open" until the Project rows have loaded', async () => {
        // While the census is still loading, every Source would look unopened; the saved group waits with the tree.
        workspaceRefsV1Mock = [];
        homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, { body: {
            ok: true, sources: [{ id: 'saved', revision: 1, name: 'Saved repository', createdByAccountId: 'account-1', audience: [],
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' } }], coverage: { complete: true, nextCursor: null },
        } });
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);
        await vi.waitFor(() => expect(screen.findByTestId('projects-column:tree-saved-saved')).toBeTruthy());
        await act(async () => { storage.getState().setProjectAccountRowsStatusForScope(storage.getState().profileScope!, 'loading'); });
        expect(screen.findByTestId('projects-column:tree-saved-saved')).toBeNull();
    });

    // F4 (WHOLE-PAGE-ACCEPT-1112): the page beside the column says "no projects yet" with its Add; the column stays quiet.
    it('leaves "no projects yet" to the page beside it when there are no Projects and nothing saved', async () => {
        workspaceRefsV1Mock = [];
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);
        await vi.waitFor(() => expect(screen.findByTestId('projects-column:add')).toBeTruthy());
        expect(screen.findByTestId('projects-column:empty')).toBeNull();
    });

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

    // F4 (WHOLE-PAGE-ACCEPT-1112, owner 1538 #01): the column finds a Project from its title row, as the phone page does.
    it('keeps a magnifier on the title row that narrows the tree to matching Projects', async () => {
        routeState.pathname = '/projects';
        workspaceRefsV1Mock = [
            { ...workspaceRef('ref-a', 'm1', '/Users/tester/alpha'), projectKey: 'alpha' },
            workspaceRef('ref-c', 'm2', '/Users/tester/gamma'),
        ];
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);
        expect(rowIds(screen)).toEqual(['projects-column:tree-row-alpha', 'projects-column:tree-row-ref-c']);
        await act(async () => { screen.findAllByTestId('projects-column:search:toggle')[0]!.props.onPress(); });
        const field = screen.findAllByTestId('projects-column:search')[0]!;
        await act(async () => { field.props.onChangeText('gam'); });
        expect(rowIds(screen)).toEqual(['projects-column:tree-row-ref-c']);
    });

    it('waits quietly while the Project rows load and offers Retry on one line when the read failed', async () => {
        machinesMock = [];
        storage.getState().applyMachines(machinesMock, true);
        const accountScope = storage.getState().profileScope!;
        storage.getState().activateProjectAccountRowsScope(accountScope);
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderScreen(<ProjectsColumn />);
        // Loading: the collection's quiet rows, no card and nothing to press.
        expect(screen.findAllByTestId('projects-column:rows')).toHaveLength(0);
        expect(screen.findAllByTestId('projects-column:rows-retry')).toHaveLength(0);
        await act(async () => { storage.getState().setProjectAccountRowsStatusForScope(accountScope, 'error'); });
        expect(screen.findAllByTestId('projects-column:rows-retry').length).toBeGreaterThan(0);
    });

    it('keeps the cached tree under a stale line when a refresh fails, and Retry reads the census again', async () => {
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);
        const accountScope = storage.getState().profileScope!;
        expect(screen.findAllByTestId('projects-column:stale')).toHaveLength(0);
        await act(async () => { storage.getState().setProjectAccountRowsStatusForScope(accountScope, 'error'); });
        // Rows stay at full strength; the line says they may be old and offers the one Retry.
        expect(rowIds(screen)).toContain('projects-column:tree-row-ref-a');
        expect(screen.findAllByTestId('projects-column:stale').length).toBeGreaterThan(0);
        const reads = () => homes.requestsFor('/v1/account/project-rows/list').length;
        const before = reads();
        await act(async () => { screen.findAllByTestId('projects-column:stale-retry')[0]?.props.onPress(); });
        await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
        await vi.waitFor(() => expect(screen.findAllByTestId('projects-column:stale')).toHaveLength(0));
        expect(rowIds(screen)).toContain('projects-column:tree-row-ref-a');
    });

    it('waits for the Machines before naming any row, never calling a Machine unlisted while they load', async () => {
        machinesMock = [createMachine({ id: 'm1', host: 'studio' })];
        workspaceRefsV1Mock = [workspaceRef('ref-a', 'm1', '/Users/tester/alpha')];
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);
        // A first load: the rows are known, the Machine inventory has not arrived yet.
        await act(async () => { storage.setState({ isDataReady: false }); storage.getState().applyMachines([], true); });
        // The column waits quietly instead of calling every Machine unlisted.
        expect(screen.findAllByTestId('projects-column:tree-row-ref-a')).toHaveLength(0);
        await act(async () => { storage.getState().applyMachines(machinesMock, true); });
        expect(String(screen.findAllByTestId('projects-column:tree-row-ref-a')[0]?.props.subtitle ?? '')).toMatch(/^studio · /);
    });

    it('names each row\'s Machine through the machine-name owner, never by its raw id', async () => {
        machinesMock = [createMachine({ id: 'm1', host: 'studio' }), createMachine({ id: 'm2', host: 'studio' })];
        workspaceRefsV1Mock = [workspaceRef('ref-a', 'm1', '/Users/tester/alpha'), workspaceRef('ref-x', 'retired-machine', '/Users/tester/x')];
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<ProjectsColumn />);
        const subtitle = (id: string) => String(screen.findAllByTestId(id)[0]?.props.subtitle ?? '');
        // Same-named Machines carry the pickers' suffix; one this Home no longer lists says so.
        expect(subtitle('projects-column:tree-row-ref-a')).toMatch(/^studio · m1 · /);
        expect(subtitle('projects-column:tree-row-ref-x')).toMatch(/^machine\.unlistedMachine · /);
        expect(subtitle('projects-column:tree-row-ref-x')).not.toContain('retired-machine');
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

    it('leads with the same Add as the column once Projects exist, even with a saved Source', async () => {
        homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, { body: {
            ok: true, sources: [{ id: 'saved', revision: 1, name: 'Saved repository', createdByAccountId: 'account-1', audience: [],
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' } }], coverage: { complete: true, nextCursor: null },
        } });
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const { ProjectsIndexView } = await import('./ProjectsIndexView');
        const { ProjectsColumn } = await import('./ProjectsColumn');
        const screen = await renderProjects(<AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
            <ProjectsColumn /><ProjectsIndexView /></AppShellColumnContext.Provider>);
        // The saved Source has arrived (the column lists it under "Saved, not open")…
        await vi.waitFor(() => expect(screen.findByTestId('projects-column:tree-saved')).toBeTruthy());
        // …and the page still offers the column's Add, not that Source.
        expect(screen.findByTestId('projects-none-open:add')).toBeTruthy();
        expect(screen.findByTestId('projects-none-open:open-source')).toBeNull();
    });

    it('stops the retained index model while its workspace tab is not presented and catches up when shown', async () => {
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { ProjectsIndexView } = await import('./ProjectsIndexView');
        let setPresented: (presented: boolean) => void = () => {};
        function RetainedTab() {
            const [presented, set] = React.useState(true);
            setPresented = set;
            return <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
                <AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}><ProjectsIndexView /></AppShellColumnContext.Provider>
            </PluginSurfaceFocusEligibilityProvider>;
        }
        const screen = await renderProjects(<RetainedTab />);
        expect(screen.findByTestId('projects-none-open')).toBeTruthy();
        await act(async () => { setPresented(false); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        const before = listModelRuns.count;
        for (let index = 1; index <= 3; index += 1) {
            await act(async () => {
                storage.getState().applyMachines(machinesMock.map(machine => ({ ...machine,
                    metadata: { ...machine.metadata!, homeDir: `/Users/moved-${index}` }, metadataVersion: (machine.metadataVersion ?? 0) + index })), false);
            });
        }
        expect(listModelRuns.count - before).toBe(0);
        await act(async () => { setPresented(true); });
        expect(listModelRuns.count - before).toBeGreaterThan(0);
        expect(screen.findByTestId('projects-none-open')).toBeTruthy();
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
