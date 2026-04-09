import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const windowDimsState = vi.hoisted(() => ({ width: 1600, height: 900 }));

vi.mock('@/components/ui/panels/ResizableDockedPane', () => ({
    ResizableDockedPane: (props: any) => React.createElement('ResizableDockedPane', props, props.children),
}));

vi.mock('@/components/settings/shell/SettingsSidebar', () => ({
    // Simulate the production crash signature: "Element type is invalid" (undefined component export).
    SettingsSidebar: undefined,
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
        useLocalSetting: (key: string) => {
            if (key === 'settingsNavSidebarWidthPx') return 230;
            if (key === 'settingsNavSidebarWidthBasisPx') return 1200;
            if (key === 'settingsNavSidebarEnabled') return true;
            return null;
        },
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

describe('SettingsShell sidebar crash boundary', () => {
    it('does not crash when the sidebar subtree is an invalid element and falls back for the current render only', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { SettingsShell } = await import('./SettingsShell');

        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' })),
        );

        expect(screen.findByTestId('child')).toBeTruthy();
        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeNull();
        expect(
            consoleErrorSpy.mock.calls.some((call) => call.some((entry) => String(entry).includes('Element type is invalid'))),
        ).toBe(false);
        consoleErrorSpy.mockRestore();
    });
});
