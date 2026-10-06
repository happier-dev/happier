import * as React from 'react';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { flushHookEffects, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
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
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
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
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useEntitlement: () => false,
            useLocalSettingMutable: () => [false, vi.fn()],
            useSetting: () => null,
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useProfile: () => ({ id: 'prof_1', firstName: '', connectedServices: [] }),
        });
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'StyledText',
    TextInput: 'TextInput',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({ useFocusEffect: () => {} });
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));

vi.mock('@/constants/Typography', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/constants/Typography')>();
    return {
        ...actual,
        Typography: {
            ...actual.Typography,
            default: () => ({}),
            mono: () => ({}),
            rowMeta: () => ({}),
        },
    };
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    // The row's actions (its right element) render inside it, as the real row does.
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
}));

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

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => false,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
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
    return tree.findAllByType('Item' as any).find((item: any) => item?.props?.title === title);
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


describe('SettingsView (native connect terminal)', () => {
    it('shows terminal connect actions on native platforms', async () => {
        vi.resetModules();
        const { SettingsView } = await import('./SettingsView');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>)).tree;

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
        vi.resetModules();
        promptSpy.mockReset();
        promptSpy.mockResolvedValueOnce('happier://terminal?key=abc123&server=https%3A%2F%2Frelay.example.test');
        settingsViewScanProcessAuthUrlSpy.mockReset();
        settingsViewScanProcessAuthUrlSpy.mockResolvedValueOnce(true);

        const { SettingsView } = await import('./SettingsView');
        const tree = (await renderScreen(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>)).tree;

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

        vi.resetModules();
        const { SettingsView } = await import('./SettingsView');

        vi.useFakeTimers();
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>, { flushOptions: { cycles: 0 } });

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
        vi.resetModules();
        const { SettingsView } = await import('./SettingsView');

        vi.useFakeTimers();
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>, { flushOptions: { cycles: 0 } });

            expect(findItemByTitle(screen.tree, 'settings.account')).toBeTruthy();
            expect(findItemByTitle(screen.tree, 'settings.appearance')).toBeTruthy();
            expect(Boolean(findItemByTitle(screen.tree, 'settingsAgents.title'))).toBe(false);
            expect(Boolean(findItemByTitle(screen.tree, 'settings.sessions'))).toBe(false);

            await flushDeferredSettingsDelay();

            expect(findItemByTitle(screen.tree, 'settingsAgents.title')).toBeTruthy();
            expect(Boolean(findItemByTitle(screen.tree, 'settings.sessions'))).toBe(false);
            expect(Boolean(findItemByTitle(screen.tree, 'settings.servers'))).toBe(false);
            expect(Boolean(findItemByTitle(screen.tree, 'settings.github'))).toBe(false);

            await flushDeferredSettingsDelay(20);

            expect(findItemByTitle(screen.tree, 'settings.sessions')).toBeTruthy();
            expect(Boolean(findItemByTitle(screen.tree, 'settings.servers'))).toBe(false);
            expect(Boolean(findItemByTitle(screen.tree, 'settings.github'))).toBe(false);

            await flushDeferredSettingsDelay(20);

            expect(findItemByTitle(screen.tree, 'settings.servers')).toBeTruthy();
            expect(Boolean(findItemByTitle(screen.tree, 'settings.github'))).toBe(false);

            await flushDeferredSettingsDelay(20);

            expect(findItemByTitle(screen.tree, 'settings.github')).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });
});
