import * as React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, pressTestInstanceAsync, renderSettingsView } from '@/dev/testkit';
import {
    installSettingsViewCommonModuleMocks,
    settingsViewScanProcessAuthUrlSpy,
} from './settingsViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const connectTerminalSpy = vi.fn();
const promptSpy = vi.fn(async (_title?: string): Promise<string | null> => null);
const requestReviewMockState = vi.hoisted(() => ({
    canRequestReview: vi.fn(async () => false),
    requestReview: vi.fn(async () => {}),
}));
const interactionManagerMockState = vi.hoisted(() => ({
    runAfterInteractions: vi.fn((fn: () => void) => {
        fn();
        return { cancel: () => {} };
    }),
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Dimensions: {
                get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
            },
            Platform: {
                OS: 'ios',
                select: (options: any) => (options && 'default' in options ? options.default : undefined),
            },
            Text: 'Text',
            ActivityIndicator: 'ActivityIndicator',
            InteractionManager: {
                runAfterInteractions: interactionManagerMockState.runAfterInteractions,
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: vi.fn() },
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
                prompt: promptSpy,
            },
        }).module;
    },
    storage: 'real',
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));


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

vi.mock('expo-application', () => ({
    nativeApplicationVersion: '0.3.4', nativeBuildVersion: '42', applicationId: 'dev.happier.app',
}));

vi.mock('expo-updates', async () => ({
    ...(await import('@/dev/testkit/mocks/expoUpdates')).createExpoUpdatesMock(),
    runtimeVersion: '0.9.8-native',
}));

vi.mock('@/constants/Typography', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/constants/Typography')>();
    return {
        ...actual,
        Typography: {
            ...actual.Typography,
            default: () => ({}),
            mono: () => ({}),
        },
    };
});




vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: connectTerminalSpy, connectWithUrl: vi.fn(), isLoading: false }),
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

vi.mock('@/utils/system/requestReview', () => ({
    canRequestReview: requestReviewMockState.canRequestReview,
    requestReview: requestReviewMockState.requestReview,
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
    loadHomeViewState: () => null,
    listServerProfiles: () => [],
    subscribeActiveServer: (listener: any) => {
        listener({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 });
        return () => {};
    },
}));

/** The connect actions are setup tiles: the pressable that carries the tile's test id. */
function findPressableByTestId(tree: ReactTestRenderer, testID: string) {
    return tree.root.findAll((node: any) => node?.props?.testID === testID && typeof node.props.onPress === 'function')[0];
}

function findItemByTitle(tree: ReactTestRenderer, title: string) {
    return tree.findAll((node) => node.props.title === title && typeof node.props.onPress === 'function')[0];
}

