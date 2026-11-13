import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

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
    copySpy: vi.fn(async (_value: string) => true),
}));

const settingsViewWebDimensions = { width: 1600, height: 900, scale: 2, fontScale: 1 };

function createPassthroughNode(name: string) {
    return (props: any) => React.createElement(name, props, props.children);
}

function createPropPassthroughNode(name: string) {
    return (props: any) => React.createElement(name, props, props.children, props.subtitleAccessory);
}

function createSettingsViewStorageOverrides() {
    return {
        useEntitlement: () => false,
        useSettings: () => ({
            connectedDeviceV1_desktop: { name: 'Test laptop', platform: 'desktop', appVersion: '1.2.3', lastSeen: Date.now() - 1000 },
            connectedDeviceV1_phone: { name: 'Phone', platform: 'android', appVersion: '1.2.2', lastSeen: Date.now() - 2000 },
            connectedDeviceV1_web: { name: null, platform: 'web', appVersion: '1.2.4', lastSeen: Date.now() - 3000 },
            connectedDeviceV1_old: { name: 'Expired device', platform: 'android', appVersion: 'old', lastSeen: Date.now() - 15 * 86400000 },
        }) as any,
        // Boundary mock: this suite only reads a boolean local setting toggle.
        useLocalSettingMutable: (() => [false, vi.fn()]) as any,
        useSetting: (key: string) => {
            if (key === 'serverSelectionGroups') return [];
            if (key === 'serverSelectionActiveTargetKind') return null;
            if (key === 'serverSelectionActiveTargetId') return null;
            if (key === 'experiments') return false;
            if (key === 'featureToggles') return {};
            if (key === 'useProfiles') return false;
            if (key === 'sessionUseTmux') return false;
            return null;
        },
        useAllMachines: () => [
            createMachineFixture({ metadata: { host: 'workstation', platform: 'linux', homeDir: '/tmp', happyHomeDir: '/tmp/happier', happyCliVersion: '2.3.4' } }),
            createMachineFixture({ id: 'legacy-host', metadata: { host: 'legacy-host', platform: 'linux', homeDir: '/tmp', happyHomeDir: '/tmp/happier', happyCliVersion: '0.2.17' } }),
        ],
        useMachineListByServerId: () => ({}),
        useMachineListStatusByServerId: () => ({}),
        // Boundary mock: SettingsView only consumes these profile fields in this suite.
        useProfile: (() => ({ id: 'prof_1', firstName: '', connectedServices: [] })) as any,
    };
}

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ActivityIndicator: 'ActivityIndicator',
            Dimensions: {
                get: () => settingsViewWebDimensions,
            },
            useWindowDimensions: () => settingsViewWebDimensions,
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
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: createSettingsViewStorageOverrides(),
        });
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
    navigateWithBlurOnWeb: (action: () => void) => shared.navigateWithBlurOnWebSpy(action),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (action: () => void) => shared.deferOnWebSpy(action),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (_cb: () => void) => {},
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));

vi.mock('@/sync/runtime/readCurrentAppRuntimeInfo', () => ({
    readCurrentAppRuntimeInfo: () => ({ appVersion: '0.0.0-test', nativeApplicationVersion: '1.2.3', nativeBuildVersion: '42', runtimeVersion: 'runtime-1' }),
}));

vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: shared.copySpy }));
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: async () => ({ ok: true, json: async () => ({ ok: true, version: '3.4.5', source_sha: 'abcdef0123456789' }) }) }));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: createPassthroughNode('ItemList'),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassthroughNode('ItemGroup'),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPropPassthroughNode('Item'),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: createSettingsViewStorageOverrides(),
    });
});

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

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => false,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/sync/api/account/apiVendorTokens', () => ({
    disconnectVendorToken: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/profiles/profile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/profiles/profile')>();
    return {
        ...actual,
        getDisplayName: () => 'Test User',
        getAvatarUrl: () => null,
        getBio: () => '',
    };
});

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: 'MachineCliGlyphs',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'gemini'],
    DEFAULT_AGENT_ID: 'agent_default',
    getAgentCore: () => ({ uiConnectedService: { serviceId: 'anthropic', label: 'Anthropic', connectRoute: null } }),
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => null,
    resolveAgentIdFromConnectedServiceId: () => null,
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

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 }),
    listServerProfiles: () => [],
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/utils/system/requestReview', () => ({
    requestReview: shared.requestReviewSpy,
    canRequestReview: shared.canRequestReviewSpy,
}));

