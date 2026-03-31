import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});

vi.mock('expo-router', () => ({
    Slot: () => React.createElement('Slot', { testID: 'settings-layout-slot' }),
}));

vi.mock('@/components/settings/shell/SettingsShell', () => ({
    SettingsShell: (props: any) => React.createElement('SettingsShell', { testID: 'settings-shell' }, props.children),
}));

describe('/settings/_layout SettingsShell wiring', () => {
    it('wraps the settings route subtree in SettingsShell', async () => {
        const Layout = (await import('@/app/(app)/settings/_layout')).default;
        const screen = await renderScreen(React.createElement(Layout));

        expect(screen.findByTestId('settings-shell')).toBeTruthy();
        expect(screen.findByTestId('settings-layout-slot')).toBeTruthy();
    });
});
