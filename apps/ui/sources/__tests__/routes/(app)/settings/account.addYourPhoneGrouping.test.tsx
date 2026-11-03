import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const initialStorage = storage.getState();

async function renderScreen(element: React.ReactElement) {
    storage.setState({ settings: settingsParse({}), profile: { ...profileDefaults, id: 'p' } });
    const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
    return renderScreen(element);
}

let windowDimensions: { width: number; height: number } = { width: 1200, height: 800 };
// What the page asked the modal boundary to show.
const shownModals = vi.hoisted(() => [] as Array<{ props?: unknown }>);
let runningOnMac = false;


installSessionSettingsEntryModuleMocks({
    modalModule: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: { show: ((config: { props?: unknown }) => { shownModals.push(config); return 'modal-id'; }) as never },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Dimensions: {
                get: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({
                width: windowDimensions.width,
                height: windowDimensions.height,
                scale: 2,
                fontScale: 1,
            }),
        });
    },
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        logout: vi.fn(),
    }),
}));

vi.mock('@/hooks/auth/useConnectAccount', () => ({
    useConnectAccount: () => ({ connectAccount: vi.fn(), isLoading: false }),
}));

vi.mock('@/sync/sync', () => ({
    sync: { anonID: 'anon', serverID: 'server' },
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => runningOnMac,
}));

vi.mock('@/sync/domains/profiles/profile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/profiles/profile')>();
    return {
        ...actual,
    };
});

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => false,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isLoadingFeatures: false, gate: { gateVariant: 'disabled' } }),
}));

vi.mock('@/components/account/ProviderIdentityItems', () => ({
    ProviderIdentityItems: () => null,
}));

// Sibling sections that start Home/Account Service feature or history network
// work on mount are outside this route's access-row grouping contract; keep
// the rendered tree bounded to the rows under test.
vi.mock('@/components/settings/SettingsCatalogOverviewGroup', () => ({
    SettingsCatalogPageChildren: () => null,
}));

vi.mock('@/components/settings/account/AccountServiceSettingsSection', () => ({
    AccountServiceSettingsSection: () => null,
}));

vi.mock('@/components/settings/account/SettingsHistorySection', () => ({
    SettingsHistorySection: () => null,
}));

describe('Settings → Account (grouping)', () => {
    afterEach(() => {
        runningOnMac = false;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        resetSessionSettingsEntryState();
        shownModals.length = 0;
        standardCleanup();
        storage.setState(initialStorage, true);
    });

    it('shows add-phone and link-new-device actions on desktop web when camera APIs are available', async () => {
        windowDimensions = { width: 1200, height: 800 };
        vi.stubGlobal('navigator', {
            maxTouchPoints: 0,
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
            mediaDevices: { getUserMedia: async () => ({}) },
        } as any);
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AccountScreen />);
        expect(screen.findByTestId('settings-account-add-your-phone')).toBeTruthy();
        expect(screen.findByTestId('settings-account-link-new-device')).toBeTruthy();
        expect(screen.findByTestId('settings-account-add-home')).toBeTruthy();

        screen.pressByTestId('settings-account-add-your-phone');

        // The QR opens over the page (no tile here to grow in place); the page stays put.
        expect(shownModals.map((config) => config.props)).toEqual([{ purpose: 'phone' }]);
        expect(sessionSettingsEntryState.routerPushSpy).not.toHaveBeenCalledWith('/settings/add-phone');

        screen.pressByTestId('settings-account-add-home');

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith(
            '/restore?entryIntent=add_home',
        );
    });

    it('hides "Add your phone" on phone-sized web but keeps "Add another Home" without a camera', async () => {
        windowDimensions = { width: 360, height: 800 };
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AccountScreen />);
        expect(screen.findByTestId('settings-account-add-your-phone')).toBeNull();
        expect(screen.findByTestId('settings-account-link-new-device')).toBeNull();
        expect(screen.findByTestId('settings-account-add-home')).toBeTruthy();
    });

    it('keeps "Add another Home" reachable on camera-unavailable desktop web and gates only "Link new device"', async () => {
        windowDimensions = { width: 1200, height: 800 };
        vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AccountScreen />);
        expect(screen.findByTestId('settings-account-add-your-phone')).toBeTruthy();
        expect(screen.findByTestId('settings-account-link-new-device')).toBeNull();
        expect(screen.findByTestId('settings-account-add-home')).toBeTruthy();

        screen.pressByTestId('settings-account-add-home');

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith(
            '/restore?entryIntent=add_home',
        );
    });

    it('keeps "Add another Home" reachable on macOS where the device scanner is never offered', async () => {
        runningOnMac = true;
        windowDimensions = { width: 1200, height: 800 };
        vi.stubGlobal('navigator', {
            maxTouchPoints: 0,
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            mediaDevices: { getUserMedia: async () => ({}) },
        } as any);

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AccountScreen />);
        expect(screen.findByTestId('settings-account-add-your-phone')).toBeTruthy();
        expect(screen.findByTestId('settings-account-link-new-device')).toBeNull();
        expect(screen.findByTestId('settings-account-add-home')).toBeTruthy();
    });

    it('leaves out "Add another Home" while the organization policy fixes the Home', async () => {
        windowDimensions = { width: 1200, height: 800 };
        vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);
        // Native startup hands the policy to the renderer through the web runtime config.
        vi.stubGlobal('isTauri', true);
        if (typeof document === 'undefined') vi.stubGlobal('document', {});
        if (typeof window === 'undefined') vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
        const runtime = window as unknown as { __HAPPIER_WEB_RUNTIME_CONFIG__?: unknown };
        runtime.__HAPPIER_WEB_RUNTIME_CONFIG__ = { organizationPolicyJson: JSON.stringify({ schemaVersion: 1, organization: 'Example Co',
            home: { url: 'https://home.example.test', locked: true } }) };
        try {
            const { default: AccountScreen } = await import('@/app/(app)/settings/account');
            const screen = await renderScreen(<AccountScreen />);
            expect(screen.findByTestId('settings-account-add-your-phone')).toBeTruthy();
            expect(screen.findByTestId('settings-account-add-home')).toBeNull();
        } finally {
            delete runtime.__HAPPIER_WEB_RUNTIME_CONFIG__;
        }
    });

    it('shows "Add your phone" on desktop-sized web even when the viewport is narrow', async () => {
        windowDimensions = { width: 480, height: 700 };
        vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);
        Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AccountScreen />);
        expect(screen.findByTestId('settings-account-add-your-phone')).toBeTruthy();
    });
});
