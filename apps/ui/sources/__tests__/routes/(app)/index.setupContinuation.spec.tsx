import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));

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

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: vi.fn(async () => ({ status: 'ready', features: { capabilities: { auth: { methods: [] } } } })),
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => ({
        branch: 'thisComputer',
        phase: 'awaiting_auth',
        relayUrl: 'https://relay.example.test',
    }),
}));

describe('/ (welcome) setup continuation', () => {
    beforeEach(() => {
        isAuthenticated = true;
        tauriDesktopState.value = true;
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('redirects authenticated Tauri desktop users back to /setup when a setup auth continuation is pending', async () => {
        const Screen = (await import('@/app/(app)/index')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/setup');
    });

    it('does not redirect browser web users back to /setup when a setup auth continuation is pending', async () => {
        tauriDesktopState.value = false;

        const Screen = (await import('@/app/(app)/index')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
    });
});
