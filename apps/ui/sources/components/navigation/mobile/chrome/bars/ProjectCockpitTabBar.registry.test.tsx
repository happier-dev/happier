import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { storage } from '@/sync/domains/state/storageStore';
import { createPluginPagePlacementFixture } from '@/dev/testkit/fixtures/pluginPageProjectionFixture';

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

const { ProjectCockpitTabBar, useProjectCockpitBarPresentation } = await import('./ProjectCockpitTabBar');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { resolveProjectPageCatalog } = await import('@/components/projects/detail/projectPageCatalog');
const { resolveReasonCopy } = await import('@/sync/domains/surfaces/copy');
const pages = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' } });

describe('Project phone registry launchers', () => {
    let initialState: ReturnType<typeof storage.getState>;
    beforeEach(() => {
        initialState = storage.getState();
        storage.setState({ settings: { ...initialState.settings, tabBarShowLabels: true, tabBarSize: 'regular' }, isDataReady: true });
    });
    afterEach(() => { standardCleanup(); storage.setState(initialState, true); });

    it('keeps both declared count labels in the pinned announcement and explicit More presentation', async () => {
        const page = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' },
            placements: [createPluginPagePlacementFixture({ pluginId: 'external.tools', localId: 'builds', title: 'Builds' })] }).at(-1)!;
        const counted = { ...page, count: 'Running 2, Failed 1', counts: [
            { field: 'running', label: 'Running', count: 2 }, { field: 'failed', label: 'Failed', count: 1 },
        ] };
        const view = <ProjectCockpitTabBar pages={[counted]} workspaceRefId="project" activeSurface="overview"
            activePageId={page.id} onSurfacePress={() => {}} />;
        const screen = await renderScreen(view);
        const announcement = screen.findHostByTestId(`project-cockpit-tab-${page.id}`)?.props.accessibilityLabel;
        expect(announcement).toContain('Running 2');
        expect(announcement).toContain('Failed 1');
        // The pill names the page; its counts travel in the announcement, never in a label that wraps out of the cell.
        expect(screen.getTextContent()).toContain('Builds');
        expect(screen.getTextContent()).not.toContain('Running 2');
        await act(async () => { storage.setState({ localSettings: { ...storage.getState().localSettings,
            navigationSurfacePlacementsV1: { detailPages: { project: { phone: { items: { orderedIds: [], placements: { [page.id]: 'overflow' } } } } } } } }); });
        await screen.update(view);
        expect(screen.root.findByType(DropdownMenu).props.items.find((item: { id: string }) => item.id === page.id)?.subtitle)
            .toBe(counted.count);
        expect(screen.findHostByTestId('project-cockpit-tab-more')?.props.accessibilityLabel).toContain(counted.count);
    });

    it('retains authored disabled explanations in pinned accessibility and overflow details', async () => {
        const placement = createPluginPagePlacementFixture({ pluginId: 'external.tools', localId: 'builds', title: 'Builds' });
        const descriptors = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' },
            placements: [{ ...placement, availability: { ...placement.availability,
                disabledWhen: { fact: 'project.exists', operator: 'equals', value: true },
                disabledReason: 'Builds are paused for this Project' } }],
            policyContext: { data: { project: { exists: true } } } });
        const external = descriptors.at(-1)!;
        const view = <ProjectCockpitTabBar pages={[external]} workspaceRefId="project" activeSurface="overview" onSurfacePress={() => {}} />;
        const screen = await renderScreen(view);
        expect(screen.findHostByTestId(`project-cockpit-tab-${external.id}`)?.props.accessibilityHint).toBe(external.disabledReason);
        await act(async () => { storage.setState({ localSettings: { ...storage.getState().localSettings,
            navigationSurfacePlacementsV1: { detailPages: { project: { phone: { items: { orderedIds: [], placements: { [external.id]: 'overflow' } } } } } } } }); });
        await screen.update(view);
        const item = screen.root.findByType(DropdownMenu).props.items.find((item: { id: string }) => item.id === external.id);
        expect(item).toMatchObject({ disabled: true, subtitle: external.disabledReason });
    });

    it('gives Terminal a slot on the bar while the Project\'s Shells are open, keeping every page reachable', async () => {
        const bar = (terminalsOpen: boolean) => <ProjectCockpitTabBar pages={pages} workspaceRefId="project" activePage="overview"
            activeSurface="overview" terminalTabAvailable terminalsOpen={terminalsOpen} onSurfacePress={() => {}} />;
        const screen = await renderScreen(bar(false));
        const menuIds = () => screen.root.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id);
        expect(screen.findHostByTestId('project-cockpit-tab-terminal')).toBeFalsy();
        expect(menuIds()).toContain('terminal');
        await screen.update(bar(true));
        expect(screen.findHostByTestId('project-cockpit-tab-terminal')).toBeTruthy();
        expect(menuIds()).not.toContain('terminal');
        // A page Terminal displaces is one More away, never gone.
        for (const page of pages) {
            expect(Boolean(screen.findHostByTestId(`project-cockpit-tab-${page.id}`)) || menuIds().includes(page.id)).toBe(true);
        }
        await screen.update(bar(false));
        expect(screen.findHostByTestId('project-cockpit-tab-terminal')).toBeFalsy();
        // On the Terminal page itself, Terminal is selected in its own slot and More stays More.
        await screen.update(<ProjectCockpitTabBar pages={pages} workspaceRefId="project" activePage="overview"
            activeSurface="terminal" terminalTabAvailable terminalsOpen onSurfacePress={() => {}} />);
        expect(screen.findHostByTestId('project-cockpit-tab-more')?.props.accessibilityLabel).not.toBe(screen.findHostByTestId('project-cockpit-tab-terminal')?.props.accessibilityLabel);
    });

    it('hides unavailable Terminal without losing the retained companion selection', async () => {
        const bar = (available: boolean) => <ProjectCockpitTabBar pages={pages} workspaceRefId="project" activePage="overview"
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
        const screen = await renderScreen(<ProjectCockpitTabBar pages={pages} workspaceRefId="project" activePage="code"
            activeSurface="browse" terminalTabAvailable={false} onSurfacePress={() => {}} />);
        const ids: string[] = screen.root.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id);
        expect(ids).not.toContain('browse');
        expect(ids).toContain('tabs');
        expect(new Set(ids).size).toBe(ids.length);
        for (const page of ['scripts', 'services']) {
            expect(Number(screen.findHostByTestId(`project-cockpit-tab-${page}`) !== null) + ids.filter(id => id === page).length).toBe(1);
        }
        expect(screen.findHostByTestId('project-cockpit-tab-code')?.props.accessibilityState?.selected).toBe(true);
    });

    it('uses device placements for external pages and retains their exact selected identity in More', async () => {
        const descriptors = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' },
            placements: [createPluginPagePlacementFixture({ pluginId: 'external.tools', localId: 'builds', title: 'Builds' }),
                createPluginPagePlacementFixture({ pluginId: 'external.tools', localId: 'releases', title: 'Releases',
                    availability: { state: 'disabled', reason: 'plugin_disabled', diagnostics: [] } })] });
        const plugin = descriptors.find(page => page.id === 'plugin:external.tools:builds')!;
        const disabled = descriptors.find(page => page.id === 'plugin:external.tools:releases')!;
        storage.setState({ localSettings: { ...storage.getState().localSettings,
            navigationSurfacePlacementsV1: { detailPages: { project: { phone: { items: { orderedIds: [plugin.id, 'overview'],
                placements: { [plugin.id]: 'overflow', [disabled.id]: 'overflow', code: 'hidden' } } } } } } } });
        const selected: string[] = [];
        const screen = await renderScreen(<ProjectCockpitTabBar pages={descriptors}
            workspaceRefId="project" activeSurface="overview" activePageId={plugin.id}
            onPagePress={id => selected.push(id)} onSurfacePress={() => {}} />);
        const menu = screen.root.findByType(DropdownMenu);
        expect(menu.props.selectedId).toBe(plugin.id);
        expect(menu.props.items.find((item: { id: string }) => item.id === plugin.id)).toMatchObject({ checked: true });
        expect(menu.props.items.find((item: { id: string }) => item.id === disabled.id)).toMatchObject({ disabled: true });
        expect(menu.props.items.find((item: { id: string }) => item.id === disabled.id)?.subtitle)
            .toBe(resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: 'plugin_disabled' }).body);
        expect(menu.props.items.some((item: { id: string }) => item.id === 'code')).toBe(false);
        expect(screen.findHostByTestId('project-cockpit-tab-more')?.props.accessibilityState?.selected).toBe(true);
        await menu.props.onSelect(plugin.id);
        expect(selected).toEqual([plugin.id]);
        expect(menu.props.items.some((item: { id: string }) => item.id === 'customize')).toBe(true);
        expect(storage.getState().localSettings.navigationSurfacePlacementsV1?.detailPages?.project?.phone?.items?.placements.code).toBe('hidden');
    });
});


