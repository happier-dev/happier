import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { RightSidebarIconTabBar } from './RightSidebarIconTabBar';
import { getRightSidebarBuiltinTab, resolveRightSidebarTabs } from './rightSidebarTabRegistry';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// The 44 px touch floor applies when the primary pointer is a finger; the browser media query is the boundary.
vi.mock('@/utils/platform/webMobileHeuristics', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/webMobileHeuristics')>(),
    isCoarsePrimaryPointerEnvironment: () => true,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => `en:${key}` });
});

describe('RightSidebarIconTabBar', () => {
    it('moves keyboard selection through enabled tabs and exposes one tab stop', async () => {
        const onSelectTab = vi.fn();
        const tabs = resolveRightSidebarTabs({ scope: 'session', presentation: 'mobile' });
        const screen = await renderScreen(<RightSidebarIconTabBar tabs={tabs} activeTabId="files" onSelectTab={onSelectTab} />);
        const files = screen.findByTestId('right-sidebar-tab:files');
        expect(files?.props.tabIndex).toBe(0);
        const event = { key: 'End', preventDefault: vi.fn() };
        files?.props.onKeyDown(event);
        expect(onSelectTab).toHaveBeenLastCalledWith(tabs[tabs.length - 1]!.id);
        expect(event.preventDefault).toHaveBeenCalled();
        expect(screen.findByTestId(`right-sidebar-tab:${tabs[tabs.length - 1]!.id}`)?.props.tabIndex).toBe(-1);
    });
    it('draws every tab at its design square; a finger reaches 44 through the hit area', async () => {
        const tabs = resolveRightSidebarTabs({ scope: 'session', presentation: 'mobile' });

        const screen = await renderScreen(
            <RightSidebarIconTabBar
                tabs={tabs}
                activeTabId="files"
                onSelectTab={() => {}}
                testIDPrefix="right-sidebar-tab"
            />,
        );

        const filesTab = screen.findByTestId('right-sidebar-tab:files');
        const style = flattenTestStyle(typeof filesTab?.props.style === 'function'
            ? filesTab.props.style({ pressed: false, hovered: false, focused: false })
            : filesTab?.props.style);

        expect(style.width).toBeLessThan(44);
        expect(style.height).toBeLessThan(44);
        expect(style.width).toBe(style.height);
    });

    it('renders icon tabs with translated accessibility labels and selected state', async () => {
        const onSelectTab = vi.fn();
        // Browser is a mobile-only sidebar tab after D1; this test exercises the bar's a11y
        // rendering for the Browser/Services tabs, so resolve the mobile tab set that includes both.
        const tabs = resolveRightSidebarTabs({ scope: 'session', terminalTabAvailable: true, browserFeatureEnabled: true, presentation: 'mobile' });

        const screen = await renderScreen(
            <RightSidebarIconTabBar
                tabs={tabs}
                activeTabId="browser"
                onSelectTab={onSelectTab}
                testIDPrefix="right-sidebar-tab"
            />,
        );

        const browserTab = screen.findByTestId('right-sidebar-tab:browser');
        const servicesTab = screen.findByTestId('right-sidebar-tab:services');

        expect(browserTab?.props.role ?? browserTab?.props.accessibilityRole).toBe('tab');
        expect(browserTab?.props.accessibilityLabel).toBe('en:browserSurface.title');
        expect(browserTab?.props.accessibilityState).toMatchObject({ selected: true, disabled: false });
        expect(servicesTab?.props.accessibilityLabel).toBe('en:localServices.inventory.title');
        expect(servicesTab?.props.accessibilityState).toMatchObject({ selected: false, disabled: false });

        await screen.pressByTestIdAsync('right-sidebar-tab:services');
        expect(onSelectTab).toHaveBeenCalledWith('services');
    });

    it('exposes disabled plugin tabs to assistive tech without selecting them', async () => {
        const onSelectTab = vi.fn();
        const pluginId = 'acme.review';
        const binding = normalizePluginUiDestinationBindingV1({
            pluginId,
            destinationId: 'review-panel',
            rendererId: 'review-panel-renderer',
            container: 'rightSidebarTab',
            target: { kind: 'session' },
        });
        if (!binding) {
            throw new Error('test fixture must use an admitted V2 session right-sidebar binding');
        }
        const placement = {
            id: `surfacePlacement:${pluginId}:review-panel`,
            pluginId,
            occurrenceId: `${pluginId}-occurrence`,
            contributionKind: 'surfacePlacement',
            descriptorId: 'review-panel',
            binding,
            target: binding.target,
            renderer: { kind: 'host', rendererId: 'review.panel' },
            display: { developerFallback: 'Review' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            headerActions: [],
        } satisfies PluginUiSurfacePlacementProjection;
        const disabledPluginTab = {
            ...getRightSidebarBuiltinTab('browser'),
            id: `plugin:${pluginId}:review-panel`,
            owner: 'plugin',
            label: 'Review',
            order: 70,
            scopes: ['session'],
            disabledReason: 'availability_not_applicable',
            plugin: {
                pluginId,
                descriptorId: 'review-panel',
            },
            placement,
        } as const;

        const screen = await renderScreen(
            <RightSidebarIconTabBar
                tabs={[disabledPluginTab]}
                activeTabId="browser"
                onSelectTab={onSelectTab}
                testIDPrefix="right-sidebar-tab"
            />,
        );

        const pluginTab = screen.findByTestId(`right-sidebar-tab:plugin:${pluginId}:review-panel`);
        expect(pluginTab?.props.role ?? pluginTab?.props.accessibilityRole).toBe('tab');
        expect(pluginTab?.props.accessibilityLabel).toBe('Review');
        expect(pluginTab?.props.accessibilityState).toMatchObject({ selected: false, disabled: true });

        await screen.pressByTestIdAsync(`right-sidebar-tab:plugin:${pluginId}:review-panel`);
        expect(onSelectTab).not.toHaveBeenCalled();
    });
});
