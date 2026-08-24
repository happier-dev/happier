import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createPartialStorageModuleMock,
    findGestureByKind,
    invokeTestInstanceHandler,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import type { SessionOrganizationProjection } from '@/sync/domains/session/organization/types';
import { driveSessionListDragGesture } from './__tests__/driveSessionListDragGesture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setSessionListGroupOrderV1 = vi.fn();
const setCollapsedGroupKeysV1 = vi.fn();
const setSessionFolderViewModeV1 = vi.fn();
const setSessionListFolderSortModeV1 = vi.fn();
const setSessionListOrderingModeV1 = vi.fn();
const setSessionFoldersV1 = vi.fn();
const setSessionTagsV1 = vi.fn();
const setSessionListFocusedFolderV1 = vi.fn();
const modalPromptSpy = vi.hoisted(() => vi.fn(async () => null as string | null));
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => false));
const modalShowSpy = vi.hoisted(() => vi.fn((_config: unknown) => 'move-sheet-modal'));
const modalHideSpy = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlSpy = vi.hoisted(() => vi.fn(async () => ({ accessToken: 'token-a' })));
const serverProfileState = vi.hoisted(() => ({
    activeServerId: 'server_a',
    profileId: 'server_a',
}));
const getServerProfileByIdSpy = vi.hoisted(() => vi.fn((serverId: string) => (
    serverId === serverProfileState.activeServerId || serverId === serverProfileState.profileId
)
    ? { id: serverProfileState.profileId, serverIdentityId: serverProfileState.activeServerId, serverUrl: 'https://server-a.test' }
    : null));
const setSessionFolderAssignmentSpy = vi.hoisted(() => vi.fn(async () => undefined));
const moveSessionFolderAssignmentsSpy = vi.hoisted(() => vi.fn(async () => undefined));
const reorderSessionOrganizationSpy = vi.hoisted(() => vi.fn(async () => undefined));
const upsertSessionFolderSpy = vi.hoisted(() => vi.fn(async () => undefined));
const deleteSessionFolderSpy = vi.hoisted(() => vi.fn(async () => undefined));
const routerPushSpy = vi.hoisted(() => vi.fn());

let sessionFolderViewModeV1: 'off' | 'tree' = 'tree';
let sessionListFolderSortModeV1: 'foldersFirst' | 'mixed' = 'foldersFirst';
let sessionListOrderingModeV1: 'custom' | 'created' | 'updated' = 'custom';
let sessionFoldersV1: any = { v: 1, folders: [] };
let sessionListFocusedFolderV1: any = null;
let collapsedGroupKeysV1: Record<string, boolean> = {};
let mockVisibleSessionListViewData: any[] = [];

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (value: any) => value.web ?? value.default },
            FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ...rest }: any) =>
                React.createElement(
                    'FlatList',
                    { ...rest },
                    ListHeaderComponent ? React.createElement(ListHeaderComponent) : null,
                    (data ?? []).map((item: any, index: number) => {
                        const key = keyExtractor ? keyExtractor(item, index) : String(index);
                        return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
                    }),
                    ListFooterComponent ? React.createElement(ListFooterComponent) : null,
                ),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '', router: { push: routerPushSpy, replace: vi.fn(), back: vi.fn() } }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: modalShowSpy as any,
                hide: modalHideSpy as any,
                prompt: modalPromptSpy as any,
                confirm: modalConfirmSpy as any,
            },
        }).module;
    },
    storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => [],
        useProfile: () => ({ id: 'profile-1' }),
        useSetting: (key: string) => {
            if (key === 'hideInactiveSessions') return false;
            if (key === 'sessionTagsEnabled') return false;
            if (key === 'sessionListDensity') return 'default';
            if (key === 'rememberLastProjectSessionSelections') return false;
            if (key === 'sessionFolderViewModeV1') return sessionFolderViewModeV1;
            if (key === 'sessionFoldersV1') return sessionFoldersV1;
            if (key === 'sessionListOrderingModeV1') return sessionListOrderingModeV1;
            if (key === 'sessionListSectionModeV1') return 'activity';
            return null;
        },
        useSessionOrganizationProjection: () => buildOrganizationProjectionFromFolders(sessionFoldersV1),
        useSettingMutable: (key: string) => {
            if (key === 'sessionListGroupOrderV1') return [{}, setSessionListGroupOrderV1];
            if (key === 'collapsedGroupKeysV1') throw new Error('collapsedGroupKeysV1 must stay in local settings');
            if (key === 'sessionFolderViewModeV1') return [sessionFolderViewModeV1, setSessionFolderViewModeV1];
            if (key === 'sessionFoldersV1') return [sessionFoldersV1, setSessionFoldersV1];
            if (key === 'sessionTagsV1') return [{}, setSessionTagsV1];
            if (key === 'pinnedSessionKeysV1') return [[], vi.fn()];
            if (key === 'sessionListOrderingModeV1') return [sessionListOrderingModeV1, setSessionListOrderingModeV1];
            if (key === 'workspaceLabelsV1') return [{}, vi.fn()];
            return [null, vi.fn()];
        },
        useLocalSettingMutable: (key: string) => {
            if (key === 'sessionListFocusedFolderV1') {
                const [focusedFolder, setFocusedFolder] = React.useState(sessionListFocusedFolderV1);
                return [
                    focusedFolder,
                    (nextFocusedFolder: typeof sessionListFocusedFolderV1) => {
                        sessionListFocusedFolderV1 = nextFocusedFolder;
                        setSessionListFocusedFolderV1(nextFocusedFolder);
                        setFocusedFolder(nextFocusedFolder);
                    },
                ];
            }
            if (key === 'sessionListFolderSortModeV1') {
                return [sessionListFolderSortModeV1, setSessionListFolderSortModeV1];
            }
            if (key === 'collapsedGroupKeysV1') {
                return [collapsedGroupKeysV1, setCollapsedGroupKeysV1];
            }
            return [[], vi.fn()];
        },
    }),
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args),
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaInsetsContext: React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        enabled: true,
        presentation: 'grouped',
        activeServerId: serverProfileState.activeServerId,
        allowedServerIds: [serverProfileState.activeServerId],
    }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => mockVisibleSessionListViewData,
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: getCredentialsForServerUrlSpy,
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    resolveServerProfileScopeId: (profile: { id: string; serverIdentityId?: string | null }) => (
        profile.serverIdentityId ?? profile.id
    ),
    areServerProfileIdentifiersEquivalent: (left: string | null | undefined, right: string | null | undefined) => left === right,
    getServerProfileById: getServerProfileByIdSpy,
    // `serverRuntime.getActiveServerSnapshot` re-exports this; the session-list
    // memory-search augmentation reads it during render.
    getActiveServerSnapshot: () => ({
        serverId: serverProfileState.activeServerId,
        serverUrl: 'https://server-a.example',
        generation: 0,
    }),
}));

