import React from 'react';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserClipboardBoundary } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';

import { SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { SESSION_ACTION_RENAME_ID } from '@/components/sessions/actions/sessionActionIds';
import { SESSION_ROW_ACTION_SELECT_ID } from './row/actionMenu/sessionRowActionMenuTypes';



import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';



(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;



vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

const modalPromptSpy = vi.fn(async () => 'Renamed Session');
const modalShowSpy = vi.fn(() => 'fork-strategy-modal');


vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
}));

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));

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
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
    useIsTablet: () => false,
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const boundary = await createReactNativeWebMock();
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
// Install platform/router options before any renderer or selection consumer can
// cache the common helper's default web boundary.
const { createPlainAccountEncryptionCurrentnessFixture, createRootLayoutFeaturesResponse, pressTestInstanceAsync, renderScreen: renderCanonicalScreen, standardCleanup } = await import('@/dev/testkit');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { createModelBackedSessionItemTestComponent } = await import('./sessionItemRowViewModelTestFixture');
const { SessionListSelectionProvider, createSessionListSelectionStore } = await import('./selection/SessionListSelectionContext');
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const {
    SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID,
    SESSION_COPY_ID_MENU_ITEM_ID,
    SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID,
} = await import('@/components/sessions/debug/sessionDebugClipboard');
const { SESSION_COPY_MENU_ITEM_ID } = await import('@/components/sessions/debug/sessionDebugMenuItem');
let previousStorageState: ReturnType<typeof storage.getState>;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let wireSession: ReturnType<typeof SessionCurrentProjectionRecordV1Schema.parse> | undefined;
let restorePopoverWebGlobals: (() => void) | undefined;
const metadataRequests: Array<{ url: string; patch: ReturnType<typeof SessionMetadataTuplePatchV1Schema.parse> }> = [];

