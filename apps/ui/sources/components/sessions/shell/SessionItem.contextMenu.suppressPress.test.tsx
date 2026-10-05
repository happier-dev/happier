import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createModelBackedSessionItemTestComponent } from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { SessionListSelectionProvider, createSessionListSelectionStore } from './selection/SessionListSelectionContext';
import { SESSION_ACTION_RENAME_ID } from '@/components/sessions/actions/sessionActionIds';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionRenameSpy = vi.fn(async () => ({ success: true }));
const modalPromptSpy = vi.fn(async () => 'Renamed Session');
const openSessionForkStrategyFlowSpy = vi.fn();
const sessionForkFlowModuleLoadedSpy = vi.fn();

vi.mock('@/components/sessions/fork/openSessionForkStrategyFlow', () => {
    sessionForkFlowModuleLoadedSpy();
    return {
        openSessionForkStrategyFlow: (...args: unknown[]) => openSessionForkStrategyFlowSpy(...args),
    };
});


vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/forms/dropdown/ContextMenu', () => ({
    ContextMenu: (props: any) => React.createElement('ContextMenu', props),
}));

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));

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

const navigateToSessionSpy = vi.fn();
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'android' | 'web',
}));
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
            useSessionListRenderable: () => null,
            useSessionListMeaningfulActivityAt: () => null,
            useLocalSetting: (key: string) => key === 'devModeEnabled' ? localDevModeEnabled : null,
        });
    },
});

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionRename: sessionRenameSpy,
        },
    });
});

