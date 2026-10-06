import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainAccountEncryptionCurrentnessFixture, createRootLayoutFeaturesResponse, pressTestInstanceAsync, renderScreen as renderCanonicalScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionCurrentProjectionRecordV1Schema, SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol';
import { createModelBackedSessionItemTestComponent } from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { SessionListSelectionProvider, createSessionListSelectionStore } from './selection/SessionListSelectionContext';
import { SESSION_ACTION_RENAME_ID } from '@/components/sessions/actions/sessionActionIds';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalPromptSpy = vi.fn(async () => 'Renamed Session');
const modalShowSpy = vi.fn(() => 'fork-strategy-modal');


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

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

const navigateToSessionSpy = vi.fn();

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'android' | 'web',
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
        const boundary = createReactNativeWebMock();
        return { ...boundary, Platform: { ...boundary.Platform, get OS() { return platformState.os; }, select: (values: Record<string, unknown>) => values[platformState.os] ?? values.default } };
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { navigate: navigateToSessionSpy } }).module;
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
                show: modalShowSpy,
            },
        }).module;
    },
    storage: async (importOriginal) => importOriginal(),
});

vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
let previousStorageState: ReturnType<typeof storage.getState>;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let wireSession: ReturnType<typeof SessionCurrentProjectionRecordV1Schema.parse> | undefined;
const metadataRequests: Array<{ url: string; patch: ReturnType<typeof SessionMetadataTuplePatchV1Schema.parse> }> = [];

async function renderScreen(element: Parameters<typeof renderCanonicalScreen>[0]) {
    return renderCanonicalScreen(element);
}

// Collect the real owner before test execution. A cold graph transform inside
// a timed test can finish after cleanup and contaminate the next renderer.
const { SessionItem } = await import('./SessionItem');
const ModelBackedSessionItem = createModelBackedSessionItemTestComponent(SessionItem);
async function importSessionItem() {
    return function AuthenticatedSessionItem(props: React.ComponentProps<typeof ModelBackedSessionItem>) {
        return <InjectedAuthProvider credentials={account.credentials}><ModelBackedSessionItem {...props} /></InjectedAuthProvider>;
    };
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
    beforeEach(async () => {
        previousStorageState = storage.getState();
        metadataRequests.length = 0;
        wireSession = undefined;
        account = await restoreServerAccountForTest({ serverUrl: 'https://server_a', accountId: 'row-account', request: async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v2/sessions/sess_rename' && wireSession) {
                if (init?.method === 'PATCH') {
                    const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
                    metadataRequests.push({ url: url.href, patch });
                    if (patch.mode === 'shared_editor') {
                        expect(patch.sharedMetadata.expectedVersion).toBe(wireSession.metadataVersion);
                        wireSession = SessionCurrentProjectionRecordV1Schema.parse({ ...wireSession, metadata: patch.sharedMetadata.ciphertext, metadataVersion: wireSession.metadataVersion + 1 });
                    } else {
                        if (patch.mode === 'owner_migration') {
                            expect(patch.source.metadata).toEqual({ version: wireSession.metadataVersion, ciphertext: wireSession.metadata });
                            expect(patch.source.agentState).toEqual({ version: wireSession.agentStateVersion, ciphertext: wireSession.agentState });
                        } else {
                            expect(patch.sharedMetadata.expectedVersion).toBe(wireSession.metadataVersion);
                            expect(patch.expectedOwnerMetadata).toEqual(wireSession.ownerMetadata);
                        }
                        const target = patch.mode === 'owner_migration' ? patch.target : patch;
                        wireSession = SessionCurrentProjectionRecordV1Schema.parse({ ...wireSession, metadataLayoutVersion: 1,
                            metadata: target.sharedMetadata.ciphertext, ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext,
                            metadataVersion: wireSession.metadataVersion + 1, agentStateVersion: wireSession.agentStateVersion + 1 });
                    }
                    return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                        sharedMetadata: { version: wireSession.metadataVersion }, agentState: { version: wireSession.agentStateVersion } }));
                }
                return Response.json({ session: wireSession });
            }
            return Response.json({}, { status: 404 });
        } });
        storage.setState({ sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {} });
    });
    afterEach(async () => {
        standardCleanup();
        navigateToSessionSpy.mockClear();
        modalPromptSpy.mockClear();
        modalShowSpy.mockClear();
        platformState.os = 'ios';
        vi.useRealTimers();
        await account.dispose();
        storage.setState(previousStorageState, true);
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
        storage.getState().applyLocalSettings({ devModeEnabled: true }, { persist: false });
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
        storage.getState().applyLocalSettings({ devModeEnabled: true }, { persist: false });
        const SessionItem = await importSessionItem();
        const fullSession = createSessionFixture({
            id: 'sess_debug_full',
            serverId: 'server_a',
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
        storage.getState().applySessions([fullSession]);
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

        expect(navigateToSessionSpy).toHaveBeenCalledWith('/session/sess_1', expect.objectContaining({ dangerouslySingular: expect.any(Function) }));
    });

    it('keeps the iOS long-press for the row menu even when the row can be carried (K1)', async () => {
        vi.useFakeTimers();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
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

        expect(navigateToSessionSpy).toHaveBeenCalledWith('/session/sess_reorder_drag?serverId=server_a', expect.objectContaining({ dangerouslySingular: expect.any(Function) }));
    });

    it('opens the iOS native context menu from a press-in timer before release', async () => {
        vi.useFakeTimers();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
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
            serverId: account.home.id,
            metadata: {
                name: 'Old Session',
                serverId: 'server_a',
                path: '/repo',
                host: 'devbox',
            },
        });
        storage.getState().applySessions([session]);
        wireSession = SessionCurrentProjectionRecordV1Schema.parse({ ...session,
            metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata), agentState: null, ownerMetadata: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
            responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
            dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
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
        await vi.waitFor(() => expect(metadataRequests.length).toBeGreaterThan(0));
        expect(metadataRequests.every((request) => request.url.startsWith(`${account.home.serverUrl}/v2/sessions/sess_rename`))).toBe(true);
        expect(JSON.parse(wireSession!.metadata).summary.text).toBe('Renamed Session');
        await vi.waitFor(() => expect(storage.getState().sessions.sess_rename.metadataVersion).toBe(wireSession!.metadataVersion));
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
            serverId: 'server_a',
            active: true,
            metadata: {
                flavor: 'claude',
                machineId: 'machine_a',
                path: '/workspace/project',
                host: 'host-a',
            },
        });
        storage.getState().applySessions([session]);

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
        await act(async () => {
            await dropdown.props.onSelect('session.fork');
        });

        await vi.waitFor(() => expect(modalShowSpy).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({ request: expect.objectContaining({
                parentSessionId: 'sess_fork', serverId: account.home.id, machineId: 'machine_a', forkPoint: { type: 'latest' },
            }), availability: expect.objectContaining({ replay: true }) }),
            chrome: expect.objectContaining({ testID: 'session-fork-strategy-modal' }),
            closeOnBackdrop: false,
        })));
    });
});