afterEach(() => {
    vi.useRealTimers();
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

describe('SettingsView', () => {
    async function renderSettingsViewUnderTest() {
        vi.useFakeTimers();
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(
            React.createElement(SettingsView),
            { flushOptions: { runAllTimers: true, cycles: 8 } },
        );
        for (let index = 0; index < 8; index += 1) {
            await act(async () => {
                await vi.runOnlyPendingTimersAsync();
            });
        }
        return screen;
    }

    it('displays and copies app, server, and connected machine versions', async () => {
        const { CONNECTED_DEVICE_CLIENT_ID_KEY } = await import('@/sync/domains/settings/connectedDevices');
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistence');
        getPersistenceStorage().set(CONNECTED_DEVICE_CLIENT_ID_KEY, 'desktop');
        const screen = await renderSettingsViewUnderTest();
        const row = screen.findRowByTitle('common.version');
        const lines = (row?.props.subtitle as React.ReactElement<{ lines: ReadonlyArray<{ text: string; isLocalDevice?: boolean }> }>).props.lines;
        const subtitleText = lines.map((line) => line.text).join('\n');
        expect(subtitleText).toContain('0.0.0-test');
        expect(subtitleText).toContain('1.2.3');
        expect(subtitleText).toContain('42');
        expect(subtitleText).toContain('3.4.5');
        expect(subtitleText).toContain('abcdef0123456789');
        expect(subtitleText).toContain('workstation');
        expect(subtitleText).toContain('2.3.4');
        expect(subtitleText).toContain('legacy-host): 0.2.17');
        expect(subtitleText).not.toContain('legacy-host): 0.2.17 (0.0.0-test)');
        expect(subtitleText).toContain('Test laptop');
        expect(subtitleText).toContain('1.2.3');
        expect(subtitleText).toContain('Phone | android | 1.2.2');
        expect(subtitleText).toContain('web | 1.2.4');
        expect(subtitleText).not.toContain('Expired device');
        // This instance's own lines (app, native, build, runtime) and this device's row are highlighted; nothing else is.
        expect(lines.filter((line) => line.isLocalDevice).map((line) => line.text)).toEqual([
            expect.stringContaining('0.0.0-test'),
            expect.stringContaining('1.2.3'),
            expect.stringContaining('42'),
            expect.stringContaining('runtime-1'),
            expect.stringContaining('Test laptop | desktop'),
        ]);
        await act(async () => { await screen.pressRowByTitle('common.version'); });
        expect(shared.copySpy).toHaveBeenCalledWith(subtitleText);
        expect(screen.findByTestId('settings-version-copied-toast')?.props.accessibilityLabel).toBe('common.copied!');
    });

    it('includes a first-class Relays entry that routes to /server', async () => {
        const screen = await renderSettingsViewUnderTest();

        expect(screen.findRowByTitle('settings.servers')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settings.servers');
        });

        expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/server');
    });

    it('includes a System Status entry that routes to /settings/system-status', async () => {
        const screen = await renderSettingsViewUnderTest();

        expect(screen.findRowByTitle('settings.systemStatus')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settings.systemStatus');
        });

        expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/system-status');
    });

    it('blurs the active element before routing to Features on web', async () => {
        const screen = await renderSettingsViewUnderTest();

        expect(screen.findRowByTitle('settings.featuresTitle')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settings.featuresTitle');
        });

        expect(shared.deferOnWebSpy).toHaveBeenCalledTimes(1);
        expect(shared.navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/features');
    });

    it('routes to the in-app bug report composer by default when Report issue is pressed', async () => {
        const screen = await renderSettingsViewUnderTest();

        expect(screen.findRowByTitle('settings.reportIssue')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settings.reportIssue');
        });

        expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/report-issue');
        expect(shared.linkingOpenURLSpy).not.toHaveBeenCalled();
    });

    it('opens EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL when set and supported instead of routing to the composer', async () => {
        const previousUrl = process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
        process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = 'https://example.test/report-issue';
        shared.linkingCanOpenURLSpy.mockResolvedValue(true);

        try {
            const screen = await renderSettingsViewUnderTest();

            expect(screen.findRowByTitle('settings.reportIssue')).toBeTruthy();

            await act(async () => {
                await screen.pressRowByTitle('settings.reportIssue');
            });

            expect(shared.linkingCanOpenURLSpy).toHaveBeenCalledWith('https://example.test/report-issue');
            expect(shared.linkingOpenURLSpy).toHaveBeenCalledWith('https://example.test/report-issue');
            expect(shared.routerPushSpy).not.toHaveBeenCalledWith('/settings/report-issue');
        } finally {
            if (previousUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
            else process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = previousUrl;
        }
    });

    it('falls back to routing when EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL is set but cannot be opened', async () => {
        const previousUrl = process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
        process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = 'https://example.test/report-issue';
        shared.linkingCanOpenURLSpy.mockResolvedValue(false);

        try {
            const screen = await renderSettingsViewUnderTest();

            expect(screen.findRowByTitle('settings.reportIssue')).toBeTruthy();

            await act(async () => {
                await screen.pressRowByTitle('settings.reportIssue');
            });

            expect(shared.linkingCanOpenURLSpy).toHaveBeenCalledWith('https://example.test/report-issue');
            expect(shared.linkingOpenURLSpy).not.toHaveBeenCalled();
            expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/report-issue');
        } finally {
            if (previousUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
            else process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = previousUrl;
        }
    });

    it('renders the GitHub repository as subtitle, not right-side detail', async () => {
        const screen = await renderSettingsViewUnderTest();
        const githubItem = screen.findRowByTitle('settings.github');

        expect(githubItem).toBeTruthy();
        expect(githubItem?.props.subtitle).toBe('happier-dev/happier');
        expect(githubItem?.props.detail).toBeUndefined();
    });

    it('shows Rate us right below What’s New and triggers store review only when pressed', async () => {
        shared.canRequestReviewSpy.mockResolvedValue(true);
        const screen = await renderSettingsViewUnderTest();

        const aboutGroup = screen.findGroup('settings.about');
        expect(aboutGroup).toBeTruthy();
        const items = aboutGroup!.findAllByType('Item' as any);
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
        const screen = await renderSettingsViewUnderTest();

        expect(screen.findRowByTitle('settings.rateUs')).toBeNull();
    });
});
