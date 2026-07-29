import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Stack } from 'expo-router';
import { act } from 'react-test-renderer';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let translationPrefix = 'en';

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        Platform: {
            OS: 'web',
            select: (options: any) => (options && 'web' in options ? options.web : options?.default),
        },
        useWindowDimensions: () => ({
            width: 390,
            height: 844,
            scale: 2,
            fontScale: 1,
        }),
        Dimensions: {
            get: () => ({
                width: 390,
                height: 844,
                scale: 2,
                fontScale: 1,
            }),
        },
        PanResponder: {
            create: () => ({ panHandlers: {} }),
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => '/settings/agents/codex',
        router: {
            push: vi.fn(),
            back: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        },
    }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key) => `${translationPrefix}:${key}`,
        translateLoose: (key) => `${translationPrefix}:${key}`,
        getPreferredLanguage: () => translationPrefix,
    });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: ((key: string) => {
                if (key === 'useProfiles') return false;
                return null;
            }) as any,
            useLocalSetting: ((key: string) => {
                if (key === 'settingsNavSidebarEnabled') return true;
                if (key === 'settingsNavSidebarWidthPx') return 240;
                if (key === 'settingsNavSidebarWidthBasisPx') return 1440;
                if (key === 'uiFontScale') return 1;
                if (key === 'devModeEnabled') return false;
                return null;
            }) as any,
            useLocalSettingMutable: ((key: string) => {
                if (key === 'settingsNavSidebarWidthPx') return [240, vi.fn()];
                if (key === 'settingsNavSidebarWidthBasisPx') return [1440, vi.fn()];
                return [null, vi.fn()];
            }) as any,
        },
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/navigation/Header', () => ({
    createHeader: () => null,
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
}));

afterEach(() => {
    standardCleanup();
    translationPrefix = 'en';
});

describe('SettingsLayoutRoute stack registration', () => {
    it('registers provider settings screens explicitly in the settings stack', async () => {
        const { default: SettingsLayoutRoute } = await import('@/app/(app)/settings/_layout');

        const screen = await renderScreen(<SettingsLayoutRoute />);
        const screenNames = (screen.findAllByType(Stack.Screen) ?? [])
            .map((node) => node.props?.name)
            .filter((name): name is string => typeof name === 'string');

        expect(screenNames).toContain('agents/index');
        expect(screenNames).not.toContain('providers');
        expect(screenNames).toContain('agents/[agentId]');
        expect(screenNames).toContain('plugins/index');
        expect(screenNames).toContain('plugins/[pluginId]');
        expect(screenNames).toContain('actions');
        expect(screenNames).toContain('actions/[actionId]');
    });

    it('refreshes stack chrome translations when the language changes and the route rerenders', async () => {
        translationPrefix = 'en';
        const mod = await import('@/app/(app)/settings/_layout');
        const SettingsLayoutRoute = (mod.default as unknown as {
            type: React.ComponentType<Record<string, never>>;
        }).type;

        const screen = await renderScreen(<SettingsLayoutRoute />);
        const readProvidersScreen = () => (
            screen.findAllByType(Stack.Screen).find((node) => node.props?.name === 'agents/[agentId]')
        );
        const readIndexScreen = () => (
            screen.findAllByType(Stack.Screen).find((node) => node.props?.name === 'index')
        );
        const readStack = () => screen.findByType(Stack as never);

        expect(readStack().props.screenOptions?.headerBackTitle).toBe('en:common.back');
        expect(readProvidersScreen()?.props.options?.headerTitle).toBe('en:settingsAgents.title');
        expect(readIndexScreen()?.props.options?.headerBackTitle).toBe('en:common.home');

        translationPrefix = 'fr';
        await act(async () => {
            await screen.update(<SettingsLayoutRoute />);
        });

        expect(readStack().props.screenOptions?.headerBackTitle).toBe('fr:common.back');
        expect(readProvidersScreen()?.props.options?.headerTitle).toBe('fr:settingsAgents.title');
        expect(readIndexScreen()?.props.options?.headerBackTitle).toBe('fr:common.home');
    });
});
