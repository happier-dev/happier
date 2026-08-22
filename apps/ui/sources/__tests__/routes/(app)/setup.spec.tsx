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
const tauriDesktopState = vi.hoisted(() => ({ value: false }));
vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => tauriDesktopState.value,
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
vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => relayDriftBannerMock(),
}));
vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: Record<string, unknown>) => React.createElement('RelayDriftActionCard', props),
}));

vi.mock('@/components/onboarding/PreAuthOnboardingWizardEntry', () => ({
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

    it('redirects unauthenticated users to the onboarding wizard at /', async () => {
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findAllByType('PreAuthOnboardingWizardEntry' as never)).toHaveLength(0);
        expect(clearPendingSetupIntentMock).toHaveBeenCalledTimes(1);
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('redirects authenticated users to /setup/wizard', async () => {
        isAuthenticated = true;
        const Screen = (await import('@/app/(app)/setup/index')).default;
        await renderScreen(React.createElement(Screen));

        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/setup/wizard');
    });
});
