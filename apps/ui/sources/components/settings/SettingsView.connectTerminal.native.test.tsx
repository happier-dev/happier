import * as React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks, settingsViewScanProcessAuthUrlSpy } from './settingsViewTestHelpers';


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

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (_cb: () => void) => {},
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: connectTerminalSpy, connectWithUrl: vi.fn(), isLoading: false }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null }),
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

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'gemini'],
    DEFAULT_AGENT_ID: 'agent_default',
    getAgentCore: () => ({ uiConnectedService: { serviceId: 'anthropic', labelKey: 'agentInput.agent.claude', connectRoute: null } }),
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

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 }),
    listServerProfiles: () => [],
    subscribeActiveServer: (listener: any) => {
        listener({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 });
        return () => {};
    },
}));

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

async function flushAllDeferredSettingsSections(): Promise<void> {
    await flushDeferredSettingsDelay();
    await flushDeferredSettingsDelay(20);
    await flushDeferredSettingsDelay(20);
    await flushDeferredSettingsDelay(20);
}

describe('SettingsView (native connect terminal)', () => {
    it('shows terminal connect actions on native platforms', async () => {
        vi.resetModules();
        const { SettingsView } = await import('./SettingsView');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(<SettingsView />)).tree;

        const items = tree.findAllByType('Item' as any);
        const scanItem = items.find((item: any) => item?.props?.testID === 'settings-connect-terminal-scan');
        const manualItem = items.find((item: any) => item?.props?.testID === 'settings-connect-terminal-enter-url');

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
        const tree = (await renderScreen(<SettingsView />)).tree;

        const items = tree.findAllByType('Item' as any);
        const manualItem = items.find((item: any) => item?.props?.testID === 'settings-connect-terminal-enter-url');
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
            const screen = await renderScreen(<SettingsView />, { flushOptions: { cycles: 0 } });

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
            const screen = await renderScreen(<SettingsView />, { flushOptions: { cycles: 0 } });

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

    it('keeps unaffected settings row props stable when rate-us availability updates', async () => {
        const rateUsAvailability = createDeferred<boolean>();
        requestReviewMockState.canRequestReview.mockReset();
        requestReviewMockState.canRequestReview.mockReturnValue(rateUsAvailability.promise);

        vi.resetModules();
        const { SettingsView } = await import('./SettingsView');

        const screen = await renderScreen(<SettingsView />, { flushOptions: { cycles: 0 } });
        await flushAllDeferredSettingsSections();

        const stableRowTitles = [
            'settings.account',
            'settings.appearance',
            'settingsAgents.title',
            'settings.sessions',
            'settings.servers',
        ];
        const iconsBefore = new Map<string, unknown>();
        for (const title of stableRowTitles) {
            const item = findItemByTitle(screen.tree, title);
            expect(item).toBeTruthy();
            iconsBefore.set(title, item!.props.icon);
        }

        await act(async () => {
            rateUsAvailability.resolve(true);
        });
        await flushHookEffects();

        expect(findItemByTitle(screen.tree, 'settings.rateUs')).toBeTruthy();
        for (const title of stableRowTitles) {
            const item = findItemByTitle(screen.tree, title);
            expect(item).toBeTruthy();
            expect(item!.props.icon).toBe(iconsBefore.get(title));
        }
    });
});
