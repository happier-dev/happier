import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { renderScreen } from '@/dev/testkit';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

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
    it('keeps every tab target at least 44 by 44 logical pixels', async () => {
        const { RightSidebarIconTabBar } = await import('./RightSidebarIconTabBar');
        const { resolveRightSidebarTabs } = await import('./rightSidebarTabRegistry');
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
        const style = Object.assign({}, ...(Array.isArray(filesTab?.props.style)
            ? filesTab.props.style.filter(Boolean)
            : [filesTab?.props.style].filter(Boolean)));

        expect(style.width).toBeGreaterThanOrEqual(44);
        expect(style.height).toBeGreaterThanOrEqual(44);
    });

    it('renders icon tabs with translated accessibility labels and selected state', async () => {
        const onSelectTab = vi.fn();
        const { RightSidebarIconTabBar } = await import('./RightSidebarIconTabBar');
        const { resolveRightSidebarTabs } = await import('./rightSidebarTabRegistry');
        // Browser is a mobile-only sidebar tab after D1; this test exercises the bar's a11y
        // rendering for the Browser/Services tabs, so resolve the mobile tab set that includes both.
        const tabs = resolveRightSidebarTabs({ scope: 'session', terminalTabAvailable: true, presentation: 'mobile' });

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

        expect(browserTab?.props.accessibilityRole).toBe('tab');
        expect(browserTab?.props.accessibilityLabel).toBe('en:browserSurface.title');
        expect(browserTab?.props.accessibilityState).toEqual({ selected: true, disabled: false });
        expect(servicesTab?.props.accessibilityLabel).toBe('en:localServices.inventory.title');
        expect(servicesTab?.props.accessibilityState).toEqual({ selected: false, disabled: false });

        await screen.pressByTestIdAsync('right-sidebar-tab:services');
        expect(onSelectTab).toHaveBeenCalledWith('services');
    });

    it('exposes disabled plugin tabs to assistive tech without selecting them', async () => {
        const onSelectTab = vi.fn();
        const { RightSidebarIconTabBar } = await import('./RightSidebarIconTabBar');
        const { getRightSidebarBuiltinTab } = await import('./rightSidebarTabRegistry');
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
            disabledReason: 'policy_deferred',
            plugin: {
                pluginId,
                descriptorId: 'review-panel',
                generation: 4,
            },
            placement,
            retentionKey: `plugin:${pluginId}:review-panel:4`,
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
        expect(pluginTab?.props.accessibilityRole).toBe('tab');
        expect(pluginTab?.props.accessibilityLabel).toBe('Review');
        expect(pluginTab?.props.accessibilityState).toEqual({ selected: false, disabled: true });

        await screen.pressByTestIdAsync(`right-sidebar-tab:plugin:${pluginId}:review-panel`);
        expect(onSelectTab).not.toHaveBeenCalled();
    });
});
