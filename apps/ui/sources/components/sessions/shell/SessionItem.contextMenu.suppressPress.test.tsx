import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionItemTestRowModel, installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import {
    SessionListSelectionProvider,
    useSessionListSelectionActions,
} from './selection/SessionListSelectionContext';
import { SESSION_ACTION_RENAME_ID } from '@/components/sessions/actions/sessionActionIds';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));

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

const navigateToSessionSpy = vi.fn();
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

const modalPromptSpy = vi.fn(async () => null as string | null);
const sessionRenameSpy = vi.fn(async () => ({ success: true }));
const openSessionForkStrategyFlowSpy = vi.fn();

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/sessions/fork/openSessionForkStrategyFlow', () => ({
    openSessionForkStrategyFlow: (...args: unknown[]) => openSessionForkStrategyFlowSpy(...args),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (callback: () => void) => callback(),
}));

function hasRenameMenuItem(items: unknown): boolean {
    if (!Array.isArray(items)) return false;
    return items.some((item: unknown) => {
        if (!item || typeof item !== 'object') return false;
        return (item as { id?: unknown }).id === SESSION_ACTION_RENAME_ID;
    });
}

function hasSelectMenuItem(items: unknown): boolean {
    if (!Array.isArray(items)) return false;
    return items.some((item: unknown) => {
        if (!item || typeof item !== 'object') return false;
        return (item as { id?: unknown }).id === 'selection.select';
    });
}

function hasCopyDebugInformationMenuItem(items: unknown): boolean {
    if (!Array.isArray(items)) return false;
    return items.some((item: unknown) => {
        if (!item || typeof item !== 'object') return false;
        return (item as { id?: unknown }).id === 'session.copyDebugInformation';
    });
}

function SelectionModeControls() {
    const actions = useSessionListSelectionActions();
    return React.createElement('SelectionModeControls', {
        testID: 'enter-selection-mode',
        onPress: () => actions.enter(),
    });
}

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionRename: sessionRenameSpy,
        },
    });
});

let platformOs: 'ios' | 'android' | 'web' = 'ios';
let localDevModeEnabled = false;
const storageSessionsState = vi.hoisted(() => ({
    current: {} as Record<string, any>,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformOs;
                },
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
            spies: {
                prompt: modalPromptSpy,
            },
        }).module;
    },
    storage: async (_importOriginal) => {
        const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        const store = createStorageStoreMock({});
        const getBaseState = store.getState;
        const getBaseInitialState = store.getInitialState;
        const storage = Object.assign(store, {
            getState: () => ({
                ...getBaseState(),
                sessions: storageSessionsState.current,
            }),
            getInitialState: () => ({
                ...getBaseInitialState(),
                sessions: storageSessionsState.current,
            }),
        });
        return createStorageModuleStub({
            storage,
            getStorage: () => storage,
            useHasUnreadMessages: () => false,
            useLocalSetting: (key: string) => key === 'devModeEnabled' ? localDevModeEnabled : null,
            useSetting: (key: string) => key === 'sessionReplayEnabled',
            useSettings: () => ({ sessionReplayEnabled: true }),
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
        });
    },
});

