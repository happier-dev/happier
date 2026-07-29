import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import {
    clearActiveUnsavedChangesGuard,
    setActiveUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const featureGateState = vi.hoisted(() => ({
    enabled: (_featureId: string) => true,
}));
const pathnameState = vi.hoisted(() => ({ value: '/settings' }));
const routerPushSpy = vi.hoisted(() => vi.fn());
const routerNavigateSpy = vi.hoisted(() => vi.fn());

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
        router: { navigate: routerNavigateSpy, push: routerPushSpy },
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
        routerNavigateSpy.mockReset();
        featureGateState.enabled = () => true;
        clearActiveUnsavedChangesGuard();
    });

    it('opens a sidebar destination within settings', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await screen.pressByTestIdAsync('settings-sidebar.item.notifications');
        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings/notifications');
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('exposes the Settings home page as the first/top-level entry', async () => {
        pathnameState.value = '/settings/account';

        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await screen.pressByTestIdAsync('settings-sidebar.item.settings');
        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings');
    });

    it('treats Settings as the parent node and can collapse/expand the rest of the tree', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        expect(screen.findByTestId('settings-sidebar.item.groupGeneral')).toBeTruthy();

        await screen.pressByTestIdAsync('settings-sidebar.toggle.settings');
        expect(screen.findByTestId('settings-sidebar.item.groupGeneral')).toBeNull();

        await screen.pressByTestIdAsync('settings-sidebar.toggle.settings');
        expect(screen.findByTestId('settings-sidebar.item.groupGeneral')).toBeTruthy();
    });

    it('supports page search and navigates when selecting a result', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await act(async () => {
            screen.changeTextByTestId('settings-sidebar.searchInput', 'notif');
        });

        const row = screen.findByTestId('settings-sidebar.searchResult.notifications') as any;
        expect(row).toBeTruthy();
        const iconNames = row.findAllByType('Ionicons').map((node: any) => node.props?.name).filter(Boolean);
        expect(iconNames).toContain('search-outline');
        expect(iconNames).not.toContain('chevron-forward');

        await screen.pressByTestIdAsync('settings-sidebar.searchResult.notifications');

        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings/notifications');
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('keeps the current settings screen when a route row encounters dirty active work', async () => {
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: true },
            requestDecision,
            tag: 'SettingsSidebar.test.route',
        });
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await screen.pressByTestIdAsync('settings-sidebar.item.notifications');

        expect(requestDecision).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('discards dirty active work before navigating through a route row', async () => {
        const isDirtyRef = { current: true };
        const requestDecision = vi.fn(async () => 'discard' as const);
        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision,
            tag: 'SettingsSidebar.test.discardRoute',
        });
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await screen.pressByTestIdAsync('settings-sidebar.item.notifications');

        expect(requestDecision).toHaveBeenCalledTimes(1);
        expect(isDirtyRef.current).toBe(false);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings/notifications');
    });

    it('keeps the current settings screen when a search result encounters dirty active work', async () => {
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: true },
            requestDecision,
            tag: 'SettingsSidebar.test.search',
        });
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));
        await act(async () => {
            screen.changeTextByTestId('settings-sidebar.searchInput', 'notif');
        });

        await screen.pressByTestIdAsync('settings-sidebar.searchResult.notifications');

        expect(requestDecision).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('finds the appearance page when searching for sidebar', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await act(async () => {
            screen.changeTextByTestId('settings-sidebar.searchInput', 'sidebar');
        });

        await screen.pressByTestIdAsync('settings-sidebar.searchResult.appearance');
        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings/appearance');
    });

    it('swaps expandable item icons to chevrons on hover', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        const row = screen.findByTestId('settings-sidebar.item.groupGeneral') as any;
        expect(row).toBeTruthy();
        const iconNamesBefore = row.findAllByType('Ionicons').map((node: any) => node.props?.name).filter(Boolean);
        expect(iconNamesBefore).toContain('settings-outline');
        expect(iconNamesBefore).not.toContain('chevron-down');
        expect(iconNamesBefore).not.toContain('chevron-forward');

        await act(async () => {
            row.props.onHoverIn?.();
        });

        const rowHovered = screen.findByTestId('settings-sidebar.item.groupGeneral') as any;
        expect(rowHovered).toBeTruthy();
        const iconNamesHovered = rowHovered.findAllByType('Ionicons').map((node: any) => node.props?.name).filter(Boolean);
        expect(iconNamesHovered).toContain('chevron-down');

        await act(async () => {
            rowHovered.props.onHoverOut?.();
        });

        const rowAfter = screen.findByTestId('settings-sidebar.item.groupGeneral') as any;
        expect(rowAfter).toBeTruthy();
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
        expect(routerNavigateSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-sidebar.item.machinesAdd')).toBeTruthy();
    });
});
