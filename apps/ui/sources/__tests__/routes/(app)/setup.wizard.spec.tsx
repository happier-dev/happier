import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, renderScreen, standardCleanup } from '@/dev/testkit';

const expoRouterMock = createExpoRouterMock({
    router: {
        push: vi.fn(),
        replace: vi.fn(),
    },
});

vi.mock('expo-router', () => expoRouterMock.module);

let isAuthenticated = false;
const refreshFromActiveServerSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated,
        refreshFromActiveServer: refreshFromActiveServerSpy,
    }),
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    clearPendingSetupIntent: vi.fn(),
}));

vi.mock('@/components/onboarding/PreAuthOnboardingWizardEntry', () => ({
    PreAuthOnboardingWizardEntry: (props: Record<string, unknown>) => React.createElement('PreAuthOnboardingWizardEntry', props),
}));

vi.mock('@/components/onboarding/surfaces/SetupWizardSurface', () => ({
    SetupWizardSurface: (props: Record<string, unknown>) => React.createElement('SetupWizardSurface', props),
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('ItemGroup', { title }, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('/setup/wizard route', () => {
    beforeEach(() => {
        isAuthenticated = false;
        expoRouterMock.spies.push.mockReset();
        expoRouterMock.spies.replace.mockReset();
        refreshFromActiveServerSpy.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('redirects unauthenticated users to /', async () => {
        const Screen = (await import('@/app/(app)/setup/wizard')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findAllByType('PreAuthOnboardingWizardEntry' as never)).toHaveLength(0);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('waits for auth hydration before redirecting when credentials are available', async () => {
        refreshFromActiveServerSpy.mockImplementation(async () => {
            isAuthenticated = true;
        });

        const Screen = (await import('@/app/(app)/setup/wizard')).default;
        const screen = await renderScreen(React.createElement(Screen));

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalled();
        expect(screen.findByTestId('setupWizard.surface')).toBeTruthy();
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(1);
    });

    it('renders the setup wizard surface after auth', async () => {
        isAuthenticated = true;
        const Screen = (await import('@/app/(app)/setup/wizard')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findByTestId('setupWizard.surface')).toBeTruthy();
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(1);
        expect(screen.findByTestId('setup.preAuthNotice')).toBeNull();
    });
});
