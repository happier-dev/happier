import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const windowDimsState = vi.hoisted(() => ({ width: 1600, height: 900 }));
const localSettingsState = vi.hoisted(() => ({
    values: new Map<string, unknown>([
        ['settingsNavSidebarWidthPx', 230],
        ['settingsNavSidebarWidthBasisPx', 1200],
        ['settingsNavSidebarEnabled', true],
    ]),
}));

vi.mock('@/components/ui/panels/ResizableDockedPane', () => ({
    ResizableDockedPane: undefined,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Platform: {
            OS: 'web',
            select: (options: any) => (options && 'default' in options ? options.default : undefined),
        },
        useWindowDimensions: () => ({ width: windowDimsState.width, height: windowDimsState.height, scale: 2, fontScale: 1 }),
    });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => localSettingsState.values.get(key) ?? null,
        useLocalSettingMutable: () => [null, vi.fn()],
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));

describe('SettingsShell ResizableDockedPane missing export', () => {
    afterEach(() => {
        windowDimsState.width = 1600;
        windowDimsState.height = 900;
        localSettingsState.values.set('settingsNavSidebarWidthPx', 230);
        localSettingsState.values.set('settingsNavSidebarWidthBasisPx', 1200);
        localSettingsState.values.set('settingsNavSidebarEnabled', true);
    });

    it('does not crash the settings shell when the resizable pane component is missing', async () => {
        const { SettingsShell } = await import('./SettingsShell');

        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' })),
        );

        expect(screen.findByTestId('child')).toBeTruthy();
        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeNull();
        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
    });

    it('does not change hook order when the sidebar becomes disabled after an initial desktop render', async () => {
        const { SettingsShell } = await import('./SettingsShell');

        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' })),
        );

        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeNull();

        windowDimsState.width = 390;
        windowDimsState.height = 844;

        await expect(
            screen.update(
                React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' })),
            ),
        ).resolves.toBeUndefined();

        expect(screen.findByTestId('child')).toBeTruthy();
        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeNull();
    });
});
