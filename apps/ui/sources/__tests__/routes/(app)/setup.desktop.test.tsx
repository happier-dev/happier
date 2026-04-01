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

const clearPendingSetupIntentMock = vi.hoisted(() => vi.fn());
const getPendingSetupIntentMock = vi.hoisted(() => vi.fn<() => PendingSetupIntent | null>(() => null));
const localDaemonControlMock = vi.hoisted(() => ({
    status: {
        serviceInstalled: true,
        daemonRunning: true,
        needsAuth: false,
        machineId: 'machine-1',
    },
}));

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
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated,
    }),
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    setPendingSetupIntent: vi.fn(),
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    clearPendingSetupIntent: clearPendingSetupIntentMock,
}));

vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useConnectionHealth: () => ({
        onlineCount: 1,
    }),
}));

vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => localDaemonControlMock,
}));

vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => null,
}));

vi.mock('@/components/navigation/shell/HomeHeader', () => ({
    HomeHeaderNotAuth: () => null,
}));

vi.mock('@/components/onboardingWizard/PreAuthOnboardingWizardEntry', () => ({
    PreAuthOnboardingWizardEntry: (props: Record<string, unknown>) => React.createElement('PreAuthOnboardingWizardEntry', props),
}));

vi.mock('@/components/settings/machines/DesktopOnlySetupNotice', () => ({
    DesktopOnlySetupNotice: (props: Record<string, unknown>) => React.createElement('DesktopOnlySetupNotice', props),
}));

vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: Record<string, unknown>) => React.createElement('RelayDriftActionCard', props),
}));

vi.mock('@/components/systemTasks', () => ({
    SystemTaskProgressCard: (props: Record<string, unknown>) => React.createElement('SystemTaskProgressCard', props),
    getDefaultSystemTaskRunner: () => ({ mode: 'unavailable', start: async () => '', cancel: async () => {}, subscribe: async () => () => {} }),
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

describe('/setup route desktop post-auth routing', () => {
    beforeEach(() => {
        isAuthenticated = true;
        clearPendingSetupIntentMock.mockReset();
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
        getPendingSetupIntentMock.mockReset();
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        localDaemonControlMock.status = {
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-1',
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('redirects authenticated desktop users to /setup/wizard', async () => {
        const Screen = (await import('@/app/(app)/setup/index')).default;
        await renderScreen(React.createElement(Screen));

        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/setup/wizard');
    });
});
