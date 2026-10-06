import React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createPlainAccountEncryptionCurrentnessFixture, createRootLayoutFeaturesResponse, createSessionFixture, pressTestInstanceAsync, renderScreen as renderCanonicalScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    createModelBackedSessionItemTestComponent,
    type ModelBackedSessionItemTestProps,
} from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_STOP_ID,
} from '@/components/sessions/actions/sessionActionIds';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/forms/dropdown/ContextMenu', () => ({
    ContextMenu: (props: any) => React.createElement('ContextMenu', props),
}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

const modalConfirmSpy = vi.fn(async () => true);
let hideInactiveSessions = false;
let rejectFirstArchive = false;

const modalAlertSpy = vi.fn();

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
            spies: {
                alert: modalAlertSpy,
                confirm: modalConfirmSpy,
            },
        }).module;
    },
    storage: async (importOriginal) => importOriginal(),
});

// The common presentation harness must not replace the registered state owner.
vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
let previousState: ReturnType<typeof storage.getState>;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
const mutationRequests: Array<{ url: string; method: string; token: string | null; body: unknown }> = [];
const mutationOrder: string[] = [];
afterAll(() => network.dispose());

async function renderScreen(element: Parameters<typeof renderCanonicalScreen>[0]) {
    const props = element.props as Partial<ModelBackedSessionItemTestProps>;
    if (props.session && props.serverId) {
        const homeUrl = `https://${props.serverId.replaceAll('_', '-')}.test`;
        const home = await network.addHome(homeUrl, 'row-account');
        account = await restoreServerAccountForTest({ serverUrl: homeUrl, accountId: 'row-account', request: async (input, init) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname.startsWith('/v1/machines/')) return Response.json({ machine: { id: 'machine-row', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
            if (method === 'POST' && (url.pathname.endsWith('/archive') || url.pathname.endsWith('/read-state'))) {
                mutationRequests.push({ url: url.href, method, token: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
                mutationOrder.push(url.pathname.endsWith('/archive') ? 'archive' : 'read-state');
                if (url.pathname.endsWith('/archive')) {
                    if (rejectFirstArchive) { rejectFirstArchive = false; return Response.json({ error: 'session_active' }, { status: 409 }); }
                    return Response.json({ archivedAt: 1 });
                }
                return Response.json({ success: true, state: 'unread', lastViewedSessionSeq: 0, didChange: true });
            }
            return Response.json({}, { status: 404 });
        } });
        const session = createSessionFixture({ ...props.session, serverId: home.id,
            metadata: { path: '/repo', host: 'tester.local', machineId: 'machine-row', name: 'Scoped row' },
        });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-row' })], true, { sourceServerId: home.id });
        storage.getState().applySessions([session]);
        return renderCanonicalScreen(React.cloneElement(element, { ...props, session, serverId: home.id }));
    }
    return renderCanonicalScreen(element);
}

function expectStopRequest(sessionId: string) {
    expect(network.requests.filter((request) => request.method === RPC_METHODS.STOP_SESSION)).toEqual([
        expect.objectContaining({ serverUrl: account!.home.serverUrl, targetId: 'machine-row', payload: { sessionId }, token: account!.credentials.token }),
    ]);
}

function expectArchiveRequests(sessionId: string, count = 1) {
    expect(mutationRequests.filter((request) => request.url.endsWith('/archive'))).toEqual(Array.from({ length: count }, () => ({
        url: `${account!.home.serverUrl}/v2/sessions/${sessionId}/archive`, method: 'POST', token: `Bearer ${account!.credentials.token}`, body: null,
    })));
    expect(storage.getState().sessions[sessionId]?.archivedAt).toBe(1);
}

async function importSessionItem() {
    const { SessionItem } = await import('./SessionItem');
    return createModelBackedSessionItemTestComponent(SessionItem, {
        resolveRowViewModelOverrides: () => ({ hideInactiveSessions }),
    });
}

describe('SessionItem server-scoped mutations', () => {
    beforeEach(() => {
        previousState = storage.getState();
        network.resetRequests();
        network.setRpcResponder(async (request) => {
            if (request.method !== RPC_METHODS.STOP_SESSION) throw new Error(`Unexpected row RPC: ${request.method}`);
            mutationOrder.push('stop');
            return { status: 'stopped' };
        });
        mutationRequests.length = 0;
        mutationOrder.length = 0;
        rejectFirstArchive = false;
        modalConfirmSpy.mockClear();
        modalAlertSpy.mockClear();
        storage.setState({ sessions: {}, sessionListRowsByServerId: {}, machines: {}, machineListByServerId: {} });
    });
    afterEach(async () => {
        standardCleanup();
        await account?.dispose();
        account = undefined;
        storage.setState(previousState, true);
        hideInactiveSessions = false;
    });

    it('archives active sessions from the swipe action using server scope when serverId is provided', async () => {
        modalAlertSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
                serverName="Server A"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.archiveSession',
            'sessionInfo.archiveSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.archiveSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expectStopRequest('sess_1');
        expectArchiveRequests('sess_1');
        expect(mutationOrder).toEqual(['stop', 'archive']);
    });

    it('archives inactive sessions using server scope when serverId is provided', async () => {
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_2',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_b"
                serverName="Server B"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.archiveSession',
            'sessionInfo.archiveSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.archiveSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expectArchiveRequests('sess_2');
        expect(mutationOrder).toEqual(['archive']);
        expect(network.requests.filter((request) => request.method === RPC_METHODS.STOP_SESSION)).toEqual([]);
    });

    it('stops and retries archiving when an inactive-looking session is still active server-side', async () => {
        rejectFirstArchive = true;
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_stale_inactive',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_b"
                serverName="Server B"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.archiveSession',
            'sessionInfo.archiveSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.archiveSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expectStopRequest('sess_stale_inactive');
        expectArchiveRequests('sess_stale_inactive', 2);
        expect(mutationOrder).toEqual(['archive', 'stop', 'archive']);
    });

    it('archives active sessions from the swipe action when hidden inactive sessions are enabled', async () => {
        hideInactiveSessions = true;
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_3',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_c"
                serverName="Server C"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.archiveSession',
            'sessionInfo.archiveSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.archiveSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expectStopRequest('sess_3');
        expectArchiveRequests('sess_3');
        expect(mutationOrder).toEqual(['stop', 'archive']);
    });

    it('offers an archive action for active sessions in the more menu and stops before archiving', async () => {
        hideInactiveSessions = false;
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_active_archive',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_d"
                serverName="Server D"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');
        const moreMenu = contextMenus.find((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_ARCHIVE_ID),
        );
        expect(moreMenu).toBeTruthy();
        expect(moreMenu!.props.items.some((item: any) => item?.id === SESSION_ACTION_STOP_ID)).toBe(true);

        await act(async () => {
            moreMenu!.props.onSelect(SESSION_ACTION_ARCHIVE_ID);
        });

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.archiveSession',
            'sessionInfo.archiveSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.archiveSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expectStopRequest('sess_active_archive');
        expectArchiveRequests('sess_active_archive');
        expect(mutationOrder).toEqual(['stop', 'archive']);
    });

    it('archives pinned active sessions from the swipe action when hidden inactive sessions are enabled', async () => {
        hideInactiveSessions = true;
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_4',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_d"
                serverName="Server D"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                pinned={true}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.archiveSession',
            'sessionInfo.archiveSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.archiveSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expectStopRequest('sess_4');
        expectArchiveRequests('sess_4');
        expect(mutationOrder).toEqual(['stop', 'archive']);
    });

    it('offers manual mark-unread in the context menu and uses server scope', async () => {
        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_read',
            seq: 3,
            lastViewedSessionSeq: 3,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_read"
                serverName="Server Read"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const contextMenu = screen.root.findAll((node: any) => node.type === 'ContextMenu').find((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID),
        );
        expect(contextMenu).toBeTruthy();

        await act(async () => {
            contextMenu!.props.onSelect(SESSION_ACTION_MARK_UNREAD_ID);
        });

        expect(mutationRequests).toEqual([{ url: `${account!.home.serverUrl}/v2/sessions/sess_read/read-state`, method: 'POST', token: `Bearer ${account!.credentials.token}`, body: { state: 'unread' } }]);
        expect(storage.getState().sessions.sess_read.lastViewedSessionSeq).toBe(0);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('does not offer read-state actions in the context menu from non-terminal raw seq', async () => {
        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_raw_seq',
            seq: 5,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'in_progress',
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_raw"
                serverName="Server Raw"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');
        expect(contextMenus.some((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID || item?.id === SESSION_ACTION_MARK_READ_ID),
        )).toBe(false);
    });

    it('offers session folder move targets in the context menu', async () => {
        const moveToFolder = vi.fn();
        const SessionItem = await importSessionItem();
        type FolderAwareSessionItemProps = ModelBackedSessionItemTestProps & {
            folderMoveTargets?: ReadonlyArray<{
                id: string;
                folderId: string | null;
                title: string;
                depth: number;
                disabled?: boolean;
            }>;
            onMoveToSessionFolder?: (folderId: string | null) => void;
        };
        const FolderAwareSessionItem = SessionItem as React.ComponentType<FolderAwareSessionItemProps>;

        const session = createSessionFixture({
            id: 'sess_folder_move',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
        });

        const screen = await renderScreen(
            <FolderAwareSessionItem
                session={session}
                serverId="server_folder"
                serverName="Server Folder"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                folderMoveTargets={[
                    {
                        id: 'session-folder-move-root',
                        folderId: null,
                        title: 'Workspace root',
                        depth: 0,
                        disabled: false,
                    },
                    {
                        id: 'session-folder-move-planning',
                        folderId: 'planning',
                        title: 'Planning',
                        depth: 0,
                        disabled: false,
                    },
                    {
                        id: 'session-folder-move-planning-review',
                        folderId: 'planning-review',
                        title: 'Review',
                        depth: 1,
                        disabled: false,
                    },
                ]}
                onMoveToSessionFolder={moveToFolder}
            />,
        );

        const contextMenu = screen.root.findAll((node: any) => node.type === 'ContextMenu').find((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MOVE_TO_FOLDER_ID),
        );
        expect(contextMenu).toBeTruthy();
        expect(contextMenu!.props.items.some((item: any) => item?.id === 'session-folder-move-planning')).toBe(false);

        const moveToFolderItem = contextMenu!.props.items.find((item: any) => item?.id === SESSION_ACTION_MOVE_TO_FOLDER_ID);
        expect(moveToFolderItem).toEqual(expect.objectContaining({
            id: SESSION_ACTION_MOVE_TO_FOLDER_ID,
            title: 'sessionsList.moveToFolder',
        }));
        expect(moveToFolderItem.submenu.items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'session-folder-move-root',
                testID: 'dropdown-option-move-to-folder_null',
                title: 'Workspace root',
            }),
            expect.objectContaining({
                id: 'session-folder-move-planning',
                testID: 'dropdown-option-move-to-folder_planning',
                title: 'Planning',
            }),
            expect.objectContaining({
                id: 'session-folder-move-planning-review',
                testID: 'dropdown-option-move-to-folder_planning-review',
                title: 'Review',
                rowContainerStyle: expect.objectContaining({ paddingLeft: expect.any(Number) }),
            }),
        ]));
        const rootMoveItem = moveToFolderItem.submenu.items.find((item: any) => item.id === 'session-folder-move-root');
        expect(rootMoveItem.rowContainerStyle).toBeUndefined();

        await act(async () => {
            contextMenu!.props.onSelect('session-folder-move-planning');
        });
        expect(moveToFolder).toHaveBeenCalledWith('planning');

        await act(async () => {
            contextMenu!.props.onSelect('session-folder-move-root');
        });
        expect(moveToFolder).toHaveBeenCalledWith(null);
    });

    it('routes the move-to-folder menu item and accessibility actions through the accessible move callbacks', async () => {
        const onMoveToFolder = vi.fn();
        const onMoveToWorkspaceRoot = vi.fn();
        const onMoveUp = vi.fn();
        const onMoveDown = vi.fn();
        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_accessible_move',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_folder"
                serverName="Server Folder"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                folderMoveTargets={[
                    {
                        id: 'session-folder-move-root',
                        folderId: null,
                        title: 'Workspace root',
                        depth: 0,
                        disabled: false,
                    },
                ]}
                onMoveToFolder={onMoveToFolder}
                onMoveToWorkspaceRoot={onMoveToWorkspaceRoot}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
            />,
        );

        const contextMenu = screen.root.findAll((node: any) => node.type === 'ContextMenu').find((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MOVE_TO_FOLDER_ID),
        );
        expect(contextMenu).toBeTruthy();
        const moveToFolderItem = contextMenu!.props.items.find((item: any) => item?.id === SESSION_ACTION_MOVE_TO_FOLDER_ID);
        expect(moveToFolderItem.submenu).toBeUndefined();

        await act(async () => {
            contextMenu!.props.onSelect(SESSION_ACTION_MOVE_TO_FOLDER_ID);
        });
        expect(onMoveToFolder).toHaveBeenCalledTimes(1);

        const row = screen.findByProps({ testID: 'session-list-item-sess_accessible_move' });
        expect(row.props.accessibilityActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'moveUp' }),
            expect.objectContaining({ name: 'moveDown' }),
            expect.objectContaining({ name: 'moveToFolder' }),
            expect.objectContaining({ name: 'moveToWorkspaceRoot' }),
        ]));

        await act(async () => {
            row.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveUp' } });
            row.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveDown' } });
            row.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveToFolder' } });
            row.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveToWorkspaceRoot' } });
        });

        expect(onMoveUp).toHaveBeenCalledTimes(1);
        expect(onMoveDown).toHaveBeenCalledTimes(1);
        expect(onMoveToFolder).toHaveBeenCalledTimes(2);
        expect(onMoveToWorkspaceRoot).toHaveBeenCalledTimes(1);
    });

    it('hides manual read-state actions for archived sessions', async () => {
        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_archived_read',
            seq: 3,
            lastViewedSessionSeq: 3,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: 2,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_archived"
                serverName="Server Archived"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');
        expect(contextMenus.some((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID || item?.id === SESSION_ACTION_MARK_READ_ID),
        )).toBe(false);
    });
});
