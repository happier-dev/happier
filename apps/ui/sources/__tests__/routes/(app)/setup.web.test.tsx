import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, renderScreen, standardCleanup } from '@/dev/testkit';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';

const expoRouterMock = createExpoRouterMock({
    router: {
        push: vi.fn(),
        replace: vi.fn(),
    },
});
const relayDriftBannerMock = vi.hoisted(() => vi.fn());
const clearPendingSetupIntentMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ScrollView: 'ScrollView',
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options?.web ?? options?.default,
        },
    });
});

vi.mock('expo-router', () => expoRouterMock.module);

let isAuthenticated = false;
let activeServerSnapshot = {
    serverId: 'relay-1',
    serverUrl: 'https://relay.example.test/',
    generation: 1,
};
const activeServerListeners = new Set<() => void>();
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated,
    }),
}));

const getPendingSetupIntentMock = vi.fn<() => PendingSetupIntent | null>(() => null);
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    setPendingSetupIntent: vi.fn(),
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    clearPendingSetupIntent: clearPendingSetupIntentMock,
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/server/serverProfiles')>('@/sync/domains/server/serverProfiles');
    return {
        ...actual,
        getActiveServerSnapshot: () => activeServerSnapshot,
    };
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    subscribeActiveServer: (listener: () => void) => {
        activeServerListeners.add(listener);
        return () => {
            activeServerListeners.delete(listener);
        };
    },
}));

vi.mock('@/components/navigation/shell/HomeHeader', () => ({
    HomeHeaderNotAuth: () => null,
}));

vi.mock('@/components/settings/server/localControl/LocalRelayRuntimeControlSection', () => ({
    LocalRelayRuntimeControlSection: (props: Record<string, unknown>) => React.createElement('LocalRelayRuntimeControlSection', props),
}));
vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: Record<string, unknown>) => React.createElement('RelayDriftActionCard', props),
}));
vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => relayDriftBannerMock(),
}));

vi.mock('@/components/systemTasks', () => ({
    SystemTaskProgressCard: (props: Record<string, unknown>) => React.createElement('SystemTaskProgressCard', props),
    getDefaultSystemTaskRunner: () => ({ mode: 'unavailable', start: async () => '', cancel: async () => {}, subscribe: async () => () => {} }),
}));
vi.mock('@/components/systemTasks/useThisComputerSetupTask', () => ({
    useThisComputerSetupTask: () => ({
        activeTaskSnapshot: null,
        cancel: async () => {},
        completedMachineId: null,
        start: async () => {},
        startError: null,
    }),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('Group', { title }, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));
vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('/setup route web gating', () => {
    beforeEach(() => {
        isAuthenticated = false;
        activeServerSnapshot = {
            serverId: 'relay-1',
            serverUrl: 'https://relay.example.test/',
            generation: 1,
        };
        activeServerListeners.clear();
        getPendingSetupIntentMock.mockReset();
        getPendingSetupIntentMock.mockReturnValue(null);
        clearPendingSetupIntentMock.mockReset();
        relayDriftBannerMock.mockReset();
        relayDriftBannerMock.mockReturnValue(null);
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('shows a desktop-only notice on browser web instead of the setup flow', async () => {
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findByTestId('setup.desktopOnlyNotice')).toBeTruthy();
        expect(screen.findByTestId('setup.web.activeRelay')).toBeTruthy();
        expect(screen.findByTestId('setup.preAuth.intro')).toBeNull();
        expect(screen.findByTestId('setup.currentRelay')).toBeNull();
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
        expect(screen.findByTestId('setup.continueToAuth')).toBeNull();
        expect(screen.findByTestId('setup.discard')).toBeNull();
    });

    it('shows only the desktop-only notice when authenticated on browser web and clears pending setup intent', async () => {
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });
        relayDriftBannerMock.mockReturnValue({
            kind: 'warning',
            title: 'Your background service is connected to a different Relay',
            description: 'App: relay-a · Background service: relay-b',
            actionLabel: 'Connect background service to this Relay',
            onPress: vi.fn(),
            isRepairStarting: false,
            repairTaskSnapshot: null,
            onCancelRepair: vi.fn(),
        });

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findByTestId('setup.desktopOnlyNotice')).toBeTruthy();
        expect(screen.findByTestId('setup.web.activeRelay')).toBeTruthy();
        expect(screen.findByTestId('setup.postAuth')).toBeNull();
        expect(screen.findByTestId('setup.summary.activeRelay')).toBeNull();
        expect(screen.findByTestId('setup.summary.thisComputer')).toBeNull();
        expect(screen.findByTestId('setup.summary.nextAction')).toBeNull();
        expect(screen.findByTestId('setup.webRelayDriftNotice')).toBeNull();
        expect(screen.findAllByType('MachineSetupFlowScreen' as never)).toHaveLength(0);
        expect(screen.findAllByType('RelayDriftActionCard' as never)).toHaveLength(0);
        expect(clearPendingSetupIntentMock).toHaveBeenCalledTimes(1);
    });
});
