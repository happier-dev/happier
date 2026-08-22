import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        PanResponder: {
            create: () => ({ panHandlers: {} }),
        },
        useWindowDimensions: () => ({
            width: 1440,
            height: 900,
            scale: 2,
            fontScale: 1,
        }),
        Dimensions: {
            get: () => ({
                width: 1440,
                height: 900,
                scale: 2,
                fontScale: 1,
            }),
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => '/settings',
        router: {
            push: vi.fn(),
            back: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        },
    }).module;
});

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/desktopHost')>();
    return {
        ...actual,
        isDesktopHost: () => true,
    };
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

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

describe('/settings desktop shell sidebar stability', () => {
    it('does not crash when rendering SettingsShell + SettingsSidebar on desktop', async () => {
        const { SettingsShell } = await import('@/components/settings/shell/SettingsShell');

        const screen = await renderScreen(
            <SettingsShell>
                <React.Fragment />
            </SettingsShell>,
        );

        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeTruthy();
        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
    });
});
