import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { storage } from '@/sync/domains/state/storageStore';

installUiListsCommonModuleMocks({ reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) });
} });
vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), initialWindowMetrics: null,
}));
vi.mock('expo-blur', () => ({ BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement('BlurView', props, children) }));

const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

describe('Project phone registry launchers', () => {
    let initialState: ReturnType<typeof storage.getState>;
    beforeEach(() => {
        initialState = storage.getState();
        storage.setState({ settings: { ...initialState.settings, tabBarShowLabels: true, tabBarSize: 'regular' }, isDataReady: true });
    });
    afterEach(() => { standardCleanup(); storage.setState(initialState, true); });

    it('hides unavailable Terminal without losing the retained companion selection', async () => {
        const bar = (available: boolean) => <ProjectCockpitTabBar workspaceRefId="project" activePage="overview"
            activeSurface="terminal" terminalTabAvailable={available} onSurfacePress={() => {}} />;
        const screen = await renderScreen(bar(true));
        expect(screen.root.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id)).toContain('terminal');
        await screen.update(bar(false));
        const menu = screen.root.findByType(DropdownMenu);
        expect(menu.props.items.map((item: { id: string }) => item.id)).not.toContain('terminal');
        expect(menu.props.selectedId).toBeNull();
        expect(screen.findHostByTestId('project-cockpit-tab-more')?.props.accessibilityState?.selected).toBe(true);
        expect(screen.getTextContent()).toContain('settings.terminal');
    });

    it('suppresses Files on Code while keeping its selection and each canonical page reachable once', async () => {
        const screen = await renderScreen(<ProjectCockpitTabBar workspaceRefId="project" activePage="code"
            activeSurface="browse" terminalTabAvailable={false} onSurfacePress={() => {}} />);
        const ids: string[] = screen.root.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id);
        expect(ids).not.toContain('browse');
        expect(ids).toContain('tabs');
        expect(new Set(ids).size).toBe(ids.length);
        for (const page of ['scripts', 'services']) {
            expect(Number(screen.findHostByTestId(`project-cockpit-tab-${page}`) !== null) + ids.filter(id => id === page).length).toBe(1);
        }
        expect(screen.findHostByTestId('project-cockpit-tab-more')?.props.accessibilityState?.selected).toBe(true);
        expect(screen.getTextContent()).toContain('common.files');
    });
});