// Collect the real owner before test execution. A cold graph transform inside
// a timed test can finish after cleanup and contaminate the next renderer.
const { SessionItem } = await import('./SessionItem');
async function importSessionItem() {
    return createModelBackedSessionItemTestComponent(SessionItem);
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

describe('SessionItem context menu press suppression', () => {
    afterEach(() => {
        standardCleanup();
        navigateToSessionSpy.mockClear();
        modalPromptSpy.mockClear();
        sessionRenameSpy.mockClear();
        openSessionForkStrategyFlowSpy.mockReset();
        platformState.os = 'ios';
        localDevModeEnabled = false;
        storageSessionsState.current = {};
        vi.useRealTimers();
    });

    it('keeps native context menus closed until they are opened', async () => {
        const SessionItem = await importSessionItem();

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

        const closedMenus = screen.tree.root.findAllByType('ContextMenu' as React.ElementType);
        expect(closedMenus).toHaveLength(1);
        expect(closedMenus[0].props.open).toBe(false);

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

        const menus = screen.tree.root.findAllByType('ContextMenu' as React.ElementType);
        expect(menus).toHaveLength(1);
        expect(menus[0].props.open).toBe(true);
        expect(menus[0].props.items.some((item: { id?: string }) => item.id === SESSION_ACTION_RENAME_ID)).toBe(true);
    });

    it('shows the copy information context menu item in developer mode', async () => {
        localDevModeEnabled = true;
        const SessionItem = await importSessionItem();

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
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        const menus = screen.tree.root.findAllByType('ContextMenu' as React.ElementType);
        expect(menus).toHaveLength(1);
        expect(hasCopyDebugInformationMenuItem(menus[0].props.items)).toBe(true);
    });

    it('copies debug information from the full cached session when row metadata is list-projected', async () => {
        const Clipboard = await import('expo-clipboard');
        localDevModeEnabled = true;
        const SessionItem = await importSessionItem();
        const fullSession = createSessionFixture({
            id: 'sess_debug_full',
            active: false,
            metadata: {
                path: '/workspace/repo',
                homeDir: '/Users/agent',
                host: 'host',
                flavor: 'codex',
                sessionLogPath: '/tmp/happier/session.log',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    agent: {
                        backendMode: 'appServer',
                        providerSessionId: 'codex-session-1',
                    },
                },
                nativeResumeIdentityV1: {
                    v: 1,
                    vendorResumeId: 'codex-session-1',
                },
            },
        });
        storageSessionsState.current = { [fullSession.id]: fullSession };
        const rowSession = {
            ...fullSession,
            metadata: {
                path: '/workspace/repo',
                homeDir: '/Users/agent',
                host: 'host',
                flavor: 'codex',
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
                onNativeContextMenuOpenChange={vi.fn()}
            />,
        );

        const contextMenu = screen.tree.root.findByType('ContextMenu' as React.ElementType);
        await act(async () => {
            await contextMenu.props.onSelect('session.copyDebugInformation');
        });

        expect(Clipboard.setStringAsync).toHaveBeenCalledWith([
            'Happier session ID: sess_debug_full',
            'agentInput.agent.codex session ID: codex-session-1',
            'Happier logs: /tmp/happier/session.log',
        ].join('\n'));
    });

    it('suppresses the release press after a native context menu is opened externally', async () => {
        vi.useFakeTimers();

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

        const itemPressable = screen.findHostByTestId('session-list-item-sess_1');
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

    it('keeps the iOS long-press for the row menu even when the row can be carried (K1)', async () => {
        vi.useFakeTimers();

        const SessionItem = await importSessionItem();

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
                dragEnabled
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        const itemPressable = screen.findHostByTestId('session-list-item-sess_2');
        if (!itemPressable) throw new Error('expected carryable session pressable');
        expect(itemPressable.props.onLongPress).toEqual(expect.any(Function));
        expect(onNativeContextMenuOpenChange).not.toHaveBeenCalled();
    });

    it('suppresses the post-carry row press after a whole-row desktop carry', async () => {
        vi.useFakeTimers();
        platformState.os = 'web';
        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_reorder_drag',
            active: true,
            metadata: null,
        });

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
                dragEnabled
                isBeingDragged={true}
            />,
        );

        await act(async () => {
            vi.advanceTimersByTime(700);
        });

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
                    dragEnabled
                    isBeingDragged={false}
                />,
            );
        });

        const itemPressable = screen.findHostByTestId('session-list-item-sess_reorder_drag');
        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });

        expect(navigateToSessionSpy).not.toHaveBeenCalled();

        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });

        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_reorder_drag', { serverId: 'server_a' });
    });

    it('opens the iOS native context menu from a press-in timer before release', async () => {
        vi.useFakeTimers();

        const SessionItem = await importSessionItem();

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
                dragEnabled={false}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        const itemPressable = screen.findHostByTestId('session-list-item-sess_press_in');
        if (!itemPressable) throw new Error('expected native long-press session pressable');
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

    it('adds Android ripple feedback to the session row pressable', async () => {
        platformState.os = 'android';

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
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const itemPressable = screen.findHostByTestId('session-list-item-sess_3');
        if (!itemPressable) throw new Error('expected Android session pressable');
        expect(itemPressable.props.android_ripple).toMatchObject({
            borderless: false,
            foreground: true,
        });
    });

    it('closes the native context menu before delegating rename to the shared action handler', async () => {
        const SessionItem = await importSessionItem();
        const session = createSessionFixture({
            id: 'sess_rename',
            metadata: {
                name: 'Old Session',
                serverId: 'server_a',
                path: '/repo',
                host: 'devbox',
            },
        });
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
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
                serverId="server_a"
            />,
        );

        const contextMenu = screen.findByType('ContextMenu' as any);
        await act(async () => {
            contextMenu.props.onSelect(SESSION_ACTION_RENAME_ID);
        });

        expect(onNativeContextMenuOpenChange).toHaveBeenCalledWith(false);
        expect(modalPromptSpy).toHaveBeenCalled();
        expect(sessionRenameSpy).toHaveBeenCalledWith('sess_rename', 'Renamed Session', { serverId: 'server_a' });
    });

    it('does not show selection checkboxes merely on hover', async () => {
        platformState.os = 'web';
        const SessionItem = await importSessionItem();
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
        expect(navigateToSessionSpy).not.toHaveBeenCalled();
    });

    it('adds a web more-menu Select entry that enters selection mode for the row', async () => {
        platformState.os = 'web';
        const SessionItem = await importSessionItem();
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

    it('tracks keyboard focus independently from the selected row', async () => {
        platformState.os = 'web';
        const SessionItem = await importSessionItem();
        const keys = ['server_a:first', 'server_a:second'] as const;
        const store = createSessionListSelectionStore({ scopeKey: 'scope-a', visibleOrderedKeys: keys });
        store.replaceWith(keys[0]);
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={keys} store={store}>
                <SessionItem session={createSessionFixture({ id: 'second' })}
                    serverId="server_a" selectionKey={keys[1]} />
            </SessionListSelectionProvider>,
        );
        const row = screen.findByProps({ testID: 'session-list-item-second' });
        await act(async () => { row.props.onFocus?.(); });
        expect(store.getSnapshot().focusedKey).toBe(keys[1]);
        expect(Array.from(store.getSnapshot().selectedKeys)).toEqual([keys[0]]);
    });

    it('keeps touch long-press as a menu, whose Select item enters selection', async () => {
        const SessionItem = await importSessionItem();
        const selectionKey = 'server_a:sess_touch_select';
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={[selectionKey]}>
                <SessionItem session={createSessionFixture({ id: 'sess_touch_select' })}
                    serverId="server_a" selectionKey={selectionKey} />
            </SessionListSelectionProvider>,
        );
        const row = screen.findByProps({ testID: 'session-list-item-sess_touch_select' });
        await act(async () => { row.props.onLongPress(); });
        expect(screen.tree.root.findAllByProps({ testID: 'session-list-selection-checkbox-sess_touch_select' })).toHaveLength(0);
        await act(async () => { row.props.onPress(); });
        expect(navigateToSessionSpy).not.toHaveBeenCalled();
        const menu = screen.findByType('ContextMenu' as React.ElementType);
        expect(hasSelectMenuItem(menu.props.items)).toBe(true);
        await act(async () => { menu.props.onSelect('selection.select'); });
        expect(screen.findByProps({ testID: 'session-list-selection-checkbox-sess_touch_select' }).props.accessibilityState.checked).toBe(true);
    });

    it('offers fork in the session row dropdown without a subtitle and opens the shared fork flow', async () => {
        platformState.os = 'web';
        const SessionItem = await importSessionItem();
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

        const hoverContainer = screen.tree.root.findAll((node) => typeof node.props.onPointerEnter === 'function')[0];
        await act(async () => hoverContainer?.props.onPointerEnter());
        const dropdown = screen.tree.root.findByType('DropdownMenu' as React.ElementType);
        const forkItem = dropdown.props.items.find((item: { id: string }) => item.id === 'session.fork');

        expect(forkItem).toMatchObject({
            id: 'session.fork',
            title: 'sessionInfo.forkSession',
            subtitle: undefined,
        });
        await vi.waitFor(() => expect(sessionForkFlowModuleLoadedSpy).toHaveBeenCalledTimes(1));

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
});
