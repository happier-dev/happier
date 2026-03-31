import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const featureGateState = vi.hoisted(() => ({
    enabled: (_featureId: string) => true,
}));
const pathnameState = vi.hoisted(() => ({ value: '/settings' }));
const routerPushSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        Text: 'Text',
        Platform: {
            OS: 'web',
            select: (options: any) => (options && 'default' in options ? options.default : undefined),
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => pathnameState.value,
        router: { push: routerPushSpy },
    }).module;
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureGateState.enabled(featureId),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: (key: string) => {
            if (key === 'useProfiles') return false;
            return null;
        },
        useLocalSetting: (key: string) => {
            if (key === 'devModeEnabled') return false;
            if (key === 'uiFontScale') return 1;
            return null;
        },
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

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: async () => {},
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'StyledText',
    TextInput: 'TextInput',
}));

describe('SettingsSidebar', () => {
    afterEach(() => {
        pathnameState.value = '/settings';
        routerPushSpy.mockReset();
        featureGateState.enabled = () => true;
    });

    it('navigates to a page when pressing a nav item', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await screen.pressByTestIdAsync('settings-sidebar.item.notifications');
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/notifications');
    });

    it('supports page search and navigates when selecting a result', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await act(async () => {
            screen.changeTextByTestId('settings-sidebar.searchInput', 'notif');
        });
        await screen.pressByTestIdAsync('settings-sidebar.searchResult.notifications');

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/notifications');
    });

    it('swaps expandable item icons to chevrons on hover', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        const row = screen.findByTestId('settings-sidebar.item.groupGeneral');
        const iconNamesBefore = row.findAllByType('Ionicons').map((node: any) => node.props?.name).filter(Boolean);
        expect(iconNamesBefore).toContain('settings-outline');
        expect(iconNamesBefore).not.toContain('chevron-down');
        expect(iconNamesBefore).not.toContain('chevron-forward');

        await act(async () => {
            row.props.onHoverIn?.();
        });

        const rowHovered = screen.findByTestId('settings-sidebar.item.groupGeneral');
        const iconNamesHovered = rowHovered.findAllByType('Ionicons').map((node: any) => node.props?.name).filter(Boolean);
        expect(iconNamesHovered).toContain('chevron-down');

        await act(async () => {
            rowHovered.props.onHoverOut?.();
        });

        const rowAfter = screen.findByTestId('settings-sidebar.item.groupGeneral');
        const iconNamesAfter = rowAfter.findAllByType('Ionicons').map((node: any) => node.props?.name).filter(Boolean);
        expect(iconNamesAfter).toContain('settings-outline');
    });

    it('allows expanding a routed parent item via the hover chevron toggle', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        const machinesRow: any = screen.findByTestId('settings-sidebar.item.machines');
        expect(machinesRow).toBeTruthy();

        await act(async () => {
            machinesRow.props.onHoverIn?.();
        });

        await screen.pressByTestIdAsync('settings-sidebar.toggle.machines');
        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-sidebar.item.machinesAdd')).toBeTruthy();
    });
});
