import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));
vi.mock('@/components/onboarding', () => ({
    OnboardingWizardSurface: () => null,
    PreAuthOnboardingWizardEntry: () => null,
}));
vi.mock('@/components/onboarding/PreAuthOnboardingWizardEntry', () => ({
    PreAuthOnboardingWizardEntry: () => null,
}));
vi.mock('@/components/onboarding/surfaces/SetupWizardSurface', () => ({
    SetupWizardSurface: (props: any) => React.createElement('SetupWizardSurface', props),
}));
vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: (props: any) => React.createElement('BaseModal', props, props.children),
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
vi.mock('react-native-safe-area-context', () => ({
    initialWindowMetrics: { insets: { top: 24, bottom: 12, left: 0, right: 0 } },
    useSafeAreaInsets: () => ({ top: 24, bottom: 12, left: 0, right: 0 }),
}));

const expoRouterMock = createExpoRouterMock({
    router: { push: vi.fn(), replace: vi.fn() },
});
vi.mock('expo-router', () => expoRouterMock.module);

const tauriDesktopState = vi.hoisted(() => ({ value: true }));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

let isAuthenticated = true;
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated,
    }),
}));

vi.mock('@/components/navigation/shell/MainView', () => ({
    MainView: () => null,
}));

vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useConnectionHealth: () => ({ onlineCount: 0 }),
}));

vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => ({
        status: {
            serviceInstalled: false,
            daemonRunning: false,
            needsAuth: true,
            machineId: null,
        },
    }),
}));

vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => null,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: vi.fn(async () => ({ status: 'ready', features: { capabilities: { auth: { methods: [] } } } })),
}));

const getPendingSetupIntentMock = vi.hoisted(() => vi.fn<() => PendingSetupIntent | null>(() => ({
    branch: 'thisComputer',
    phase: 'awaiting_auth',
    relayUrl: 'https://relay.example.test',
})));
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    clearPendingSetupIntent: vi.fn(),
    setPendingSetupIntent: vi.fn(),
}));

describe('/ (welcome) setup continuation on native', () => {
    beforeEach(() => {
        isAuthenticated = true;
        tauriDesktopState.value = true;
        getPendingSetupIntentMock.mockReset();
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders setup continuation inside BaseModal on native (no bespoke overlay wrapper)', async () => {
        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(screen.findByTestId('setupWizard.nativeOverlay')).toBeNull();

        const modals = screen.findAllByType('BaseModal' as never);
        expect(modals).toHaveLength(1);
        const modal = modals[0]!;
        expect(modal.props.visible).toBe(true);
        expect(modal.props.showBackdrop).toBe(true);
        expect(modal.props.closeOnBackdrop).toBe(false);

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(1);
    });
});
