import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

const reactNativeState = {
    windowWidth: 390,
    windowHeight: 844,
};

let localSearchParams: Record<string, string | string[] | undefined> = {};
const routerMock = createExpoRouterMock({
    params: () => localSearchParams,
    router: {
        replace: vi.fn(),
    },
});

vi.mock('expo-router', () => routerMock.module);
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));
vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: (props: Record<string, unknown>) => React.createElement('BaseModal', props, props.children as any),
}));
vi.mock('@/components/onboarding/surfaces/SetupWizardSurface', () => ({
    SetupWizardSurface: (props: Record<string, unknown>) => React.createElement('SetupWizardSurface', props),
}));
vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => false,
}));
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    clearPendingSetupIntent: vi.fn(),
}));

const applyLocalSettingsSpy = vi.hoisted(() => vi.fn());
vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => applyLocalSettingsSpy,
}));

describe('SetupWizardRoute', () => {
    beforeEach(() => {
        vi.doMock('react-native', installReactNativeWebMock({
            Platform: { OS: 'web' },
            useWindowDimensions: () => ({
                width: reactNativeState.windowWidth,
                height: reactNativeState.windowHeight,
                scale: 2,
                fontScale: 1,
            }),
        }));
        reactNativeState.windowWidth = 390;
        reactNativeState.windowHeight = 844;
        routerMock.spies.replace.mockReset();
        localSearchParams = {};
        applyLocalSettingsSpy.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('returns to home when dismissed', async () => {
        const Route = (await import('@/app/(app)/setup/wizard')).default;
        const screen = await renderScreen(<Route />);

        const surface = screen.findByType('SetupWizardSurface' as any);
        surface.props.onExit();

        expect(routerMock.spies.replace).toHaveBeenCalledWith('/');
        expect(applyLocalSettingsSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionGettingStartedGuidanceDismissed: true }));
    });

    it('opens the setup wizard inside a modal on web (overlay owns scrolling + placement)', async () => {
        const Route = (await import('@/app/(app)/setup/wizard')).default;
        const screen = await renderScreen(<Route />);

        const modal = screen.findByType('BaseModal' as any);
        const surface = screen.findByType('SetupWizardSurface' as any);
        expect(surface.props.useOuterScrollContainer).toBe(true);
        expect(modal.props.showBackdrop).toBe(true);
    });

    it('top-aligns the modal shell on narrow web when the wizard switches to fullscreen presentation', async () => {
        reactNativeState.windowWidth = 390;
        const Route = (await import('@/app/(app)/setup/wizard')).default;
        const screen = await renderScreen(<Route />);

        const modal = screen.findByType('BaseModal' as any);
        expect(modal.props.webPlacement).toBe('top');
    });

    it('keeps the default modal auto-placement on wider web layouts', async () => {
        reactNativeState.windowWidth = 960;
        const Route = (await import('@/app/(app)/setup/wizard')).default;
        const screen = await renderScreen(<Route />);

        const modal = screen.findByType('BaseModal' as any);
        expect(modal.props.webPlacement).toBeUndefined();
    });

    it('forwards the scope query param to SetupWizardSurface', async () => {
        localSearchParams = { scope: 'relay' };
        const Route = (await import('@/app/(app)/setup/wizard')).default;
        const screen = await renderScreen(<Route />);

        const surface = screen.findByType('SetupWizardSurface' as any);
        expect(surface.props.scope).toBe('relay');
    });
});