describe('SessionItem context menu press suppression', () => {
    type SessionItemForTestProps = Omit<
        React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>,
        'rowModel'
    > & {
        rowModel?: React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>['rowModel'];
    };

    let SessionItem: React.ComponentType<SessionItemForTestProps>;

    beforeEach(async () => {
        const { SessionItem: ProductionSessionItem } = await import('./SessionItem');
        SessionItem = (props) => (
            <ProductionSessionItem
                {...props}
                rowModel={props.rowModel ?? createSessionItemTestRowModel(props)}
            />
        );
    });

    afterEach(() => {
        standardCleanup();
        navigateToSessionSpy.mockClear();
        modalPromptSpy.mockReset();
        modalPromptSpy.mockResolvedValue(null);
        sessionRenameSpy.mockReset();
        sessionRenameSpy.mockResolvedValue({ success: true });
        openSessionForkStrategyFlowSpy.mockReset();
        platformOs = 'ios';
        localDevModeEnabled = false;
        storageSessionsState.current = {};
        vi.useRealTimers();
    });

    it('offers fork in the session row dropdown without a subtitle and opens the shared fork flow', async () => {
        platformOs = 'web';
        const session = createSessionFixture({
            id: 'sess_fork',
            active: true,
            metadata: {
                flavor: 'claude',
                machineId: 'machine_a',
                path: '/workspace/project',
                host: 'host-a',
            },
        });
        storageSessionsState.current = { [session.id]: session };

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                forkActionContext={{
                    settings: {},
                    replayEnabled: true,
                    executionRunsEnabled: false,
                }}
            />,
        );

        const hoverContainer = screen.root.findAll((node) => typeof node.props.onPointerEnter === 'function')[0];
        await act(async () => hoverContainer?.props.onPointerEnter());
        const dropdown = screen.findByType('DropdownMenu' as React.ElementType);
        const forkItem = dropdown.props.items.find((item: { id: string }) => item.id === 'session.fork');

        expect(forkItem).toMatchObject({
            id: 'session.fork',
            title: 'sessionInfo.forkSession',
            subtitle: undefined,
        });

        await act(async () => {
            await dropdown.props.onSelect('session.fork');
        });

        await vi.waitFor(() => {
            expect(openSessionForkStrategyFlowSpy).toHaveBeenCalledWith(expect.objectContaining({
                sessionId: 'sess_fork',
                forkSupportSource: session,
                serverId: 'server_a',
                machineId: 'machine_a',
                forkPoint: { type: 'latest' },
            }));
        });
    });

    it('does not mount closed native context menus until they are opened', async () => {
        const session = createSessionFixture({
            id: 'sess_lazy_menu',
            active: true,
            metadata: null,
        });

        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        expect(screen.tree.root.findAllByType('DropdownMenu' as React.ElementType)).toHaveLength(0);

        await act(async () => {
            screen.tree.update(
                <SessionItem
                    session={session}
                    serverId="server_a"
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                    nativeContextMenuOpen={true}
                    onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
                />,
            );
        });

        const menus = screen.tree.root.findAllByType('DropdownMenu' as React.ElementType);
        expect(menus).toHaveLength(1);
        expect(hasRenameMenuItem(menus[0].props.items)).toBe(true);
    });

    it('shows the copy information context menu item in developer-mode builds', async () => {
        const session = createSessionFixture({
            id: 'sess_debug_menu',
            active: false,
            metadata: {
                path: '/workspace/repo',
                host: 'host',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
                sessionLogPath: '/tmp/happier/session.log',
            },
        });

        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        let menus = screen.tree.root.findAllByType('DropdownMenu' as React.ElementType);
        expect(menus).toHaveLength(1);
        expect(hasCopyDebugInformationMenuItem(menus[0].props.items)).toBe(true);
    });

    it('copies debug information from the full cached session when row metadata is list-projected', async () => {
        const Clipboard = await import('expo-clipboard');
        localDevModeEnabled = true;
        const fullSession = createSessionFixture({
            id: 'sess_debug_full',
            active: false,
            metadata: {
                path: '/workspace/repo',
                homeDir: '/Users/agent',
                host: 'host',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
                claudeTranscriptPath: '/tmp/claude/session.jsonl',
                sessionLogPath: '/tmp/happier/session.log',
            },
        });
        storageSessionsState.current = { [fullSession.id]: fullSession };
        const rowSession = {
            ...fullSession,
            metadata: {
                path: '/workspace/repo',
                homeDir: '/Users/agent',
                host: 'host',
                flavor: 'claude',
            },
        };

        const screen = await renderScreen(
            <SessionItem
                session={rowSession}
                serverId="server_a"
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={() => {}}
            />,
        );

        const contextMenu = screen.findByType('DropdownMenu' as React.ElementType);
        await act(async () => {
            await contextMenu.props.onSelect('session.copyDebugInformation');
        });

        expect(Clipboard.setStringAsync).toHaveBeenCalledWith([
            'Happier session ID: sess_debug_full',
            'agentInput.agent.claude session ID: claude-session-1',
            'Happier logs: /tmp/happier/session.log',
            'agentInput.agent.claude session logs: /tmp/claude/session.jsonl',
        ].join('\n'));
    });

    it('suppresses the release press after a native context menu is opened externally', async () => {
        vi.useFakeTimers();

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

        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionItem
                session={session}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        await act(async () => {
            screen.tree.update(
                <SessionItem
                    session={session}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                    nativeContextMenuOpen={true}
                    onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
                />,
            );
        });

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_1' });
        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });

        expect(onNativeContextMenuOpenChange).not.toHaveBeenCalledWith(false);
        expect(navigateToSessionSpy).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(750);
        });

        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });

        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_1', undefined);
    });

    it('delegates iOS native inline drag context-menu opening to the outer row gesture', async () => {
        vi.useFakeTimers();

        const session = {
            id: 'sess_2',
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

        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionItem
                session={session}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeInlineDragEnabled={true}
                reorderHandleGesture={{ type: 'pan' } as any}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_2' });
        expect(itemPressable.props.onPressIn).toBeUndefined();
        expect(itemPressable.props.onPressOut).toBeUndefined();
        expect(itemPressable.props.onLongPress).toBeUndefined();
        expect(onNativeContextMenuOpenChange).not.toHaveBeenCalled();
    });

    it('opens the iOS native context menu from a press-in timer before release', async () => {
        vi.useFakeTimers();

        const session = {
            id: 'sess_press_in',
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

        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionItem
                session={session}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeInlineDragEnabled={false}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_press_in' });
        expect(itemPressable.props.onPressIn).toEqual(expect.any(Function));

        await act(async () => {
            itemPressable.props.onPressIn();
            vi.advanceTimersByTime(349);
        });
        expect(onNativeContextMenuOpenChange).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(onNativeContextMenuOpenChange).toHaveBeenCalledWith(true);

        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });
        expect(navigateToSessionSpy).not.toHaveBeenCalled();
    });

    it('does not wrap iOS native inline drag rows in Swipeable so long-press gestures can activate', async () => {
        const session = {
            id: 'sess_swipeable',
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
                currentUserId="u1"
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeInlineDragEnabled={true}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={() => {}}
            />,
        );

        expect(screen.tree.root.findAllByType('Swipeable' as React.ElementType)).toHaveLength(0);
    });

    it('disables row long-press actions on Android while the hotfix is active', async () => {
        platformOs = 'android';

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

        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionItem
                session={session}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeInlineDragEnabled={false}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_3' });
        expect(itemPressable.props.onLongPress).toBeUndefined();
    });

    it('opens the rename prompt after the native context menu close turn', async () => {
        vi.useFakeTimers();
        modalPromptSpy.mockResolvedValueOnce('Renamed Session');

        const session = createSessionFixture({
            id: 'sess_rename',
            active: true,
            metadata: null,
        });

        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        const contextMenu = screen.findByType('DropdownMenu' as React.ElementType);
        expect(hasRenameMenuItem(contextMenu.props.items)).toBe(true);

        await act(async () => {
            contextMenu.props.onSelect(SESSION_ACTION_RENAME_ID);
        });

        expect(onNativeContextMenuOpenChange).toHaveBeenCalledWith(false);
        expect(modalPromptSpy).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(0);
            await Promise.resolve();
        });

        expect(modalPromptSpy).toHaveBeenCalledTimes(1);
        expect(sessionRenameSpy).toHaveBeenCalledWith('sess_rename', 'Renamed Session', { serverId: 'server_a' });
    });

    it('adds a native context-menu Select entry that enters selection mode for the row', async () => {
        const session = createSessionFixture({
            id: 'sess_select',
            active: true,
            metadata: null,
        });
        const selectionKey = 'server_a:sess_select';
        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={[selectionKey]}>
                <SessionItem
                    session={session}
                    serverId="server_a"
                    selectionKey={selectionKey}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                    nativeContextMenuOpen={true}
                    onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
                />
            </SessionListSelectionProvider>,
        );

        const contextMenu = screen.findByType('DropdownMenu' as React.ElementType);
        expect(hasSelectMenuItem(contextMenu.props.items)).toBe(true);

        await act(async () => {
            contextMenu.props.onSelect('selection.select');
        });

        expect(onNativeContextMenuOpenChange).toHaveBeenCalledWith(false);
        const checkbox = screen.findByProps({ testID: 'session-list-selection-checkbox-sess_select' });
        expect(checkbox.props.accessibilityState).toEqual({ checked: true });
    });

    it('toggles selection instead of navigating when a native row is tapped in selection mode', async () => {
        const session = createSessionFixture({
            id: 'sess_toggle',
            active: true,
            metadata: null,
        });
        const selectionKey = 'server_a:sess_toggle';

        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={[selectionKey]}>
                <SelectionModeControls />
                <SessionItem
                    session={session}
                    serverId="server_a"
                    selectionKey={selectionKey}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                    nativeContextMenuOpen={false}
                    onNativeContextMenuOpenChange={() => {}}
                />
            </SessionListSelectionProvider>,
        );

        await act(async () => {
            screen.findByProps({ testID: 'enter-selection-mode' }).props.onPress();
        });

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_toggle' });
        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });

        expect(navigateToSessionSpy).not.toHaveBeenCalled();
        const checkbox = screen.findByProps({ testID: 'session-list-selection-checkbox-sess_toggle' });
        expect(checkbox.props.accessibilityState).toEqual({ checked: true });
    });

    it('keeps the session identity visible on web row hover outside selection mode', async () => {
        platformOs = 'web';
        const session = createSessionFixture({
            id: 'sess_hover',
            active: true,
            metadata: null,
        });
        const selectionKey = 'server_a:sess_hover';

        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={[selectionKey]}>
                <SessionItem
                    session={session}
                    serverId="server_a"
                    selectionKey={selectionKey}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                />
            </SessionListSelectionProvider>,
        );

        expect(screen.tree.root.findAllByProps({ testID: 'session-list-selection-checkbox-sess_hover' })).toHaveLength(0);

        const hoverTarget = screen.tree.root.findAll((node) => typeof node.props?.onPointerEnter === 'function')[0];
        expect(hoverTarget).toBeDefined();
        await act(async () => {
            hoverTarget.props.onPointerEnter();
        });

        expect(screen.tree.root.findAllByProps({ testID: 'session-list-selection-checkbox-sess_hover' })).toHaveLength(0);
        expect(screen.tree.root.findAllByProps({ testID: 'session-list-avatar-loading-sess_hover' })).toHaveLength(1);
    });

    it('adds a web more-menu Select entry that enters selection mode for the row', async () => {
        platformOs = 'web';
        const session = createSessionFixture({
            id: 'sess_web_select',
            active: true,
            metadata: null,
        });
        const selectionKey = 'server_a:sess_web_select';

        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={[selectionKey]}>
                <SessionItem
                    session={session}
                    serverId="server_a"
                    selectionKey={selectionKey}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                />
            </SessionListSelectionProvider>,
        );

        const hoverTarget = screen.tree.root.findAll((node) => typeof node.props?.onPointerEnter === 'function')[0];
        expect(hoverTarget).toBeDefined();
        await act(async () => {
            hoverTarget.props.onPointerEnter();
        });

        const menus = screen.tree.root.findAllByType('DropdownMenu' as React.ElementType);
        const moreMenu = menus.find((menu) => hasSelectMenuItem(menu.props.items));
        expect(moreMenu).toBeDefined();

        await act(async () => {
            moreMenu?.props.onSelect('selection.select');
        });

        const checkbox = screen.findByProps({ testID: 'session-list-selection-checkbox-sess_web_select' });
        expect(checkbox.props.accessibilityState).toEqual({ checked: true });
    });
});
