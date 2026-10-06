import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionGuidanceCommonModuleMocks } from './sessionGuidanceTestHelpers';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerId, removeServerProfile, resolveServerProfileScopeId, setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

const tauriState = vi.hoisted(() => ({
    desktop: false,
}));

const connectTerminalHookState = vi.hoisted(() => ({
    calls: 0,
}));

const routerMockState = vi.hoisted(() => ({
    push: vi.fn(),
    useRouterCalls: 0,
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => tauriState.desktop,
}));

vi.mock('@/config', () => ({
    config: { variant: 'production', cliNpmDistTag: undefined },
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => {
        connectTerminalHookState.calls += 1;
        return {
            connectTerminal: () => {},
            connectWithUrl: () => {},
            isLoading: false,
        };
    },
}));

installSessionGuidanceCommonModuleMocks({
    storage: () => vi.importActual('@/sync/domains/state/storage'),
    router: () => ({
        router: { push: routerMockState.push },
        useRouter: () => {
            routerMockState.useRouterCalls += 1;
            return { push: routerMockState.push };
        },
    }),
});

describe('SessionGettingStartedGuidance (desktop-only setup CTA)', () => {
    const initialStorageState = storage.getState();
    const initialServerId = getActiveServerId();
    let fixtureHomeId: string;
    beforeEach(async () => {
        connectTerminalHookState.calls = 0;
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
        await setActiveServerId(initialServerId);
        await removeServerProfile(fixtureHomeId);
        storage.setState(initialStorageState, true);
    });

    it('shows the Open setup CTA on web surfaces', async () => {
        tauriState.desktop = false;
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const screen = await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />);
        const tree: renderer.ReactTestRenderer = screen.tree;
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
        expect(connectTerminalHookState.calls).toBe(0);
        await screen.pressByTestIdAsync('session-getting-started-open-setup');
        expect(routerMockState.push).toHaveBeenCalledWith('/settings/machines/add?path=thisComputer');
    });

    it('shows the Open setup CTA on Tauri desktop', async () => {
        tauriState.desktop = true;
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
    });

    it('keeps the setup action on the empty state after the user chose "I\'ll do this later" (never a blank pane)', async () => {
        tauriState.desktop = false;
        storage.getState().applyLocalSettings({ sessionGettingStartedGuidanceDismissed: true });
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        for (const variant of ['sidebar', 'primaryPane', 'newSessionBlocking'] as const) {
            const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant={variant} />)).tree;
            expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
        }
    });
});
