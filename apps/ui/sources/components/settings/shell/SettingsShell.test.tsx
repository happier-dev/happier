import * as React from 'react';
import { act } from 'react-test-renderer';
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
    ResizableDockedPane: (props: any) => React.createElement('ResizableDockedPane', props, props.children),
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
        useLocalSettingMutable: () => [320, vi.fn()],
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

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'StyledText',
    TextInput: 'TextInput',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));

describe('SettingsShell', () => {
    afterEach(() => {
        windowDimsState.width = 1600;
        windowDimsState.height = 900;
        localSettingsState.values.set('settingsNavSidebarWidthPx', 230);
        localSettingsState.values.set('settingsNavSidebarWidthBasisPx', 1200);
        localSettingsState.values.set('settingsNavSidebarEnabled', true);
    });

    it('renders children without the sidebar on non-tablet layouts', async () => {
        windowDimsState.width = 390;
        windowDimsState.height = 844;
        const { SettingsShell } = await import('./SettingsShell');
        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' }))
        );

        expect(screen.findByTestId('settings-sidebar')).toBeNull();
        expect(screen.findByTestId('child')).toBeTruthy();
    });

    it('renders the settings sidebar on tablet/desktop layouts', async () => {
        const { SettingsShell } = await import('./SettingsShell');
        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' }))
        );

        expect(screen.findByTestId('settings-sidebar')).toBeTruthy();
        expect(screen.findByTestId('child')).toBeTruthy();
    });

    it('docks the nav rail on the left, with the resize handle on its inner (right) edge', async () => {
        const { SettingsShell } = await import('./SettingsShell');
        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' }))
        );

        // A left-docked rail keeps its drag handle on the boundary with the content
        // pane (its right edge), so `resizeEdge` is 'right'.
        expect(screen.findByType('ResizableDockedPane').props.resizeEdge).toBe('right');
    });

    it('uses the default sidebar width when the local width setting is missing', async () => {
        localSettingsState.values.delete('settingsNavSidebarWidthPx');
        windowDimsState.width = 1600;
        const { SettingsShell } = await import('./SettingsShell');
        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' }))
        );

        expect(screen.findByTestId('settings-sidebar')).toBeTruthy();
        expect(screen.findByType('ResizableDockedPane').props.widthPx).toBe(230);
    });

    it('hides the settings sidebar when disabled by local settings', async () => {
        localSettingsState.values.set('settingsNavSidebarEnabled', false);
        const { SettingsShell } = await import('./SettingsShell');
        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' }))
        );

        expect(screen.findByTestId('settings-sidebar')).toBeNull();
        expect(screen.findByTestId('child')).toBeTruthy();
    });

    it('can switch from phone to desktop layout without changing hook order', async () => {
        windowDimsState.width = 390;
        windowDimsState.height = 844;
        const { SettingsShell } = await import('./SettingsShell');
        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' })),
        );

        windowDimsState.width = 1600;
        windowDimsState.height = 900;

        await expect(act(async () => {
            screen.tree.update(
                React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' })),
            );
        })).resolves.toBeUndefined();
        expect(screen.findByTestId('settings-sidebar')).toBeTruthy();
    });
});
