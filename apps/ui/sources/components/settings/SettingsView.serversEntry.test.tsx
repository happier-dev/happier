import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    routerBackSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    navigateWithBlurOnWebSpy: vi.fn((action: () => void) => action()),
    deferOnWebSpy: vi.fn((action: () => void) => action()),
    linkingCanOpenURLSpy: vi.fn(async () => false),
    linkingOpenURLSpy: vi.fn(async () => {}),
    requestReviewSpy: vi.fn(),
    canRequestReviewSpy: vi.fn(async () => true),
}));

const settingsViewWebDimensions = { width: 1600, height: 900, scale: 2, fontScale: 1 };
const tauriDesktopState = vi.hoisted(() => ({ value: true }));

async function renderSettledSettingsView() {
    const { SettingsView } = await import('./SettingsView');
    const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);
    for (let stage = 0; stage < 4; stage += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
        });
    }
    return screen;
}

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ActivityIndicator: 'ActivityIndicator',
            Dimensions: {
                get: () => settingsViewWebDimensions,
            },
            Linking: { canOpenURL: shared.linkingCanOpenURLSpy, openURL: shared.linkingOpenURLSpy },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: shared.routerPushSpy,
                back: shared.routerBackSpy,
                replace: shared.routerReplaceSpy,
                setParams: vi.fn(),
            },
        }).module;
    },
    storage: 'real',
});

const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
    navigateWithBlurOnWeb: (action: () => void) => shared.navigateWithBlurOnWebSpy(action),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (action: () => void) => shared.deferOnWebSpy(action),
}));

vi.mock('@/utils/platform/desktopHost', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/desktopHost')>('@/utils/platform/desktopHost');
    return {
        ...actual,
        isDesktopHost: () => tauriDesktopState.value,
        invokeDesktopHost: vi.fn(async () => false),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock(), useFocusEffect: () => {} };
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));





vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));



vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: vi.fn(async () => {}),
        presentPaywall: vi.fn(async () => ({ success: false, error: 'nope' })),
        refreshProfile: vi.fn(async () => {}),
    },
}));

vi.mock('@/track', () => ({
    trackPaywallButtonClicked: vi.fn(),
    trackWhatsNewClicked: vi.fn(),
}));

vi.mock('@/hooks/ui/useMultiClick', () => ({
    useMultiClick: (cb: () => void) => cb,
}));


vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));



vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: 'MachineCliGlyphs',
}));

vi.mock('@/components/settings/supportUsBehavior', () => ({
    resolveSupportUsAction: () => 'github',
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: vi.fn(),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 }),
    listServerProfiles: () => [],
    subscribeActiveServer: (listener: any) => {
        listener({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 });
        return () => {};
    },
}));

vi.mock('@/utils/system/requestReview', () => ({
    requestReview: shared.requestReviewSpy,
    canRequestReview: shared.canRequestReviewSpy,
}));

afterEach(() => {
    standardCleanup();
    shared.routerPushSpy.mockClear();
    shared.routerBackSpy.mockClear();
    shared.routerReplaceSpy.mockClear();
    shared.navigateWithBlurOnWebSpy.mockClear();
    shared.deferOnWebSpy.mockClear();
    shared.linkingCanOpenURLSpy.mockClear();
    shared.linkingOpenURLSpy.mockClear();
    shared.requestReviewSpy.mockClear();
    shared.canRequestReviewSpy.mockReset();
    shared.canRequestReviewSpy.mockResolvedValue(true);
});

// Load the real owner after boundaries during collection, outside behavior deadlines.
await import('./SettingsView');

const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
beforeEach(() => {
    storage.setState({ settings: { ...settingsDefaults, useProfiles: false },
        profile: { ...profileDefaults, id: 'prof_1' }, machines: {},
        machineListByServerId: {}, machineListStatusByServerId: {} });
});

