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
}));
vi.mock('@/components/onboarding/preAuth/PreAuthOnboardingWizardEntry', () => ({
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

// Canonical predicate for "the account already has a machine (online OR offline)". Mocked
// here — like the sibling store-derived hooks in this file — to drive the machine-existence
// scenarios; the real `useAllMachines()`-backed behavior is covered in index.journeyHinge.spec.
const machineSetupSatisfiedState = vi.hoisted(() => ({ value: false }));
vi.mock('@/components/onboarding/state/useMachineSetupStepSatisfied', () => ({
    useMachineSetupStepSatisfied: () => machineSetupSatisfiedState.value,
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
        machineSetupSatisfiedState.value = false;
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
        globalThis.localStorage?.removeItem('happier.voice.e2e.fixture');
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
        expect(screen.findByTestId('setupWizard-machine-arrival-stack')).toBeTruthy();
    });

    it('mounts the authenticated home shell on web when no post-auth setup wizard is needed', async () => {
        tauriDesktopState.value = false;
        machineSetupSatisfiedState.value = true;
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

    it('skips the post-auth setup wizard on web when a machine already exists (clears pending continuation)', async () => {
        tauriDesktopState.value = false;
        machineSetupSatisfiedState.value = true;

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(clearPendingSetupIntentMock).toHaveBeenCalledTimes(1);
    });

    it('does not auto-open the post-auth setup wizard on web when the account already has an OFFLINE machine (settles the pending continuation)', async () => {
        tauriDesktopState.value = false;
        // No machine is ONLINE (onlineCount stays 0), but one exists offline.
        connectionHealthState.value = 0;
        machineSetupSatisfiedState.value = true;
        // Default beforeEach intent is an awaiting_auth continuation.

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

    it('does not auto-open the setup wizard on desktop when the account already has a machine, even with an unconfigured local daemon', async () => {
        // Binding decision: once ANY machine exists the machine-setup step never
        // auto-displays again — including the desktop local-daemon-health auto-open.
        tauriDesktopState.value = true;
        machineSetupSatisfiedState.value = true;
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
        expect(setPendingSetupIntentMock).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'post_auth' }));
    });

    it('does not auto-open the setup wizard overlay on web when at least one machine exists and there is no pending setup intent', async () => {
        tauriDesktopState.value = false;
        machineSetupSatisfiedState.value = true;
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

    it('does not auto-open the setup wizard overlay on web when a voice e2e fixture query param is present', async () => {
        tauriDesktopState.value = false;
        connectionHealthState.value = 0;
        getPendingSetupIntentMock.mockReturnValue(null);

        // The UI e2e harness drives the voice surface via `?happier_voice_e2e_fixture=...`.
        expoRouterMock.state.router.setParams({ happier_voice_e2e_fixture: 'local_auto_return_listening' });

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 3 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(setPendingSetupIntentMock).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'post_auth' }));
    });

    it('suppresses the setup wizard overlay on web when a voice e2e fixture query param is present, even if a setup auth continuation is pending', async () => {
        tauriDesktopState.value = false;
        connectionHealthState.value = 0;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        expoRouterMock.state.router.setParams({ happier_voice_e2e_fixture: 'local_auto_return_listening' });

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 3 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith(expect.objectContaining({ phase: 'dismissed' }));
    });

    it('does not auto-open the setup wizard overlay on web when a voice e2e fixture is persisted in localStorage', async () => {
        tauriDesktopState.value = false;
        connectionHealthState.value = 0;
        getPendingSetupIntentMock.mockReturnValue(null);
        globalThis.localStorage?.setItem('happier.voice.e2e.fixture', 'local_auto_return_listening');

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 3 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(setPendingSetupIntentMock).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'post_auth' }));
    });

    it('does not open the setup wizard overlay during a voice e2e fixture even when a setup continuation is pending', async () => {
        tauriDesktopState.value = false;
        connectionHealthState.value = 0;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        globalThis.localStorage?.setItem('happier.voice.e2e.fixture', 'local_auto_return_listening');

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 3 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
    });

    it('ignores voice fixture query markers in production without dismissing setup', async () => {
        const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
        const previousDebug = process.env.EXPO_PUBLIC_DEBUG;
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        process.env.EXPO_PUBLIC_DEBUG = '0';
        tauriDesktopState.value = false;
        expoRouterMock.state.router.setParams({ happier_voice_e2e_fixture: 'local_auto_return_listening' });

        try {
            const Screen = (await import('@/app/(app)/index')).default;
            const screen = await renderScreen(React.createElement(Screen));
            await flushHookEffects({ cycles: 1, turns: 3 });

            expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(1);
            expect(setPendingSetupIntentMock).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'dismissed' }));
        } finally {
            (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
            if (previousDebug === undefined) delete process.env.EXPO_PUBLIC_DEBUG;
            else process.env.EXPO_PUBLIC_DEBUG = previousDebug;
        }
    });

    it('ignores persisted voice fixture markers in production without dismissing setup', async () => {
        const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
        const previousDebug = process.env.EXPO_PUBLIC_DEBUG;
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        process.env.EXPO_PUBLIC_DEBUG = '0';
        tauriDesktopState.value = false;
        globalThis.localStorage?.setItem('happier.voice.e2e.fixture', 'local_auto_return_listening');

        try {
            const Screen = (await import('@/app/(app)/index')).default;
            const screen = await renderScreen(React.createElement(Screen));
            await flushHookEffects({ cycles: 1, turns: 3 });

            expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(1);
            expect(setPendingSetupIntentMock).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'dismissed' }));
        } finally {
            (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
            if (previousDebug === undefined) delete process.env.EXPO_PUBLIC_DEBUG;
            else process.env.EXPO_PUBLIC_DEBUG = previousDebug;
        }
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
