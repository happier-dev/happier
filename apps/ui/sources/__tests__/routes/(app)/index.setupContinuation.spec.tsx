import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));
vi.mock('@/components/onboarding', () => ({
    OnboardingWizardSurface: () => null,
    PreAuthOnboardingWizardEntry: () => null,
    resolvePostAuthSetupRoute: () => '/',
}));
vi.mock('@/components/onboarding/PreAuthOnboardingWizardEntry', () => ({
    PreAuthOnboardingWizardEntry: () => null,
}));
vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: (props: any) => React.createElement('BaseModal', props, props.children),
}));

function installStubbedSetupWizardSurface() {
    vi.doMock('@/components/onboarding/surfaces/SetupWizardSurface', () => ({
        SetupWizardSurface: (props: any) => React.createElement('SetupWizardSurface', props),
    }));
}

installStubbedSetupWizardSurface();

const applyLocalSettingsSpy = vi.hoisted(() => vi.fn());
vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => applyLocalSettingsSpy,
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

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
    MainView: (props: Record<string, unknown>) => React.createElement('MainView', props),
}));

vi.mock('@/components/navigation/shell/HomeHeader', () => ({
    HomeHeaderNotAuth: () => null,
}));

const pendingTerminalConnectState = vi.hoisted(() => ({
    value: null as null | { publicKeyB64Url: string; serverUrl: string },
}));
vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => pendingTerminalConnectState.value,
}));

const connectionHealthState = vi.hoisted(() => ({ value: 0 as number }));
vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useConnectionHealth: () => ({ onlineCount: connectionHealthState.value }),
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

const getPendingSetupIntentMock = vi.hoisted(() => vi.fn<() => PendingSetupIntent | null>(() => ({
    branch: 'thisComputer',
    phase: 'awaiting_auth',
    relayUrl: 'https://relay.example.test',
})));
const clearPendingSetupIntentMock = vi.hoisted(() => vi.fn());
const setPendingSetupIntentMock = vi.hoisted(() => vi.fn<(value: PendingSetupIntent) => void>());
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    clearPendingSetupIntent: clearPendingSetupIntentMock,
    setPendingSetupIntent: setPendingSetupIntentMock,
}));

describe('/ (welcome) setup continuation', () => {
    beforeEach(() => {
        vi.resetModules();
        installStubbedSetupWizardSurface();
        isAuthenticated = true;
        tauriDesktopState.value = true;
        connectionHealthState.value = 0;
        pendingTerminalConnectState.value = null;
        getPendingSetupIntentMock.mockReset();
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        clearPendingSetupIntentMock.mockReset();
        setPendingSetupIntentMock.mockReset();
        applyLocalSettingsSpy.mockReset();
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

    it('renders the real web setup wizard overlay on / without crashing', async () => {
        tauriDesktopState.value = false;
        vi.doMock('@/components/onboarding/surfaces/SetupWizardSurface', async () => {
            return await vi.importActual<typeof import('@/components/onboarding/surfaces/SetupWizardSurface')>(
                '@/components/onboarding/surfaces/SetupWizardSurface',
            );
        });

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
        expect(screen.findByTestId('setupWizard.surface')).toBeTruthy();
        expect(screen.findByTestId('setupWizard-web-machine-setup-handoff-terminal')).toBeTruthy();
    });

    it('mounts the authenticated home shell on web when no post-auth setup wizard is needed', async () => {
        tauriDesktopState.value = false;
        connectionHealthState.value = 1;
        getPendingSetupIntentMock.mockReturnValue(null);

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(screen.findAllByType('MainView' as never)).toHaveLength(1);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
    });

    it('opens the setup wizard in a modal on web (overlay owns scrolling + placement)', async () => {
        tauriDesktopState.value = false;

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        const modal = screen.findByType('BaseModal' as never);
        const surface = screen.findByType('SetupWizardSurface' as never);
        expect(surface.props.useOuterScrollContainer).toBe(true);
        expect(modal.props.showBackdrop).toBe(true);
    });

    it('skips the post-auth setup wizard on web when another machine is already online (clears pending continuation)', async () => {
        tauriDesktopState.value = false;
        connectionHealthState.value = 1;

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(clearPendingSetupIntentMock).toHaveBeenCalledTimes(1);
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

    it('does not auto-open the setup wizard overlay when the user dismissed it previously (phase=dismissed)', async () => {
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'https://relay.example.test',
        });

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
    });

    it('auto-opens the setup wizard overlay on desktop when this machine is not configured and no pending setup intent exists', async () => {
        getPendingSetupIntentMock.mockReturnValue(null);
        localDaemonStatus.value = {
            serviceInstalled: false,
            daemonRunning: false,
            needsAuth: true,
            machineId: null,
        };

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(1);
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith(expect.objectContaining({ phase: 'post_auth' }));
    });

    it('marks the setup wizard as dismissed on exit so it does not immediately re-open', async () => {
        setPendingSetupIntentMock.mockImplementation((value) => {
            getPendingSetupIntentMock.mockReturnValue(value);
        });

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        const wizard = screen.findByType('SetupWizardSurface' as never);
        expect(wizard).not.toBeNull();
        expect(typeof wizard.props.onExit).toBe('function');

        act(() => {
            wizard.props.onExit();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(clearPendingSetupIntentMock).not.toHaveBeenCalled();
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith(expect.objectContaining({ phase: 'dismissed' }));
        expect(applyLocalSettingsSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionGettingStartedGuidanceDismissed: true }));
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
    });

    it('auto-opens the setup wizard overlay on desktop when the current machine is not configured and there is no pending setup intent', async () => {
        getPendingSetupIntentMock.mockReturnValue(null);

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 3 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(1);
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith(expect.objectContaining({ phase: 'post_auth', branch: 'thisComputer' }));
    });

    it('does not auto-open the setup wizard overlay on web when at least one machine is online and there is no pending setup intent', async () => {
        tauriDesktopState.value = false;
        connectionHealthState.value = 1;
        getPendingSetupIntentMock.mockReturnValue(null);
        localDaemonStatus.value = {
            serviceInstalled: false,
            daemonRunning: false,
            needsAuth: true,
            machineId: null,
        };

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 3 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
    });

    it('does not open the post-auth setup wizard while a terminal connect approval is pending', async () => {
        tauriDesktopState.value = false;
        pendingTerminalConnectState.value = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://relay.example.test',
        };

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 3 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(setPendingSetupIntentMock).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'post_auth' }));
    });
});
