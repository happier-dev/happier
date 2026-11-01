import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionItemTestRowModel, installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_RENAME_ID,
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
const readStateSpy = vi.fn(async () => ({ success: true, readState: 'unread', lastViewedSessionSeq: 1, didChange: true }));
type ArchiveSpyResult = Readonly<{
    success: boolean;
    archivedAt?: number | null;
    message?: string;
    code?: string;
}>;
const archiveSpy = vi.fn(async (): Promise<ArchiveSpyResult> => ({ success: true, archivedAt: 1 }));
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
                    connectedServiceCredentialRevisionsV1: [],
                }),
                useSession: () => null,
                useSetting: (key: string) => {
                    if (key === 'hideInactiveSessions') return hideInactiveSessions;
                    return false;
                },
            },
        });
    },
});

type SessionItemForTestProps = Omit<
    React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>,
    'rowModel'
> & {
    rowModel?: React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>['rowModel'];
};

let SessionItem: React.ComponentType<SessionItemForTestProps>;

describe('SessionItem server-scoped mutations', () => {
    beforeAll(async () => {
        const { SessionItem: ProductionSessionItem } = await import('./SessionItem');
        SessionItem = (props) => (
            <ProductionSessionItem
                {...props}
                rowModel={props.rowModel ?? createSessionItemTestRowModel(props)}
            />
        );
    }, 120_000);

    afterEach(() => {
        standardCleanup();
        hideInactiveSessions = false;
    });

    it('does not mount closed native ContextMenu shells until the row menu opens', async () => {
        const session = {
            id: 'sess_lazy_context_menu',
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
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        expect(screen.root.findAll((node: any) => node.type === 'ContextMenu')).toHaveLength(0);

        await act(async () => {
            screen.tree.update(
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
                    nativeContextMenuOpen={true}
                    onNativeContextMenuOpenChange={vi.fn()}
                />,
            );
        });

        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');
        expect(contextMenus).toHaveLength(1);
        expect(contextMenus[0].props.items.some((item: any) => item?.id === SESSION_ACTION_RENAME_ID)).toBe(true);
    });

    it('archives active sessions from the swipe action using server scope when serverId is provided', async () => {
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();

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
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await pressTestInstanceAsync(
            rightActionsScreen.find((node: any) => node.type === 'Pressable'),
            'session swipe action',
        );

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.stopSession',
            'sessionInfo.stopSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.stopSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expect(stopSpy).toHaveBeenCalledWith('sess_1', { serverId: 'server_a' });
        expect(archiveSpy).toHaveBeenCalledWith('sess_1', { serverId: 'server_a', signal: expect.any(AbortSignal) });
    });

    it('archives inactive sessions using server scope when serverId is provided', async () => {
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

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
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await pressTestInstanceAsync(
            rightActionsScreen.find((node: any) => node.type === 'Pressable'),
            'session swipe action',
        );

        expect(modalConfirmSpy).not.toHaveBeenCalled();
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
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await pressTestInstanceAsync(
            rightActionsScreen.find((node: any) => node.type === 'Pressable'),
            'session swipe action',
        );

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.stopSession',
            'sessionInfo.stopSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.stopSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(stopSpy).toHaveBeenCalledWith('sess_stale_inactive', { serverId: 'server_b' });
        expect(archiveSpy).toHaveBeenCalledTimes(2);
        expect(archiveSpy).toHaveBeenNthCalledWith(1, 'sess_stale_inactive', { serverId: 'server_b' });
        expect(archiveSpy).toHaveBeenNthCalledWith(2, 'sess_stale_inactive', { serverId: 'server_b', signal: expect.any(AbortSignal) });
    });

    it('archives active sessions from the swipe action when hidden inactive sessions are enabled', async () => {
        hideInactiveSessions = true;
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

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
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await pressTestInstanceAsync(
            rightActionsScreen.find((node: any) => node.type === 'Pressable'),
            'session swipe action',
        );

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.stopSession',
            'sessionInfo.stopSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.stopSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expect(stopSpy).toHaveBeenCalledWith('sess_3', { serverId: 'server_c' });
        expect(archiveSpy).toHaveBeenCalledWith('sess_3', { serverId: 'server_c', signal: expect.any(AbortSignal) });
    });

    it('offers an archive action for active sessions in the more menu and stops before archiving', async () => {
        hideInactiveSessions = false;
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

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
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={vi.fn()}
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
            'sessionInfo.stopSession',
            'sessionInfo.stopSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.stopSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expect(stopSpy).toHaveBeenCalledWith('sess_active_archive', { serverId: 'server_d' });
        expect(archiveSpy).toHaveBeenCalledWith('sess_active_archive', { serverId: 'server_d', signal: expect.any(AbortSignal) });
    });

    it('does not expose archive for active shared-admin sessions owned by another user', async () => {
        hideInactiveSessions = false;
        archiveSpy.mockClear();
        stopSpy.mockClear();

        const session = {
            id: 'sess_shared_admin_active',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            owner: 'u2',
            accessLevel: 'admin',
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
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        const swipeables = screen.root.findAll((node: any) => typeof node.props?.renderRightActions === 'function');
        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');

        expect(swipeables).toHaveLength(0);
        expect(contextMenus.some((node: any) =>
            Array.isArray(node.props?.items)
            && node.props.items.some((item: any) => item?.id === SESSION_ACTION_ARCHIVE_ID),
        )).toBe(false);
        expect(stopSpy).not.toHaveBeenCalled();
        expect(archiveSpy).not.toHaveBeenCalled();
    });

    it('offers mark-unread for read sessions in the more menu using server scope', async () => {
        readStateSpy.mockClear();
        const session = {
            id: 'sess_read',
            seq: 2,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
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
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');
        const moreMenu = contextMenus.find((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID),
        );
        expect(moreMenu).toBeTruthy();

        await act(async () => {
            moreMenu!.props.onSelect(SESSION_ACTION_MARK_UNREAD_ID);
        });

        expect(readStateSpy).toHaveBeenCalledWith('sess_read', 'unread', { serverId: 'server_d' });
    });

    it('offers mark-read for unread sessions in the more menu using server scope', async () => {
        readStateSpy.mockClear();
        const session = {
            id: 'sess_unread',
            seq: 2,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
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
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');
        const moreMenu = contextMenus.find((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_READ_ID),
        );
        expect(moreMenu).toBeTruthy();

        await act(async () => {
            moreMenu!.props.onSelect(SESSION_ACTION_MARK_READ_ID);
        });

        expect(readStateSpy).toHaveBeenCalledWith('sess_unread', 'read', { serverId: 'server_d' });
    });

    it('does not offer mark-read for non-terminal raw session seq in the more menu', async () => {
        readStateSpy.mockClear();
        const session = {
            id: 'sess_non_terminal_raw',
            seq: 2,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'in_progress',
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
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
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');
        expect(contextMenus.some((node: any) =>
            Array.isArray(node.props?.items)
            && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_READ_ID || item?.id === SESSION_ACTION_MARK_UNREAD_ID),
        )).toBe(false);
        expect(readStateSpy).not.toHaveBeenCalled();
    });

    it('does not offer read-state actions for archived sessions', async () => {
        const session = {
            id: 'sess_archived',
            seq: 2,
            lastViewedSessionSeq: 2,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: 123,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
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
        expect(contextMenus.some((node: any) =>
            Array.isArray(node.props?.items)
            && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_READ_ID || item?.id === SESSION_ACTION_MARK_UNREAD_ID),
        )).toBe(false);
    });

    it('does not offer read-state actions for view-only shared sessions', async () => {
        const session = {
            id: 'sess_view_only',
            seq: 2,
            lastViewedSessionSeq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
            accessLevel: 'view',
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
        expect(contextMenus.some((node: any) =>
            Array.isArray(node.props?.items)
            && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_READ_ID || item?.id === SESSION_ACTION_MARK_UNREAD_ID),
        )).toBe(false);
    });

    it('uses the move sheet action when an accessible move fallback is provided', async () => {
        const session = {
            id: 'sess_move_sheet',
            seq: 2,
            lastViewedSessionSeq: 2,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as any;
        const onMoveToFolder = vi.fn();
        const onMoveToWorkspaceRoot = vi.fn();

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
                onMoveToFolder={onMoveToFolder}
                onMoveToWorkspaceRoot={onMoveToWorkspaceRoot}
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');
        const moreMenu = contextMenus.find((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MOVE_TO_FOLDER_ID),
        );
        const moveItem = moreMenu!.props.items.find((item: any) => item?.id === SESSION_ACTION_MOVE_TO_FOLDER_ID);
        expect(moveItem?.submenu).toBeUndefined();

        await act(async () => {
            moreMenu!.props.onSelect(SESSION_ACTION_MOVE_TO_FOLDER_ID);
        });

        expect(onMoveToFolder).toHaveBeenCalledTimes(1);

        const row = screen.findByTestId('session-list-item-sess_move_sheet');
        expect(row?.props.accessibilityActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'moveToFolder' }),
            expect.objectContaining({ name: 'moveToWorkspaceRoot' }),
        ]));
    });

    it('archives pinned active sessions from the swipe action when hidden inactive sessions are enabled', async () => {
        hideInactiveSessions = true;
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

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
        await pressTestInstanceAsync(
            rightActionsScreen.find((node: any) => node.type === 'Pressable'),
            'session swipe action',
        );

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.stopSession',
            'sessionInfo.stopSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.stopSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expect(stopSpy).toHaveBeenCalledWith('sess_4', { serverId: 'server_d' });
        expect(archiveSpy).toHaveBeenCalledWith('sess_4', { serverId: 'server_d', signal: expect.any(AbortSignal) });
    });
});