vi.mock('@/sync/ops/sessionOrganization', () => ({
    deleteSessionFolder: deleteSessionFolderSpy,
    setSessionFolderAssignment: setSessionFolderAssignmentSpy,
    moveSessionFolderAssignments: moveSessionFolderAssignmentsSpy,
    reorderSessionOrganization: reorderSessionOrganizationSpy,
    setSessionPin: vi.fn(async () => undefined),
    setSessionTagLabels: vi.fn(async () => undefined),
    upsertSessionFolder: upsertSessionFolderSpy,
}));

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: 'UpdateBanner',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        'DropdownMenu',
        props,
        typeof props.trigger === 'function'
            ? props.trigger({
                open: props.open,
                toggle: vi.fn(),
                openMenu: vi.fn(),
                closeMenu: vi.fn(),
                selectedItem: null,
            })
            : props.trigger ?? null,
    ),
}));

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', {
        ...props,
        testID: `session-list-session:${String(props.session?.id ?? 'unknown')}`,
    }),
}));

const workspace = { t: 'workspaceScope', serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' };
const otherWorkspace = { t: 'workspaceScope', serverId: 'server_a', machineId: 'machine_b', rootPath: '/elsewhere' };
const projectGroupKey = 'server:server_a:active:project:project_a';
const folderGroupKey = `${projectGroupKey}:folder:folder_a`;
const sessionA = { id: 'sess_a', createdAt: 1, active: true, presence: 'online', metadata: null };
const sessionB = { id: 'sess_b', createdAt: 2, active: true, presence: 'online', metadata: null };

function buildOrganizationProjectionFromFolders(folders: typeof sessionFoldersV1): SessionOrganizationProjection {
    const foldersById = Object.fromEntries((folders.folders ?? []).map((folder: any) => [
        folder.id,
        {
            folderId: folder.id,
            folderKey: folder.id,
            parentFolderId: folder.parentId ?? null,
            parentFolderKey: folder.parentId ?? null,
            sortKey: folder.sortKey ?? null,
            display: {
                t: 'plain' as const,
                v: {
                    name: folder.name,
                    workspace: folder.workspace,
                },
            },
            archivedAt: null,
            createdAt: folder.createdAt ?? 1,
            updatedAt: folder.updatedAt ?? 1,
        },
    ]));
    return {
        schemaVersion: 1,
        version: 1,
        pinnedSessionIds: [],
        pinsBySessionId: {},
        foldersById,
        folderAssignmentsBySessionId: foldersById.folder_a ? { sess_a: 'folder_a' } : {},
        tagsById: {},
        tagAssignmentsBySessionId: {},
        attentionStandingsBySessionId: {},
        orderEntriesByScopeKey: {},
        labelsByLabelKey: {},
    };
}

function resetFolderData() {
    mockVisibleSessionListViewData = [
        { type: 'header', title: 'Active', headerKind: 'active', groupKey: 'active', serverId: 'server_a' },
        {
            type: 'header',
            title: '~/repo',
            headerKind: 'project',
            groupKey: projectGroupKey,
            workspaceKey: 'project_a',
            workspaceScopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
            serverId: 'server_a',
        },
        {
            type: 'header',
            title: 'Planning',
            headerKind: 'folder',
            groupKey: folderGroupKey,
            workspace,
            renderWorkspaceKey: 'project_a',
            folderId: 'folder_a',
            parentFolderId: null,
            depth: 1,
            sessionCount: 47,
            serverId: 'server_a',
        },
        {
            type: 'session',
            session: sessionA,
            groupKey: folderGroupKey,
            groupKind: 'folder',
            folderId: 'folder_a',
            folderDepth: 1,
            serverId: 'server_a',
        },
        {
            type: 'session',
            session: sessionB,
            groupKey: projectGroupKey,
            groupKind: 'project',
            folderId: null,
            folderDepth: 0,
            serverId: 'server_a',
        },
    ];
}

function resetProjectDataWithoutFolders() {
    mockVisibleSessionListViewData = [
        { type: 'header', title: 'Active', headerKind: 'active', groupKey: 'active', serverId: 'server_a' },
        {
            type: 'header',
            title: '~/repo',
            headerKind: 'project',
            groupKey: projectGroupKey,
            workspaceKey: 'project_a',
            workspaceScopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
            serverId: 'server_a',
        },
        {
            type: 'session',
            session: sessionA,
            groupKey: projectGroupKey,
            groupKind: 'project',
            folderId: null,
            folderDepth: 0,
            serverId: 'server_a',
        },
        {
            type: 'session',
            session: sessionB,
            groupKey: projectGroupKey,
            groupKind: 'project',
            folderId: null,
            folderDepth: 0,
            serverId: 'server_a',
        },
    ];
}

async function renderSessionsList() {
    const { SessionsList } = await import('./SessionsList');
    return renderScreen(<SessionsList />);
}

async function renderSessionsListWithSurfaceOwnership(surfaceOwnership: Readonly<{
    ownerKey?: string;
    visible?: boolean;
    interactive: boolean;
    dataActive: boolean;
}>) {
    const { SessionsList } = await import('./SessionsList');
    return renderScreen(<SessionsList surfaceOwnership={surfaceOwnership} />);
}

function findSessionGesture(
    screen: Awaited<ReturnType<typeof renderSessionsList>>,
    sessionId: string,
) {
    const row = screen.findByTestId(`session-list-session:${sessionId}`);
    expect(row, `expected ${sessionId} session row`).toBeTruthy();
    const gesture = row?.props.reorderHandleGesture;
    expect(findGestureByKind(gesture, 'pan')).toBeTruthy();
    return gesture;
}

function findFolderGesture(screen: Awaited<ReturnType<typeof renderSessionsList>>) {
    const detector = screen.root.findAllByType('GestureDetector' as React.ElementType)
        .find((node) => findGestureByKind(node.props.gesture, 'pan'));
    expect(detector, 'expected folder GestureDetector').toBeTruthy();
    return detector?.props.gesture;
}

describe('SessionsList session folders shell', () => {
    beforeEach(() => {
        sessionFolderViewModeV1 = 'tree';
        sessionListFolderSortModeV1 = 'foldersFirst';
        sessionListOrderingModeV1 = 'custom';
        sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'folder_a',
                workspace,
                renderWorkspaceKey: 'project_a',
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        sessionListFocusedFolderV1 = null;
        collapsedGroupKeysV1 = {};
        setSessionListGroupOrderV1.mockClear();
        setCollapsedGroupKeysV1.mockClear();
        setSessionFolderViewModeV1.mockClear();
        setSessionListFolderSortModeV1.mockClear();
        setSessionListOrderingModeV1.mockClear();
        setSessionFoldersV1.mockClear();
        setSessionTagsV1.mockClear();
        setSessionListFocusedFolderV1.mockClear();
        serverProfileState.activeServerId = 'server_a';
        serverProfileState.profileId = 'server_a';
        modalPromptSpy.mockReset();
        modalPromptSpy.mockResolvedValue(null);
        modalConfirmSpy.mockReset();
        modalConfirmSpy.mockResolvedValue(false);
        modalShowSpy.mockReset();
        modalShowSpy.mockReturnValue('move-sheet-modal');
        modalHideSpy.mockReset();
        getCredentialsForServerUrlSpy.mockClear();
        getServerProfileByIdSpy.mockClear();
        setSessionFolderAssignmentSpy.mockClear();
        moveSessionFolderAssignmentsSpy.mockClear();
        reorderSessionOrganizationSpy.mockClear();
        upsertSessionFolderSpy.mockClear();
        deleteSessionFolderSpy.mockClear();
        routerPushSpy.mockClear();
        resetFolderData();
        standardCleanup();
    });

    it('renders folder headers with stable e2e ids', async () => {
        const screen = await renderSessionsList();

        expect(screen.findByTestId('session-folder-header-folder_a')).toBeTruthy();
        expect(screen.findByTestId('session-folder-reorder-handle-folder_a')).toBeTruthy();
        expect(screen.findByTestId('session-folder-menu-trigger-folder_a')).toBeTruthy();
        // The drop indicator is the single list-level SessionListDropOverlay;
        // folder headers no longer render a row-local drop-target outline.
        expect(screen.findByTestId('session-list-drop-overlay')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('47');
    });

    it('starts a folder-scoped session with a fresh explicit draft identity', async () => {
        const screen = await renderSessionsList();
        const folderMenu = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((menu) => menu.props.items?.some((item: { id?: string }) => item.id === 'new-session'));
        expect(folderMenu).toBeTruthy();

        await act(async () => {
            await folderMenu?.props.onSelect('new-session');
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
                machineId: 'machine_a',
                directory: '/repo',
                spawnServerId: 'server_a',
            },
        });
    });

    it('shows a workspace reorder handle with the project header hover actions', async () => {
        const screen = await renderSessionsList();

        const header = screen.findByTestId(`session-list-project-header:${projectGroupKey}`);
        expect(header).toBeTruthy();
        expect(screen.findByTestId(`session-workspace-reorder-handle:${projectGroupKey}`)).toBeNull();

        await act(async () => {
            invokeTestInstanceHandler(header, 'onHoverIn', undefined, 'expected project header');
        });

        const handle = screen.findByTestId(`session-workspace-reorder-handle:${projectGroupKey}`);
        expect(handle).toBeTruthy();
        expect(typeof handle?.props.onHoverIn).toBe('function');
        expect(typeof handle?.props.onHoverOut).toBe('function');

        await act(async () => {
            invokeTestInstanceHandler(handle, 'onHoverIn', undefined, 'expected workspace reorder handle');
            invokeTestInstanceHandler(header, 'onHoverOut', undefined, 'expected project header');
        });

        expect(screen.findByTestId(`session-workspace-reorder-handle:${projectGroupKey}`)).toBeTruthy();
    });

    it('attaches the folder drag gesture on web', async () => {
        const screen = await renderSessionsList();

        expect(findGestureByKind(findFolderGesture(screen), 'pan')).toBeTruthy();
    });

    it('persists focused folder requests', async () => {
        const screen = await renderSessionsList();

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('session-folder-header-folder_a'),
                'onPress',
                undefined,
                'expected folder header',
            );
        });

        expect(setSessionListFocusedFolderV1).toHaveBeenCalledWith({
            folderId: 'folder_a',
            workspace,
            renderWorkspaceKey: 'project_a',
            serverId: 'server_a',
        });
    });

    it('restores focused folder state from local settings', async () => {
        sessionListFocusedFolderV1 = {
            folderId: 'folder_a',
            workspace,
            renderWorkspaceKey: 'project_a',
            serverId: 'server_a',
        };

        const screen = await renderSessionsList();

        expect(screen.findByTestId('session-folder-breadcrumb')).toBeTruthy();
        expect(screen.findByTestId('session-list-session:sess_a')).toBeTruthy();
        expect(screen.findByTestId('session-list-session:sess_b')).toBeNull();
    });

    it('does not clear stale focused folder state while the sessions surface is not data-active', async () => {
        sessionListFocusedFolderV1 = {
            folderId: 'missing-folder',
            workspace,
            renderWorkspaceKey: 'project_a',
            serverId: 'server_a',
        };

        await renderSessionsListWithSurfaceOwnership({
            ownerKey: 'phone-root',
            visible: false,
            interactive: false,
            dataActive: false,
        });

        expect(setSessionListFocusedFolderV1).not.toHaveBeenCalledWith(null);
    });

    it('renders the view menu with a folder view toggle on primary section headers', async () => {
        const screen = await renderSessionsList();

        const menu = screen.findByTestId('session-list-ordering-menu-trigger');
        expect(menu).toBeTruthy();
        const dropdown = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((node) => node.props?.items?.some((item: any) => item.testID === 'session-folder-view-toggle'));

        expect(dropdown).toBeTruthy();
        expect(dropdown?.props.selectedId).toBe('folder-view-tree');

        dropdown?.props.onSelect('folder-view-off');
        expect(setSessionFolderViewModeV1).toHaveBeenCalledWith('off');
    });

    it('persists folder sort mode selections from the view menu', async () => {
        const screen = await renderSessionsList();
        const dropdown = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((node) => node.props?.items?.some((item: any) => item.id === 'session-folder-sort-mode:mixed'));
        const sortModeItems = dropdown?.props.items.filter((item: any) => String(item.id).startsWith('session-folder-sort-mode:')) ?? [];

        expect(sortModeItems).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'session-folder-sort-mode:mixed', category: 'sessionsList.folderSortMode' }),
            expect.objectContaining({ id: 'session-folder-sort-mode:foldersFirst', category: 'sessionsList.folderSortMode' }),
        ]));
        expect(sortModeItems.every((item: any) => item.submenu == null)).toBe(true);
        expect(dropdown?.props.showCategoryTitles).toBe(true);

        dropdown?.props.onSelect('session-folder-sort-mode:mixed');
        expect(setSessionListFolderSortModeV1).toHaveBeenCalledWith('mixed');

        dropdown?.props.onSelect('session-folder-sort-mode:foldersFirst');
        expect(setSessionListFolderSortModeV1).toHaveBeenCalledWith('foldersFirst');
    });

    it('persists ordering mode selections from the view menu', async () => {
        const screen = await renderSessionsList();
        const dropdown = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((node) => node.props?.items?.some((item: any) => item.id === 'created'));
        const orderingItems = dropdown?.props.items.filter((item: any) => ['custom', 'created', 'updated'].includes(String(item.id))) ?? [];

        expect(orderingItems.map((item: any) => item.id)).toEqual(['custom', 'created', 'updated']);
        expect(orderingItems.every((item: any) => item.category === 'sessionsList.orderingMode.title')).toBe(true);

        dropdown?.props.onSelect('created');
        expect(setSessionListOrderingModeV1).toHaveBeenCalledWith('created');

        dropdown?.props.onSelect('updated');
        expect(setSessionListOrderingModeV1).toHaveBeenCalledWith('updated');
    });

    it('shows effective folders-first state and disables mixed folder sorting in date ordering modes', async () => {
        sessionListOrderingModeV1 = 'updated';
        sessionListFolderSortModeV1 = 'mixed';

        const screen = await renderSessionsList();
        const dropdown = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((node) => node.props?.items?.some((item: any) => item.id === 'session-folder-sort-mode:mixed'));
        const mixedItem = dropdown?.props.items.find((item: any) => item.id === 'session-folder-sort-mode:mixed');
        const foldersFirstItem = dropdown?.props.items.find((item: any) => item.id === 'session-folder-sort-mode:foldersFirst');

        expect(mixedItem?.disabled).toBe(true);
        expect(mixedItem?.rightElement).toBeNull();
        expect(mixedItem?.subtitle).toBe('sessionsList.folderSortMixedDisabledInDateMode');
        expect(foldersFirstItem?.disabled).toBe(false);
        expect(foldersFirstItem?.rightElement).toBeTruthy();

        dropdown?.props.onSelect('session-folder-sort-mode:mixed');
        expect(setSessionListFolderSortModeV1).not.toHaveBeenCalled();
    });

    it('passes folder indentation and move menu options to session rows', async () => {
        mockVisibleSessionListViewData.splice(3, 0, {
            type: 'header',
            title: 'Execution',
            headerKind: 'folder',
            groupKey: `${folderGroupKey}:folder:folder_b`,
            workspace,
            renderWorkspaceKey: 'project_a',
            folderId: 'folder_b',
            parentFolderId: 'folder_a',
            depth: 2,
            sessionCount: 3,
            serverId: 'server_a',
        });
        sessionFoldersV1 = {
            ...sessionFoldersV1,
            folders: [
                ...sessionFoldersV1.folders,
                {
                    id: 'folder_b',
                    workspace,
                    renderWorkspaceKey: 'project_a',
                    parentId: 'folder_a',
                    name: 'Execution',
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
        };

        const screen = await renderSessionsList();

        const folderRow = screen.findByTestId('session-list-session:sess_a');
        expect(folderRow?.props.folderDepth).toBe(1);
        expect(folderRow?.props.folderMoveMenuItems).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'move-to-folder:folder_a' }),
                expect.objectContaining({ id: 'move-to-folder:null' }),
            ]),
        );

        const moveMenuItems = folderRow?.props.folderMoveMenuItems ?? [];
        const rootTarget = moveMenuItems.find((item: any) => item.id === 'move-to-folder:null');
        const parentFolderTarget = moveMenuItems.find((item: any) => item.id === 'move-to-folder:folder_a');
        const childFolderTarget = moveMenuItems.find((item: any) => item.id === 'move-to-folder:folder_b');
        expect(rootTarget?.rowContainerStyle).toBeUndefined();
        expect(parentFolderTarget?.rowContainerStyle).toMatchObject({ paddingLeft: expect.any(Number) });
        expect(childFolderTarget?.rowContainerStyle).toMatchObject({ paddingLeft: expect.any(Number) });
        expect(childFolderTarget.rowContainerStyle.paddingLeft).toBeGreaterThan(parentFolderTarget.rowContainerStyle.paddingLeft);
    });

    it('keeps collapsed child folders available in the row move menu', async () => {
        mockVisibleSessionListViewData.splice(3, 0, {
            type: 'header',
            title: 'Execution',
            headerKind: 'folder',
            groupKey: `${folderGroupKey}:folder:folder_b`,
            workspace,
            renderWorkspaceKey: 'project_a',
            folderId: 'folder_b',
            parentFolderId: 'folder_a',
            depth: 2,
            sessionCount: 3,
            serverId: 'server_a',
        });
        sessionFoldersV1 = {
            ...sessionFoldersV1,
            folders: [
                ...sessionFoldersV1.folders,
                {
                    id: 'folder_b',
                    workspace,
                    renderWorkspaceKey: 'project_a',
                    parentId: 'folder_a',
                    name: 'Execution',
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
        };
        collapsedGroupKeysV1 = { [folderGroupKey]: true };

        const screen = await renderSessionsList();

        expect(screen.findByTestId('session-folder-header-folder_b')).toBeNull();

        const rootRow = screen.findByTestId('session-list-session:sess_b');
        const moveMenuItems = rootRow?.props.folderMoveMenuItems ?? [];
        expect(moveMenuItems).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'move-to-folder:folder_b' }),
        ]));
    });

    it('passes a real drag gesture into session rows', async () => {
        const screen = await renderSessionsList();

        expect(findGestureByKind(findSessionGesture(screen, 'sess_a'), 'pan')).toBeTruthy();
    });

    it('hides session row drag gestures in date mode when the account has no folders', async () => {
        sessionListOrderingModeV1 = 'updated';
        sessionFoldersV1 = { v: 1, folders: [] };
        resetProjectDataWithoutFolders();

        const screen = await renderSessionsList();

        const row = screen.findByTestId('session-list-session:sess_a');
        expect(row?.props.reorderHandleGesture).toBeUndefined();
    });

    it('hides session row drag gestures in date mode when folder view is off', async () => {
        sessionListOrderingModeV1 = 'updated';
        sessionFolderViewModeV1 = 'off';
        resetProjectDataWithoutFolders();

        const screen = await renderSessionsList();

        const row = screen.findByTestId('session-list-session:sess_a');
        expect(row?.props.reorderHandleGesture).toBeUndefined();
    });

    it('keeps session row drag gestures in custom mode even when the account has no folders', async () => {
        sessionListOrderingModeV1 = 'custom';
        sessionFoldersV1 = { v: 1, folders: [] };
        resetProjectDataWithoutFolders();

        const screen = await renderSessionsList();

        expect(findGestureByKind(findSessionGesture(screen, 'sess_a'), 'pan')).toBeTruthy();
    });

    it('shows date-mode session drag gestures when any normalized account folder exists', async () => {
        sessionListOrderingModeV1 = 'created';
        sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'other_folder',
                workspace: otherWorkspace,
                renderWorkspaceKey: 'other_project',
                parentId: null,
                name: 'Elsewhere',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        resetProjectDataWithoutFolders();

        const screen = await renderSessionsList();

        expect(findGestureByKind(findSessionGesture(screen, 'sess_a'), 'pan')).toBeTruthy();
    });

    it('persists a row menu move through the row server assignment op', async () => {
        const screen = await renderSessionsList();
        const row = screen.findByTestId('session-list-session:sess_b');

        await act(async () => {
            row?.props.onMoveToFolder();
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(modalShowSpy).toHaveBeenCalled();
        });
        const modalConfig = modalShowSpy.mock.calls[0]?.[0] as { props?: { targets?: readonly any[]; onSelectTarget?: (target: any) => void } };
        const target = modalConfig.props?.targets?.find((entry) => entry.id === 'folder:folder_a');
        expect(target).toBeTruthy();

        await act(async () => {
            modalConfig.props?.onSelectTarget?.(target);
            await Promise.resolve();
        });

        expect(getServerProfileByIdSpy).toHaveBeenCalledWith('server_a');
        expect(getCredentialsForServerUrlSpy).toHaveBeenCalledWith('https://server-a.test', { serverId: 'server_a' });
        expect(setSessionFolderAssignmentSpy).toHaveBeenCalledWith({
            credentials: { accessToken: 'token-a' },
            serverId: 'server_a',
            serverUrl: 'https://server-a.test',
            sessionId: 'sess_b',
            folderId: 'folder_a',
        });
    });

    it('persists folder assignment with the organization server identity when the credential profile id differs', async () => {
        serverProfileState.profileId = 'server_profile_a';
        const screen = await renderSessionsList();
        const row = screen.findByTestId('session-list-session:sess_b');

        await act(async () => {
            row?.props.onMoveToFolder();
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(modalShowSpy).toHaveBeenCalled();
        });
        const modalConfig = modalShowSpy.mock.calls[0]?.[0] as { props?: { targets?: readonly any[]; onSelectTarget?: (target: any) => void } };
        const target = modalConfig.props?.targets?.find((entry) => entry.id === 'folder:folder_a');
        expect(target).toBeTruthy();

        await act(async () => {
            modalConfig.props?.onSelectTarget?.(target);
            await Promise.resolve();
        });

        expect(getCredentialsForServerUrlSpy).toHaveBeenCalledWith('https://server-a.test', { serverId: 'server_profile_a' });
        expect(setSessionFolderAssignmentSpy).toHaveBeenCalledWith({
            credentials: { accessToken: 'token-a' },
            serverId: 'server_a',
            serverUrl: 'https://server-a.test',
            sessionId: 'sess_b',
            folderId: 'folder_a',
        });
    });

    it('reorders a session row down through the same tree drop commit path', async () => {
        mockVisibleSessionListViewData.splice(4, 0, {
            type: 'session',
            session: { id: 'sess_c', createdAt: 3, active: true, presence: 'online', metadata: null },
            groupKey: folderGroupKey,
            groupKind: 'folder',
            folderId: 'folder_a',
            folderDepth: 1,
            serverId: 'server_a',
        });
        const screen = await renderSessionsList();
        const row = screen.findByTestId('session-list-session:sess_a');

        await act(async () => {
            row?.props.onMoveDown();
            await Promise.resolve();
        });

        await vi.waitFor(() => {
            expect(reorderSessionOrganizationSpy).toHaveBeenCalledWith({
                credentials: { accessToken: 'token-a' },
                serverId: 'server_a',
                serverUrl: 'https://server-a.test',
                request: {
                    scopeKind: 'group',
                    scopeKey: folderGroupKey,
                    entries: [
                        { itemKind: 'session', itemKey: 'sess_c', sortKey: '00000001' },
                        { itemKind: 'session', itemKey: 'sess_a', sortKey: '00000002' },
                    ],
                },
            });
        });
    });

    it('persists order with the organization server identity when the credential profile id differs', async () => {
        serverProfileState.profileId = 'server_profile_a';
        mockVisibleSessionListViewData.splice(4, 0, {
            type: 'session',
            session: { id: 'sess_c', createdAt: 3, active: true, presence: 'online', metadata: null },
            groupKey: folderGroupKey,
            groupKind: 'folder',
            folderId: 'folder_a',
            folderDepth: 1,
            serverId: serverProfileState.activeServerId,
        });
        const screen = await renderSessionsList();
        const row = screen.findByTestId('session-list-session:sess_a');

        await act(async () => {
            row?.props.onMoveDown();
            await Promise.resolve();
        });

        await vi.waitFor(() => {
            expect(reorderSessionOrganizationSpy).toHaveBeenCalledWith({
                credentials: { accessToken: 'token-a' },
                serverId: 'server_a',
                serverUrl: 'https://server-a.test',
                request: {
                    scopeKind: 'group',
                    scopeKey: folderGroupKey,
                    entries: [
                        { itemKind: 'session', itemKey: 'sess_c', sortKey: '00000001' },
                        { itemKind: 'session', itemKey: 'sess_a', sortKey: '00000002' },
                    ],
                },
            });
        });
    });

    it('drives the real session-row drag gesture without legacy intent props', async () => {
        const screen = await renderSessionsList();
        const row = screen.findByTestId('session-list-session:sess_b');

        await driveSessionListDragGesture({
            gesture: findSessionGesture(screen, 'sess_b'),
            pointerSequence: [
                { x: 20, y: 220 },
                { x: 20, y: 244 },
            ],
        });

        expect(row?.props.onDropIntent).toBeUndefined();
        expect(row?.props.resolveDropIntent).toBeUndefined();
    });

    it('drives the real folder header drag gesture', async () => {
        sessionFoldersV1 = {
            v: 1,
            folders: [
                ...sessionFoldersV1.folders,
                {
                    id: 'folder_b',
                    workspace,
                    renderWorkspaceKey: 'project_a',
                    parentId: null,
                    name: 'Archive',
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
        };
        const screen = await renderSessionsList();

        await driveSessionListDragGesture({
            gesture: findFolderGesture(screen),
            pointerSequence: [
                { x: 20, y: 80 },
                { x: 20, y: 120 },
            ],
        });
    });

    it('does not expose legacy drag intent props to session rows', async () => {
        const screen = await renderSessionsList();
        const row = screen.findByTestId('session-list-session:sess_a');

        expect(row?.props.onDragEnd).toBeUndefined();
        expect(row?.props.onDropIntent).toBeUndefined();
        expect(row?.props.resolveDropIntent).toBeUndefined();
    });

    it('does not expose legacy drag intent props to folder header rows', async () => {
        const screen = await renderSessionsList();

        expect(findGestureByKind(findFolderGesture(screen), 'pan')).toBeTruthy();
    });

    it('renders exactly one viewport-level drop overlay and no row-local drop indicator', async () => {
        const screen = await renderSessionsList();

        // The single list-level overlay owns the indicator: exactly one HOST
        // node carries the overlay testID (composite wrappers also carry the
        // prop, so filter to host elements).
        const overlayHosts = screen.findAllByTestId('session-list-drop-overlay')
            .filter((node) => typeof node.type === 'string');
        expect(overlayHosts).toHaveLength(1);
        expect(overlayHosts[0].props.pointerEvents).toBe('none');

        // No session row or folder header receives a legacy row-local visual
        // prop — the overlay's geometry flows entirely through shared values.
        for (const sessionId of ['sess_a', 'sess_b']) {
            const row = screen.findByTestId(`session-list-session:${sessionId}`);
            expect(row?.props.activeDropVisual).toBeUndefined();
            expect(row?.props.activeDropTargetId).toBeUndefined();
            expect(row?.props.dropVisual).toBeUndefined();
        }
    });

    it('keeps the visible row order frozen while a background reorder lands mid-drag', async () => {
        const { SessionsList } = await import('./SessionsList');
        const screen = await renderSessionsList();

        const readVisibleSessionOrder = () => screen
            .findAll((node) => String(node.type) === 'SessionItem')
            .map((node) => node.props.session?.id);
        expect(readVisibleSessionOrder()).toEqual(['sess_a', 'sess_b']);

        // Start a real drag on sess_a. This freezes the visible surface.
        const pan = findGestureByKind(findSessionGesture(screen, 'sess_a'), 'pan') as any;
        await act(async () => {
            pan.__handlers.onStart?.({ absoluteX: 20, absoluteY: 200, translationY: 0 });
            pan.__handlers.onUpdate?.({ absoluteX: 20, absoluteY: 230, translationY: 30 });
        });

        // A background reorder swaps the two session rows in the live list while
        // the drag is active.
        const sessionIndices = mockVisibleSessionListViewData
            .map((item, index) => ({ item, index }))
            .filter((entry) => entry.item.type === 'session');
        const swapped = mockVisibleSessionListViewData.slice();
        const [first, second] = sessionIndices;
        swapped[first.index] = second.item;
        swapped[second.index] = first.item;
        mockVisibleSessionListViewData = swapped;
        await act(async () => {
            await screen.update(<SessionsList />);
        });

        // The visible (frozen) surface must NOT reflect the background swap.
        expect(readVisibleSessionOrder()).toEqual(['sess_a', 'sess_b']);

        // After the drag ends the latest live order renders again.
        await act(async () => {
            pan.__handlers.onEnd?.({ absoluteX: 20, absoluteY: 230, translationY: 30 });
            pan.__handlers.onFinalize?.({ absoluteX: 20, absoluteY: 230, translationY: 30 });
        });
        await act(async () => {
            await screen.update(<SessionsList />);
        });
        expect(readVisibleSessionOrder()).toEqual(['sess_b', 'sess_a']);
    });

    it('creates a root folder from the workspace menu', async () => {
        modalPromptSpy.mockResolvedValueOnce('Roadmap');
        const screen = await renderSessionsList();
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId(`session-list-project-header:${projectGroupKey}`),
                'onHoverIn',
                undefined,
                'expected project header',
            );
        });
        const workspaceMenu = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((node) => node.props?.items?.some((item: any) => item.id === 'add-folder'));

        await act(async () => {
            await workspaceMenu?.props.onSelect('add-folder');
        });

        await vi.waitFor(() => {
            expect(upsertSessionFolderSpy).toHaveBeenCalledWith(expect.objectContaining({
                credentials: { accessToken: 'token-a' },
                serverId: 'server_a',
                serverUrl: 'https://server-a.test',
                request: expect.objectContaining({
                    parentFolderId: null,
                    parentFolderKey: null,
                    display: {
                        t: 'plain',
                        v: {
                            name: 'Roadmap',
                            workspace,
                        },
                    },
                }),
            }));
        });
    });

    it('creates and renames subfolders from the folder menu', async () => {
        const screen = await renderSessionsList();
        const folderMenu = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((node) => node.props?.items?.some((item: any) => item.id === 'add-subfolder'));

        modalPromptSpy.mockResolvedValueOnce('Implementation');
        await act(async () => {
            await folderMenu?.props.onSelect('add-subfolder');
        });
        await vi.waitFor(() => {
            expect(upsertSessionFolderSpy).toHaveBeenCalledWith(expect.objectContaining({
                request: expect.objectContaining({
                    parentFolderId: 'folder_a',
                    parentFolderKey: 'folder_a',
                    display: {
                        t: 'plain',
                        v: {
                            name: 'Implementation',
                            workspace,
                        },
                    },
                }),
            }));
        });

        upsertSessionFolderSpy.mockClear();
        modalPromptSpy.mockResolvedValueOnce('Renamed planning');
        await act(async () => {
            await folderMenu?.props.onSelect('rename');
        });
        await vi.waitFor(() => {
            expect(upsertSessionFolderSpy).toHaveBeenCalledWith(expect.objectContaining({
                request: expect.objectContaining({
                    folderId: 'folder_a',
                    folderKey: 'folder_a',
                    display: {
                        t: 'plain',
                        v: {
                            name: 'Renamed planning',
                            workspace,
                        },
                    },
                }),
            }));
        });
    });

    it('deletes a folder subtree through the canonical delete mutation without a separate assignment move', async () => {
        modalConfirmSpy.mockResolvedValueOnce(true);
        const screen = await renderSessionsList();
        const folderMenu = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((node) => node.props?.items?.some((item: any) => item.id === 'delete'));

        await act(async () => {
            await folderMenu?.props.onSelect('delete');
        });

        expect(moveSessionFolderAssignmentsSpy).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(deleteSessionFolderSpy).toHaveBeenCalledWith({
                credentials: { accessToken: 'token-a' },
                serverId: 'server_a',
                serverUrl: 'https://server-a.test',
                request: {
                    folderId: 'folder_a',
                    assignmentBehavior: 'moveAssignmentsToParent',
                },
            });
        });
    });
});
