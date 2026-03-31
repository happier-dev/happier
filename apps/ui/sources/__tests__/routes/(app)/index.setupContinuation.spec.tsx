import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));
vi.mock('@/components/onboardingWizard', () => ({
    OnboardingWizardSurface: () => null,
}));
vi.mock('@/components/onboardingWizard/PreAuthOnboardingWizardEntry', () => ({
    PreAuthOnboardingWizardEntry: () => null,
}));
vi.mock('@/components/onboardingWizard/SetupWizardSurface', () => ({
    SetupWizardSurface: () => React.createElement('SetupWizardSurface'),
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

vi.mock('@/components/navigation/shell/HomeHeader', () => ({
    HomeHeaderNotAuth: () => null,
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useConnectionHealth: () => ({ onlineCount: 0 }),
}));

const localDaemonStatus = vi.hoisted(() => ({
    value: {
        serviceInstalled: false,
        daemonRunning: false,
        needsAuth: true,
        machineId: null as string | null,
    },
}));
vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => ({
        status: localDaemonStatus.value,
    }),
}));

vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => null,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: vi.fn(async () => ({ status: 'ready', features: { capabilities: { auth: { methods: [] } } } })),
}));

const getPendingSetupIntentMock = vi.hoisted(() => vi.fn(() => ({
    branch: 'thisComputer',
    phase: 'awaiting_auth',
    relayUrl: 'https://relay.example.test',
})));
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    clearPendingSetupIntent: vi.fn(),
    setPendingSetupIntent: vi.fn(),
}));

describe('/ (welcome) setup continuation', () => {
    beforeEach(() => {
        isAuthenticated = true;
        tauriDesktopState.value = true;
        localDaemonStatus.value = {
            serviceInstalled: false,
            daemonRunning: false,
            needsAuth: true,
            machineId: null,
        };
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('keeps authenticated Tauri desktop users on / and opens the setup wizard overlay when a setup auth continuation is pending', async () => {
        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(1);
    });

    it('keeps authenticated browser web users on / and opens the setup wizard overlay when a setup auth continuation is pending', async () => {
        tauriDesktopState.value = false;

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(1);
    });

    it('does not open the setup wizard overlay when the setup wizard was skipped before authentication', async () => {
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'pre_auth',
            relayUrl: 'https://relay.example.test',
        });
        localDaemonStatus.value = {
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-1',
        };

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
    });
});
