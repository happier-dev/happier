import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerId, removeServerProfile, resolveServerProfileScopeId, setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { dismissPendingSetupIntent } from '@/sync/domains/pending/dismissPendingSetupIntent';
import { clearPendingSetupIntent, getPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async (_text: string) => {}),
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: null, manifest: null },
}));

vi.mock('expo-updates', () => ({
    channel: null,
    releaseChannel: null,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));

vi.mock('expo-image', () => ({
    Image: (props: any) => React.createElement('Image', props, null),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props, null),
}));

const routerMockState = vi.hoisted(() => ({
    push: vi.fn(),
    useRouterCalls: 0,
}));

vi.mock('@/config', () => ({
    config: { variant: 'production', cliNpmDistTag: undefined },
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerMockState.push } }).module;
});

installDisconnectedServerSocketBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const terminalConnection = await import('@/hooks/session/useConnectTerminal');
const connectTerminalHook = vi.spyOn(terminalConnection, 'useConnectTerminal');

describe('SessionGettingStartedGuidance (desktop-only setup CTA)', () => {
    const initialStorageState = storage.getState();
    const initialServerId = getActiveServerId();
    let fixtureHomeId: string;
    beforeEach(async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        vi.stubGlobal('__TAURI__', undefined);
        vi.stubGlobal('isTauri', false);
        connectTerminalHook.mockClear();
        routerMockState.push.mockClear();
        routerMockState.useRouterCalls = 0;
        const home = await upsertServerProfile({ serverUrl: 'https://guidance.example.test', name: 'Guidance Home' });
        fixtureHomeId = home.id;
        await setActiveServerId(home.id);
        const serverId = resolveServerProfileScopeId(home);
        storage.setState({ ...initialStorageState, profileScope: { serverId, accountId: 'guidance-account' }, settingsScope: { serverId, accountId: 'guidance-account' },
            sessionListIndexByServerId: { [serverId]: [] }, machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } }, true);
    });
    afterEach(async () => {
        standardCleanup();
        clearPendingSetupIntent();
        await setActiveServerId(initialServerId);
        await removeServerProfile(fixtureHomeId);
        storage.setState(initialStorageState, true);
        vi.unstubAllGlobals();
    });

    it('shows the Open setup CTA on web surfaces', async () => {
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const screen = await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />);
        const tree: renderer.ReactTestRenderer = screen.tree;
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
        expect(connectTerminalHook).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('session-getting-started-open-setup');
        expect(routerMockState.push).toHaveBeenCalledWith('/settings/machines/add?path=thisComputer');
    });

    it('shows the Open setup CTA on Tauri desktop', async () => {
        // Desktop identity is read by the real host adapter from the shell boundary.
        vi.stubGlobal('isTauri', true);
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
    });

    it('keeps the setup action on the empty state after the user chose "I\'ll do this later" (never a blank pane)', async () => {
        dismissPendingSetupIntent();
        expect(getPendingSetupIntent()?.phase).toBe('dismissed');
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        for (const variant of ['sidebar', 'primaryPane'] as const) {
            const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant={variant} />)).tree;
            expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
        }
    });
});
