import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const windowDimsState = vi.hoisted(() => ({ width: 1600, height: 900 }));
const setSettingsNavSidebarEnabled = vi.hoisted(() => vi.fn());
const declaredScreenNames = vi.hoisted(() => [] as string[]);
const routerMock = createExpoRouterMock();

vi.mock('@/components/settings/shell/SettingsSidebar', () => ({
    // Simulate a bad export in production bundles, which previously crashed /settings.
    SettingsSidebar: undefined,
}));

vi.mock('@/components/ui/panels/ResizableDockedPane', () => ({
    ResizableDockedPane: (props: any) => React.createElement('ResizableDockedPane', props, props.children),
}));

vi.mock('expo-router', () => ({
    ...routerMock.module,
    Stack: Object.assign(
        (props: any) => React.createElement('Stack', { testID: 'settings-layout-stack' }, props.children),
        {
            Screen: (props: any) => {
                declaredScreenNames.push(props?.name ?? '');
                return React.createElement('Stack.Screen', { name: props?.name ?? '' });
            },
        },
    ),
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
        useLocalSettingMutable: (key: string) => {
            if (key === 'settingsNavSidebarEnabled') {
                return [true, setSettingsNavSidebarEnabled];
            }
            return [null, vi.fn()];
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/navigation/Header', () => ({
    createHeader: () => null,
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('/settings/_layout sidebar crash boundary', () => {
    it('renders without crashing when the sidebar subtree is an invalid element', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        declaredScreenNames.length = 0;
        const Layout = (await import('@/app/(app)/settings/_layout')).default;

        const screen = await renderScreen(React.createElement(Layout));

        expect(screen.findByTestId('settings-layout-stack')).toBeTruthy();
        expect(setSettingsNavSidebarEnabled).not.toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
    });

    it('declares the provider index route with the canonical nested screen name', async () => {
        declaredScreenNames.length = 0;
        const Layout = (await import('@/app/(app)/settings/_layout')).default;

        await renderScreen(React.createElement(Layout));

        expect(declaredScreenNames).toContain('agents/index');
        expect(declaredScreenNames).toContain('agents/[agentId]');
        expect(declaredScreenNames).not.toContain('providers');
    });
});
