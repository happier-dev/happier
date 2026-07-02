import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
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

vi.mock('react-native-reanimated', () => ({}));

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

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    getSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
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

const stopSpy = vi.fn(async () => ({ success: true }));
type ArchiveSpyResult = Readonly<{
    success: boolean;
    archivedAt?: number | null;
    message?: string;
    code?: string;
}>;
const archiveSpy = vi.fn(async (): Promise<ArchiveSpyResult> => ({ success: true, archivedAt: 1 }));
const readStateSpy = vi.fn(async () => ({ success: true, readState: 'unread', lastViewedSessionSeq: 0, didChange: true }));
const modalConfirmSpy = vi.fn(async () => true);
let hideInactiveSessions = false;

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: stopSpy,
    sessionArchiveWithServerScope: archiveSpy,
    sessionSetManualReadStateWithServerScope: readStateSpy,
}));

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
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useHasUnreadMessages: () => false,
                useProfile: () => ({
                    id: 'u1',
                    timestamp: 0,
                    firstName: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [],
                    connectedServices: [],
                    connectedServicesV2: [],
                }),
                useSession: () => null,
                useSessionListMeaningfulActivityAt: () => null,
                useSetting: (key: string) => {
                    if (key === 'hideInactiveSessions') return hideInactiveSessions;
                    return false;
                },
            },
        });
    },
});

async function importSessionItem() {
    const { SessionItem } = await import('./SessionItem');
    return createModelBackedSessionItemTestComponent(SessionItem);
}

describe('SessionItem server-scoped mutations', () => {
    afterEach(() => {
        standardCleanup();
        hideInactiveSessions = false;
    });

    it('archives active sessions from the swipe action using server scope when serverId is provided', async () => {
        archiveSpy.mockClear();
        stopSpy.mockClear();
        readStateSpy.mockClear();
        modalAlertSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = {
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
        } as any;

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

        expect(stopSpy).toHaveBeenCalledWith('sess_1', { serverId: 'server_a' });
        expect(archiveSpy).toHaveBeenCalledWith('sess_1', { serverId: 'server_a' });
    });

    it('archives inactive sessions using server scope when serverId is provided', async () => {
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = {
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
        } as any;

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

        expect(archiveSpy).toHaveBeenCalledWith('sess_2', { serverId: 'server_b' });
        expect(stopSpy).not.toHaveBeenCalled();
    });

    it('stops and retries archiving when an inactive-looking session is still active server-side', async () => {
        archiveSpy.mockClear();
        archiveSpy
            .mockResolvedValueOnce({
                success: false,
                message: 'Cannot archive an active session',
                code: 'session_active',
            })
            .mockResolvedValueOnce({ success: true, archivedAt: 1 });
        stopSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = {
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
        } as any;

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
        expect(stopSpy).toHaveBeenCalledWith('sess_stale_inactive', { serverId: 'server_b' });
        expect(archiveSpy).toHaveBeenCalledTimes(2);
        expect(archiveSpy).toHaveBeenNthCalledWith(1, 'sess_stale_inactive', { serverId: 'server_b' });
        expect(archiveSpy).toHaveBeenNthCalledWith(2, 'sess_stale_inactive', { serverId: 'server_b' });
    });

    it('archives active sessions from the swipe action when hidden inactive sessions are enabled', async () => {
        hideInactiveSessions = true;
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = {
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
        } as any;

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

        expect(stopSpy).toHaveBeenCalledWith('sess_3', { serverId: 'server_c' });
        expect(archiveSpy).toHaveBeenCalledWith('sess_3', { serverId: 'server_c' });
    });

    it('offers an archive action for active sessions in the more menu and stops before archiving', async () => {
        hideInactiveSessions = false;
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = {
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
        } as any;

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

        expect(stopSpy).toHaveBeenCalledWith('sess_active_archive', { serverId: 'server_d' });
        expect(archiveSpy).toHaveBeenCalledWith('sess_active_archive', { serverId: 'server_d' });
    });

    it('archives pinned active sessions from the swipe action when hidden inactive sessions are enabled', async () => {
        hideInactiveSessions = true;
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = {
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
        } as any;

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

        expect(stopSpy).toHaveBeenCalledWith('sess_4', { serverId: 'server_d' });
        expect(archiveSpy).toHaveBeenCalledWith('sess_4', { serverId: 'server_d' });
    });

    it('offers manual mark-unread in the context menu and uses server scope', async () => {
        readStateSpy.mockClear();
        const SessionItem = await importSessionItem();

        const session = {
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
        } as any;

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

        expect(readStateSpy).toHaveBeenCalledWith('sess_read', 'unread', { serverId: 'server_read' });
    });

    it('does not offer read-state actions in the context menu from non-terminal raw seq', async () => {
        const SessionItem = await importSessionItem();

        const session = {
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
        } as any;

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

        const session = {
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
        } as any;

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

        const session = {
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
        } as any;

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

        const session = {
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
        } as any;

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
