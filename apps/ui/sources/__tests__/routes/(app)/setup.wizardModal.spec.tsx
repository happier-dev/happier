import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

const reactNativeState = vi.hoisted(() => ({
    windowWidth: 390,
    windowHeight: 844,
}));

const expoRouterMock = vi.hoisted(() => {
    const replace = vi.fn();
    const router = { replace };
    let localSearchParams: Record<string, unknown> = {};
    return {
        spies: { replace },
        setLocalSearchParams: (next: Record<string, unknown>) => {
            localSearchParams = next;
        },
        module: {
            router,
            useRouter: () => router,
            useNavigation: () => null,
            useSegments: () => [],
            usePathname: () => '/',
            useLocalSearchParams: () => localSearchParams,
            useGlobalSearchParams: () => ({}),
            Stack: Object.assign(
                function Stack(props: { children?: React.ReactNode }) {
                    return React.createElement(React.Fragment, null, props.children ?? null);
                },
                {
                    Screen: (props: Record<string, unknown>) => React.createElement('StackScreen', props),
                },
            ),
            Link: 'Link' as any,
            Redirect: (props: Record<string, unknown>) => React.createElement('Redirect', props),
        },
    };
});

vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));
vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: (props: Record<string, unknown>) => React.createElement('BaseModal', props, props.children as any),
}));
vi.mock('@/components/onboarding/surfaces/SetupWizardSurface', () => ({
    SetupWizardSurface: (props: Record<string, unknown>) => React.createElement('SetupWizardSurface', props),
}));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
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
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.setLocalSearchParams({});
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

        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
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
        expoRouterMock.setLocalSearchParams({ scope: 'relay' });
        const Route = (await import('@/app/(app)/setup/wizard')).default;
        const screen = await renderScreen(<Route />);

        const surface = screen.findByType('SetupWizardSurface' as any);
        expect(surface.props.scope).toBe('relay');
    });
});
