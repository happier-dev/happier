import * as React from 'react';
import { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Dimensions: {
                get: () => ({ width: 1600, height: 900, scale: 2, fontScale: 1 }),
            },
            Platform: {
                OS: 'web',
                select: (options: any) => (options && 'default' in options ? options.default : undefined),
            },
            Linking: {
                canOpenURL: vi.fn(async () => false),
                openURL: vi.fn(async () => {}),
            },
            Text: 'Text',
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: routerPushSpy },
        });
        return routerMock.module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(async () => false),
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
    storage: 'real',
});


vi.mock('expo-image', () => ({
    Image: 'Image',
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
    requestReview: vi.fn(),
    canRequestReview: vi.fn(async () => true),
}));

afterEach(() => {
    routerPushSpy.mockClear();
});

const { SettingsView } = await import('./SettingsView');
const { Item } = await import('@/components/ui/lists/Item');

const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
beforeEach(() => {
    storage.setState({ settings: { ...settingsDefaults, useProfiles: false },
        profile: { ...profileDefaults, id: 'prof_1' }, machines: {},
        machineListByServerId: {}, machineListStatusByServerId: {} });
});

// Owner 11-06: a phone's Settings home is the list of Settings pages, as in 0.2; without the rail it sat
// below every hub section, about 6000 px down, and read as missing.
describe('SettingsView phone home', () => {
    it('leads with the list of Settings pages, ahead of the hub sections', async () => {
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { HubSetupSection } = await import('@/components/hub/HubSetupSection');
        const { SettingsRailVisibilityContext } = await import('./shell/settingsRailVisibility');
        // A phone: no Settings rail beside the page, so the page is the index.
        const tree = (await renderSettingsView(<InjectedAuthProvider credentials={null}>
            <SettingsRailVisibilityContext.Provider value={false}><SettingsView /></SettingsRailVisibilityContext.Provider>
        </InjectedAuthProvider>)).tree;
        const nodes = tree.root.findAll(() => true);
        // The first of the rail's catalog groups, drawn as the page's list.
        const firstGroup = nodes.findIndex((node) => typeof node.props?.groupId === 'string');
        // A memo component's node carries the function it wraps.
        const setupType = (HubSetupSection as unknown as { type?: unknown }).type ?? HubSetupSection;
        const setup = nodes.findIndex((node) => node.type === setupType);
        expect(firstGroup).toBeGreaterThan(-1);
        expect(setup).toBeGreaterThan(-1);
        expect(firstGroup).toBeLessThan(setup);
    });
});

describe('SettingsView ACP catalog entry', () => {
    it('does not include a detached ACP backends entry in the main settings screen', async () => {
        const { SettingsView } = await import('./SettingsView');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

        let tree!: ReactTestRenderer;
        tree = (await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>)).tree;

        const items = tree.findAllByType(Item);
        const acpItem = items.find((item: any) => item?.props?.title === 'settings.acpCatalog');
        expect(acpItem).toBeFalsy();
        expect(routerPushSpy).not.toHaveBeenCalled();
    });
});
