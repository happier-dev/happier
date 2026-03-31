import React from 'react';
import { act } from 'react-test-renderer';
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
const tauriDesktopState = vi.hoisted(() => ({ value: false }));
vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

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

const setPendingSetupIntentMock = vi.fn<(value: PendingSetupIntent) => void>();
const getPendingSetupIntentMock = vi.fn<() => PendingSetupIntent | null>(() => null);
const clearPendingSetupIntentMock = vi.fn();
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    setPendingSetupIntent: (value: PendingSetupIntent) => setPendingSetupIntentMock(value),
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    clearPendingSetupIntent: () => clearPendingSetupIntentMock(),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    subscribeActiveServer: (listener: () => void) => {
        activeServerListeners.add(listener);
        return () => {
            activeServerListeners.delete(listener);
        };
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('ItemGroup', { title }, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/settings/server/localControl/LocalRelayRuntimeControlSection', () => ({
    LocalRelayRuntimeControlSection: (props: Record<string, unknown>) => React.createElement('LocalRelayRuntimeControlSection', props),
}));
vi.mock('@/components/settings/server/localControl/LocalTailscaleSecureAccessSection', () => ({
    LocalTailscaleSecureAccessSection: (props: Record<string, unknown>) => React.createElement('LocalTailscaleSecureAccessSection', props),
}));
vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => relayDriftBannerMock(),
}));
vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: Record<string, unknown>) => React.createElement('RelayDriftActionCard', props),
}));

vi.mock('@/components/onboardingWizard/PreAuthOnboardingWizardEntry', () => ({
    PreAuthOnboardingWizardEntry: (props: Record<string, unknown>) => React.createElement('PreAuthOnboardingWizardEntry', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('/setup route', () => {
    beforeEach(() => {
        isAuthenticated = false;
        tauriDesktopState.value = true;
        activeServerSnapshot = {
            serverId: 'relay-1',
            serverUrl: 'https://relay.example.test/',
            generation: 1,
        };
        activeServerListeners.clear();
        getPendingSetupIntentMock.mockReset();
        getPendingSetupIntentMock.mockReturnValue(null);
        setPendingSetupIntentMock.mockReset();
        clearPendingSetupIntentMock.mockReset();
        relayDriftBannerMock.mockReset();
        relayDriftBannerMock.mockReturnValue(null);
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    function requireButton(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
        const button = screen.findByTestId(testID);
        if (!button) {
            throw new Error(`Unable to find button "${testID}"`);
        }
        return button;
    }

    it('redirects unauthenticated users to the onboarding wizard at /', async () => {
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findAllByType('PreAuthOnboardingWizardEntry' as never)).toHaveLength(0);
        expect(screen.findByTestId('setup.launchWizard')).toBeNull();
        expect(screen.findByTestId('setup.summary.activeRelay')).toBeNull();
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
        expect(clearPendingSetupIntentMock).toHaveBeenCalledTimes(1);
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('opens the setup wizard from the post-auth control panel', async () => {
        tauriDesktopState.value = true;
        isAuthenticated = true;

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const button = requireButton(screen, 'setup.launchWizard');
        await act(async () => {
            const handler = button.props.action ?? button.props.onPress;
            await handler?.();
        });

        expect(expoRouterMock.spies.push).toHaveBeenCalledWith('/setup/wizard');
    });

    it('does not render setup controls before auth even on desktop', async () => {
        tauriDesktopState.value = true;
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findAllByType('PreAuthOnboardingWizardEntry' as never)).toHaveLength(0);
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
        expect(screen.findAllByType('LocalTailscaleSecureAccessSection' as never)).toHaveLength(0);
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('marks setup as post-auth and surfaces the local setup summary without embedding mutation flows', async () => {
        tauriDesktopState.value = true;
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findByTestId('setup.launchWizard')).toBeTruthy();
        expect(screen.findAllByType('MachineSetupFlowScreen' as never)).toHaveLength(0);

        const items = screen.findAllByType('Item' as never);
        const thisComputer = items.find((entry) => entry.props.testID === 'setup.summary.thisComputer');
        const nextAction = items.find((entry) => entry.props.testID === 'setup.summary.nextAction');

        expect(thisComputer?.props.subtitle).toBe('settings.machineSetupCurrentMachineSubtitle');
        expect(nextAction?.props.subtitle).toBe('settings.machineSetupStageConnect');

        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });
        expect(clearPendingSetupIntentMock).not.toHaveBeenCalled();
    });

    it('shows the web-safe post-auth summary when not running in Tauri', async () => {
        tauriDesktopState.value = false;
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findByTestId('setup.postAuth')).toBeTruthy();
        expect(screen.findByTestId('setup.summary.activeRelay')).toBeTruthy();
        expect(screen.findByTestId('setup.summary.thisComputer')).toBeTruthy();
        expect(screen.findByTestId('setup.summary.nextAction')).toBeTruthy();
        expect(screen.findAllByType('MachineSetupFlowScreen' as never)).toHaveLength(0);
        expect(screen.findByTestId('setup.desktopOnlyNotice')).toBeNull();
    });

    it('resumes provider follow-up for a remote machine after relay adoption auth completes', async () => {
        tauriDesktopState.value = true;
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
            remoteSetupIntent: 'remoteMachine',
        });

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findAllByType('MachineSetupFlowScreen' as never)).toHaveLength(0);

        const items = screen.findAllByType('Item' as never);
        const activeRelay = items.find((entry) => entry.props.testID === 'setup.summary.activeRelay');
        const thisComputer = items.find((entry) => entry.props.testID === 'setup.summary.thisComputer');
        const nextAction = items.find((entry) => entry.props.testID === 'setup.summary.nextAction');

        expect(activeRelay?.props.subtitle).toBe('https://relay.example.test');
        expect(thisComputer?.props.subtitle).toBe('settings.machineSetupSshMachineSubtitle');
        expect(nextAction?.props.subtitle).toBe('settingsProviders.setup.startTitle');
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'remoteMachine',
            phase: 'post_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
            remoteSetupIntent: 'remoteMachine',
        });
    });

    it('lets the user discard the post-auth setup continuation explicitly', async () => {
        tauriDesktopState.value = true;
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const button = requireButton(screen, 'setup.postAuthDiscard');
        await act(async () => {
            const handler = button.props.action ?? button.props.onPress;
            await handler?.();
        });

        expect(clearPendingSetupIntentMock).toHaveBeenCalledTimes(1);
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('shows the post-auth readiness summary and relay repair surface when this computer drifts', async () => {
        tauriDesktopState.value = true;
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

        const items = screen.findAllByType('Item' as never);
        const activeRelay = items.find((entry) => entry.props.testID === 'setup.summary.activeRelay');
        const thisComputer = items.find((entry) => entry.props.testID === 'setup.summary.thisComputer');
        const nextAction = items.find((entry) => entry.props.testID === 'setup.summary.nextAction');

        expect(activeRelay?.props.subtitle).toBe('https://relay.example.test');
        expect(thisComputer?.props.subtitle).toBe('Your background service is connected to a different Relay');
        expect(nextAction?.props.subtitle).toBe('Connect background service to this Relay');
        expect(() => screen.findByType('RelayDriftActionCard' as never)).not.toThrow();
    });
});