async function renderScreen(element: Parameters<typeof renderCanonicalScreen>[0]) {
    // Test Renderer paints popovers inline. Supply the web frame and window ports without a DOM portal target.
    if (platformState.os === 'web') restorePopoverWebGlobals = withPopoverWebGlobals();
    return renderCanonicalScreen(element, {
        createNodeMock: () => ({
            offsetTop: 32,
            offsetHeight: 48,
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
                callback(16, 32, 280, 48),
            getBoundingClientRect: () => ({ x: 16, y: 32, left: 16, top: 32, right: 296, bottom: 80, width: 280, height: 48 }),
        }),
    });
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

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function menuOptionTestId(actionId: string): string {
    return `dropdown-option-${actionId.replaceAll('.', '_')}`;
}

async function pressMenuOption(screen: Screen, actionId: string) {
    const testId = menuOptionTestId(actionId);
    await vi.waitFor(() => expect(screen.findHostByTestId(testId)).toBeTruthy());
    await screen.pressByTestIdAsync(testId);
}

async function openMoreMenu(screen: Screen) {
    const hoverTarget = screen.root.findAll((node) => typeof node.props.onPointerEnter === 'function')[0];
    await act(async () => { hoverTarget.props.onPointerEnter(); });
    await screen.pressByTestIdAsync('session-item-more-menu');
}

async function openTouchMenu(screen: Screen, sessionId: string) {
    await act(async () => { screen.findHostByTestId(`session-list-item-${sessionId}`)!.props.onLongPress(); });
}

describe('SessionItem context menu press suppression', () => {
    beforeEach(async () => {


        const Clipboard = await import('expo-clipboard');
        vi.mocked(Clipboard.setStringAsync).mockReset();
        vi.mocked(Clipboard.setStringAsync).mockResolvedValue(true);
        installBrowserClipboardBoundary(async text => { await Clipboard.setStringAsync(text); });
        previousStorageState = storage.getState();
        metadataRequests.length = 0;
        wireSession = undefined;
        account = await restoreServerAccountForTest({ serverUrl: 'https://server_a', accountId: 'row-account', request: createSessionReadBatchFetchBoundary(async (input, init) => {
            const url = new URL(String(input));


                if (url.pathname === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'row-account' }));
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
                        if (wireSession.agentStateVersion === undefined) {
                            throw new Error('Metadata mutation fixture requires an Agent state version');
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
            const bootstrapResponse = createEmptyAccountBootstrapHttpResponse(url.pathname, init);
                if (bootstrapResponse) return bootstrapResponse;
                return Response.json({ error: 'not_found' }, { status: 404 });
        }) });
        await vi.waitFor(() => expect(storage.getState().profile.id).toBe('row-account'));
        storage.setState({ sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {} });
    });
    afterEach(async () => {
        standardCleanup();
        restorePopoverWebGlobals?.();
        restorePopoverWebGlobals = undefined;
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
                serverId={account.serverId}
                selected={false}
                compact={false}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        const renameOption = menuOptionTestId(SESSION_ACTION_RENAME_ID);
        expect(screen.findHostByTestId(renameOption)).toBeNull();

        await screen.update(
            <SessionItem
                session={session}
                serverId={account.serverId}
                selected={false}
                compact={false}
                nativeContextMenuOpen
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        await vi.waitFor(() => expect(screen.findHostByTestId(renameOption)).toBeTruthy());
    });

    it.each(['ios', 'android', 'web'] as const)('shows copy information with developer mode disabled on %s', async (platform) => {
        platformState.os = platform;
        storage.getState().applyLocalSettings({ devModeEnabled: false }, { persist: false });
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
            <SessionItem session={session} serverId={account.serverId} selected={false} compact={false} />,
        );
        const Clipboard = await import('expo-clipboard');
        for (const [itemId, expected] of [
            [SESSION_COPY_ID_MENU_ITEM_ID, session.id],
            [SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID, 'claude-session-1'],
        ]) {
            if (platform === 'web') await openMoreMenu(screen);
            else await openTouchMenu(screen, session.id);
            await pressMenuOption(screen, SESSION_COPY_MENU_ITEM_ID);
            await vi.waitFor(() => expect(screen.findHostByTestId(menuOptionTestId(SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID))).toBeTruthy());

            if (platform === 'web') {
                const testId = menuOptionTestId(itemId);
                await vi.waitFor(() => expect(screen.findHostByTestId(testId)).toBeTruthy());
                await act(async () => {
                    screen.pressByTestId(testId);
                    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(expected);
                });
            } else {
                await pressMenuOption(screen, itemId);
                await vi.waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(expected));
            }
            await vi.waitFor(() => expect(screen.findHostByTestId(menuOptionTestId(SESSION_COPY_MENU_ITEM_ID))).toBeNull());
        }
    });

    it('copies debug information from the full cached session when row metadata is list-projected', async () => {
        const Clipboard = await import('expo-clipboard');
        storage.getState().applyLocalSettings({ devModeEnabled: true }, { persist: false });
        const SessionItem = await importSessionItem();
        const fullSession = createSessionFixture({
            id: 'sess_debug_full',
            serverId: account.serverId,
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
            <SessionItem session={rowSession} serverId={account.serverId} selected={false} compact={false} />,
        );

        await openTouchMenu(screen, rowSession.id);
        await pressMenuOption(screen, SESSION_COPY_MENU_ITEM_ID);
        await pressMenuOption(screen, SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID);
        await vi.waitFor(() => {
            const copied = vi.mocked(Clipboard.setStringAsync).mock.lastCall?.[0];
            expect(copied).toContain('codex-session-1');
            expect(copied).toContain('/tmp/happier/session.log');
        });

        await openTouchMenu(screen, rowSession.id);
        await pressMenuOption(screen, SESSION_COPY_MENU_ITEM_ID);
        await pressMenuOption(screen, SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID);
        await vi.waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('codex-session-1'));
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
                compact={false}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        await act(async () => {
            await screen.update(
                <SessionItem
                    session={session}
                    selected={false}
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
                serverId={account.home.id}
                selected={false}
                compact={false}
                dragEnabled
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        const itemPressable = screen.findHostByTestId('session-list-item-sess_2');
        if (!itemPressable) throw new Error('expected carryable session pressable');
        expect(itemPressable.props.onLongPress).toEqual(expect.any(Function));
        expect(onNativeContextMenuOpenChange).not.toHaveBeenCalled();
        expect(screen.findHostByTestId(menuOptionTestId('entity.mentionInComposer'))).not.toBeNull();
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
                serverId={account.serverId}
                selected={false}
                compact={false}
                dragEnabled
                isBeingDragged={true}
            />,
        );

        await act(async () => {
            vi.advanceTimersByTime(700);
        });

        await act(async () => {
            await screen.update(
                <SessionItem
                    session={session}
                    serverId={account.serverId}
                    selected={false}
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
                path: '/repo',
                host: 'devbox',
            },
        });
        storage.getState().applySessions([session]);
        wireSession = SessionCurrentProjectionRecordV1Schema.parse({ ...session,
            metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata), agentState: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
            responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
            dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
        });
        const onNativeContextMenuOpenChange = vi.fn();

        function RowWithControlledMenu() {
            const [open, setOpen] = React.useState(false);
            return <SessionItem session={session} selected={false} compact={false} serverId={account.home.id}
                nativeContextMenuOpen={open} onNativeContextMenuOpenChange={next => {
                    onNativeContextMenuOpenChange(next);
                    setOpen(next);
                }} />;
        }
        const screen = await renderScreen(<RowWithControlledMenu />);

        await openTouchMenu(screen, session.id);
        onNativeContextMenuOpenChange.mockClear();
        await pressMenuOption(screen, SESSION_ACTION_RENAME_ID);

        await vi.waitFor(() => expect(modalPromptSpy).toHaveBeenCalled());
        expect(onNativeContextMenuOpenChange).toHaveBeenCalledWith(false);
        expect(onNativeContextMenuOpenChange.mock.invocationCallOrder[0]).toBeLessThan(modalPromptSpy.mock.invocationCallOrder[0]!);
        expect(screen.findHostByTestId(menuOptionTestId(SESSION_ACTION_RENAME_ID))).toBeNull();
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
                    serverId={account.serverId}
                    selectionKey={selectionKey}
                    selected={false}
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
                    serverId={account.serverId}
                    selectionKey={selectionKey}
                    selected={false}
                    compact={false}
                />
            </SessionListSelectionProvider>,
        );

        await openMoreMenu(screen);
        await pressMenuOption(screen, SESSION_ROW_ACTION_SELECT_ID);
        await vi.waitFor(() => expect(screen.findHostByTestId('session-list-selection-checkbox-sess_web_select')?.props)
            .toMatchObject({ role: 'checkbox', 'aria-checked': true }));
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
                    serverId={account.serverId} selectionKey={keys[1]} />
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
                    serverId={account.serverId} selectionKey={selectionKey} />
            </SessionListSelectionProvider>,
        );
        const row = screen.findByProps({ testID: 'session-list-item-sess_touch_select' });
        await act(async () => { row.props.onLongPress(); });
        expect(screen.tree.root.findAllByProps({ testID: 'session-list-selection-checkbox-sess_touch_select' })).toHaveLength(0);
        await act(async () => { row.props.onPress(); });
        expect(navigateToSessionSpy).not.toHaveBeenCalled();
        await pressMenuOption(screen, SESSION_ROW_ACTION_SELECT_ID);
        await vi.waitFor(() => expect(screen.findHostByTestId('session-list-selection-checkbox-sess_touch_select')?.props)
            .toMatchObject({ accessibilityRole: 'checkbox', accessibilityState: { checked: true } }));
    });

    it('opens the shared fork flow from the session row dropdown', async () => {
        platformState.os = 'web';
        const SessionItem = await importSessionItem();
        const session = createSessionFixture({
            id: 'sess_fork',
            serverId: account.serverId,
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
                serverId={account.serverId}
                selected={false}
                compact={false}
                forkActionContext={{
                    settings: {},
                    replayEnabled: true,
                    executionRunsEnabled: false,
                }}
            />,
        );

        await openMoreMenu(screen);
        await pressMenuOption(screen, 'session.fork');

        await vi.waitFor(() => expect(modalShowSpy).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({ request: expect.objectContaining({
                parentSessionId: 'sess_fork', serverId: account.home.id, machineId: 'machine_a', forkPoint: { type: 'latest' },
            }), availability: expect.objectContaining({ replay: true }) }),
            chrome: expect.objectContaining({ testID: 'session-fork-strategy-modal' }),
            closeOnBackdrop: false,
        })));
    });
});