it('uses the Project phone branch for pages and companions while preserving desktop placement', async () => {
    const initial = storage.getState();
    try {
        storage.setState({ localSettings: { ...initial.localSettings, navigationSurfacePlacementsV1: {
            projectTabBar: { orderedIds: [], placements: { changes: 'hidden' } },
            detailPages: { project: { phone: { items: { orderedIds: ['overview', 'changes', 'tabs'],
                placements: { changes: 'pinned', tabs: 'pinned' } } } } },
        } } });
        const selected: string[] = [];
        const screen = await renderScreen(<ProjectCockpitTabBar pages={pages} workspaceRefId="project" activeSurface="overview"
            onPagePress={id => selected.push(id)} onSurfacePress={id => selected.push(id)} />);
        expect(screen.findHostByTestId('project-cockpit-tab-changes')).toBeTruthy();
        expect(screen.findHostByTestId('project-cockpit-tab-tabs')).toBeTruthy();
        await screen.pressByTestId('project-cockpit-tab-changes');
        expect(selected).toEqual(['changes']);
        expect(storage.getState().localSettings.navigationSurfacePlacementsV1.projectTabBar?.placements.changes).toBe('hidden');
    } finally { standardCleanup(); storage.setState(initial, true); }
});

it('opens one Project customizer with desktop pages, companions and the independent phone list', async () => {
    const { renderHook } = await import('@/dev/testkit');
    const hook = await renderHook(() => useProjectCockpitBarPresentation({ pages, workspaceRefId: 'project',
        activeSurface: 'changes', activePage: 'changes', terminalTabAvailable: true, onSurfacePress: () => {} }));
    const customizer = Reflect.get(hook.getCurrent(), 'customizer');
    expect(customizer).toMatchObject({ pageKind: 'project', device: 'phone', phonePageTabs: true,
        desktop: [{ id: 'pages', address: { pageKind: 'project', device: 'desktop', section: 'pages' },
            items: expect.arrayContaining([expect.objectContaining({ id: 'changes' })]) },
        { id: 'companions', address: { pageKind: 'project', device: 'desktop', section: 'companions' },
            items: expect.arrayContaining([expect.objectContaining({ id: 'git' })]) }],
        phone: [{ address: { pageKind: 'project', device: 'phone', section: 'items' },
            items: expect.arrayContaining([expect.objectContaining({ id: 'changes' }), expect.objectContaining({ id: 'terminal' })]) }],
    });
    expect(customizer.phone[0].items.map((item: { id: string }) => item.id)).not.toContain('git');
});