async function flushDeferredSettingsDelay(delayMs = 0): Promise<void> {
    await act(async () => {
        if (vi.isFakeTimers()) {
            await vi.advanceTimersByTimeAsync(delayMs);
            return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    });
    await flushHookEffects({ cycles: 1 });
}


const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
await import('./SettingsView');

const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
beforeEach(() => {
    storage.setState({ settings: { ...settingsDefaults, useProfiles: false },
        profile: { ...profileDefaults, id: 'prof_1' }, machines: {},
        machineListByServerId: {}, machineListStatusByServerId: {} });
});

describe('SettingsView (native connect terminal)', () => {
    it('shows the installed native app version rather than the JavaScript config version', async () => {
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);
        for (let stage = 0; stage < 5; stage++) await flushDeferredSettingsDelay(25);
        expect(screen.getTextContent()).toContain('0.3.4');
    });

    it('shows terminal connect actions on native platforms', async () => {
        const { SettingsView } = await import('./SettingsView');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

        let tree!: ReactTestRenderer;
        tree = (await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>)).tree;

        const scanItem = findPressableByTestId(tree, 'settings-connect-terminal-scan');
        const manualItem = findPressableByTestId(tree, 'settings-connect-terminal-enter-url');

        expect(scanItem).toBeTruthy();
        expect(manualItem).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(scanItem!);
        });

        expect(connectTerminalSpy).toHaveBeenCalledTimes(1);
    });

    it('routes manual auth URLs through the shared scanned auth processor', async () => {
        promptSpy.mockReset();
        promptSpy.mockResolvedValueOnce('happier://terminal?key=abc123&server=https%3A%2F%2Frelay.example.test');
        settingsViewScanProcessAuthUrlSpy.mockReset();
        settingsViewScanProcessAuthUrlSpy.mockResolvedValueOnce(true);

        const { SettingsView } = await import('./SettingsView');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const tree = (await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>)).tree;

        const manualItem = findPressableByTestId(tree, 'settings-connect-terminal-enter-url');
        expect(manualItem).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(manualItem!);
        });

        expect(settingsViewScanProcessAuthUrlSpy).toHaveBeenCalledWith('happier://terminal?key=abc123&server=https%3A%2F%2Frelay.example.test');
    });

    it('waits for native interactions before showing below-fold settings sections', async () => {
        interactionManagerMockState.runAfterInteractions.mockClear();
        let releaseInteractions: (() => void) | null = null;
        interactionManagerMockState.runAfterInteractions.mockImplementationOnce((fn: () => void) => {
            releaseInteractions = fn;
            return { cancel: () => {} };
        });

        const { SettingsView } = await import('./SettingsView');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

        vi.useFakeTimers();
        try {
            const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>, { flushOptions: { cycles: 0 } });

            await flushDeferredSettingsDelay(1000);

            expect(interactionManagerMockState.runAfterInteractions).toHaveBeenCalledTimes(1);
            expect(Boolean(findItemByTitle(screen.tree, 'settingsAgents.title'))).toBe(false);

            await act(async () => {
                releaseInteractions?.();
            });
            await flushDeferredSettingsDelay();

            expect(findItemByTitle(screen.tree, 'settingsAgents.title')).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('defers below-fold settings sections until after interactions settle', async () => {
        const { SettingsView } = await import('./SettingsView');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

        vi.useFakeTimers();
        try {
            const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>, { flushOptions: { cycles: 0 } });

            expect(screen.findByTestId('settings-overview-account')).toBeTruthy();
            expect(screen.findByTestId('settings-overview-theme')).toBeTruthy();
            expect(Boolean(findItemByTitle(screen.tree, 'settingsAgents.title'))).toBe(false);
            expect(Boolean(findItemByTitle(screen.tree, 'settings.sessions'))).toBe(false);

            await flushDeferredSettingsDelay();

            expect(findItemByTitle(screen.tree, 'settingsAgents.title')).toBeTruthy();
            expect(Boolean(findItemByTitle(screen.tree, 'settings.sessions'))).toBe(false);
            expect(Boolean(findItemByTitle(screen.tree, 'settings.servers'))).toBe(false);
            expect(Boolean(findItemByTitle(screen.tree, 'settings.github'))).toBe(false);

            await flushDeferredSettingsDelay(20);

            expect(screen.findByTestId('settings-plugin-marketplace-item')).toBeTruthy();
            expect(Boolean(findItemByTitle(screen.tree, 'settings.sessions'))).toBe(false);
            expect(Boolean(findItemByTitle(screen.tree, 'settings.servers'))).toBe(false);
            expect(Boolean(findItemByTitle(screen.tree, 'settings.github'))).toBe(false);

            await flushDeferredSettingsDelay(20);

            expect(findItemByTitle(screen.tree, 'settings.sessions')).toBeTruthy();
            expect(findItemByTitle(screen.tree, 'settings.servers')).toBeTruthy();
            expect(Boolean(findItemByTitle(screen.tree, 'settings.github'))).toBe(false);

            await flushDeferredSettingsDelay(20);

            expect(findItemByTitle(screen.tree, 'settings.github')).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });
});