describe('SettingsView', () => {
    it('includes a first-class Homes entry that opens inside the settings layout', async () => {
        const screen = await renderSettledSettingsView();

        expect(screen.findRowByTitle('settings.servers')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settings.servers');
        });

        expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/server');
    });

    it('includes a System Status entry that routes to /settings/system-status', async () => {
        const screen = await renderSettledSettingsView();

        expect(screen.findRowByTitle('settings.systemStatus')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settings.systemStatus');
        });

        expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/system-status');
    });

    it('includes a Desktop app entry that routes to /settings/desktop on Tauri desktop', async () => {
        tauriDesktopState.value = true;
        const screen = await renderSettledSettingsView();

        expect(screen.findRowByTitle('settingsDesktop.title')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settingsDesktop.title');
        });

        expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/desktop');
    });

    it('hides the Desktop app entry on non-Tauri builds', async () => {
        tauriDesktopState.value = false;
        const screen = await renderSettledSettingsView();

        expect(screen.findRowByTitle('settingsDesktop.title')).toBeNull();
    });

    it('blurs the active element before routing to Features on web', async () => {
        const screen = await renderSettledSettingsView();

        expect(screen.findRowByTitle('settings.featuresTitle')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settings.featuresTitle');
        });

        expect(shared.deferOnWebSpy).toHaveBeenCalledTimes(1);
        expect(shared.navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/features');
    });

    it('routes to the in-app bug report composer by default when Report issue is pressed', async () => {
        const screen = await renderSettledSettingsView();

        expect(screen.findRowByTitle('settings.reportIssue')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settings.reportIssue');
        });

        expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/report-issue');
        expect(shared.linkingOpenURLSpy).not.toHaveBeenCalled();
    });

    it('admits an HTTP report override before opening and leaves refusal without a composer fallback', async () => {
        const previousUrl = process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
        process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = 'https://example.test/report-issue';
        shared.linkingCanOpenURLSpy.mockResolvedValue(true);
        const opened = vi.fn();
        vi.stubGlobal('open', opened);

        try {
            storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { 'links.openExternal': { enabled: false } } }) } }));
            const screen = await renderSettledSettingsView();
            await act(async () => {
                screen.pressRowByTitle('settings.reportIssue');
            });
            expect(shared.linkingOpenURLSpy).not.toHaveBeenCalled();
            expect(opened).not.toHaveBeenCalled();
            expect(shared.routerPushSpy).not.toHaveBeenCalledWith('/settings/report-issue');

            storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) } }));
            await act(async () => {
                screen.pressRowByTitle('settings.reportIssue');
            });
            await vi.waitFor(() => expect(opened).toHaveBeenCalledExactlyOnceWith('https://example.test/report-issue', '_blank', 'noopener,noreferrer'));
            expect(shared.linkingCanOpenURLSpy).not.toHaveBeenCalled();
            expect(shared.linkingOpenURLSpy).not.toHaveBeenCalled();
            expect(shared.routerPushSpy).not.toHaveBeenCalledWith('/settings/report-issue');
        } finally {
            vi.unstubAllGlobals();
            if (previousUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
            else process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = previousUrl;
        }
    });

    it.each([true, false])('keeps a non-HTTP report override on the platform path with its original fallback (supported: %s)', async supported => {
        const previousUrl = process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
        process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = 'mailto:support@example.test';
        shared.linkingCanOpenURLSpy.mockResolvedValue(supported);

        try {
            storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { 'links.openExternal': { enabled: false } } }) } }));
            const screen = await renderSettledSettingsView();

            expect(screen.findRowByTitle('settings.reportIssue')).toBeTruthy();

            await act(async () => {
                await screen.pressRowByTitle('settings.reportIssue');
            });

            expect(shared.linkingCanOpenURLSpy).toHaveBeenCalledWith('mailto:support@example.test');
            if (supported) {
                expect(shared.linkingOpenURLSpy).toHaveBeenCalledWith('mailto:support@example.test');
                expect(shared.routerPushSpy).not.toHaveBeenCalledWith('/settings/report-issue');
            } else {
                expect(shared.linkingOpenURLSpy).not.toHaveBeenCalled();
                expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/report-issue');
            }
        } finally {
            if (previousUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
            else process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = previousUrl;
        }
    });

    it('renders the GitHub repository as subtitle, not right-side detail', async () => {
        const screen = await renderSettledSettingsView();
        const githubItem = screen.findRowByTitle('settings.github');

        expect(githubItem).toBeTruthy();
        expect(githubItem?.props.subtitle).toBe('happier-dev/happier');
        expect(githubItem?.props.detail).toBeUndefined();
    });

    it('shows Rate us right below What’s New and triggers store review only when pressed', async () => {
        shared.canRequestReviewSpy.mockResolvedValue(true);
        const screen = await renderSettledSettingsView();

        const aboutGroup = screen.findGroup('settings.about');
        expect(aboutGroup).toBeTruthy();
        const { Item } = await import('@/components/ui/lists/Item');
        const items = screen.findAllByType(Item).filter(item =>
            aboutGroup!.findAll(node => node === item).length > 0);
        const whatsNewIndex = items.findIndex((item: any) => item?.props?.title === 'settings.whatsNew');
        const rateUsIndex = items.findIndex((item: any) => item?.props?.title === 'settings.rateUs');

        expect(screen.findRowByTitle('settings.rateUs')).toBeTruthy();
        expect(whatsNewIndex).toBeGreaterThanOrEqual(0);
        expect(rateUsIndex).toBe(whatsNewIndex + 1);
        expect(shared.requestReviewSpy).not.toHaveBeenCalled();

        await act(async () => {
            await screen.pressRowByTitle('settings.rateUs');
        });

        expect(shared.requestReviewSpy).toHaveBeenCalledTimes(1);
    });

    it('hides Rate us when store-review action is unavailable', async () => {
        shared.canRequestReviewSpy.mockResolvedValue(false);
        const screen = await renderSettledSettingsView();

        expect(screen.findRowByTitle('settings.rateUs')).toBeNull();
    });
});
