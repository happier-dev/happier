import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks, resetSettingsViewCommonModuleMockState } from '../settingsViewTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    items: [] as Array<Record<string, unknown>>,
    searchHeaders: [] as Array<Record<string, unknown>>,
    itemListsWithSearchHeader: 0,
    itemGroupsWithSearchHeader: 0,
    renderOrder: [] as string[],
    segmentedTabBars: [] as Array<Record<string, unknown>>,
    stackOptions: null as Record<string, unknown> | null,
    switches: [] as Array<Record<string, unknown>>,
    setRawSettings: vi.fn(),
    reset() {
        this.items = [];
        this.searchHeaders = [];
        this.itemListsWithSearchHeader = 0;
        this.itemGroupsWithSearchHeader = 0;
        this.renderOrder = [];
        this.segmentedTabBars = [];
        this.stackOptions = null;
        this.switches = [];
        this.setRawSettings.mockReset();
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

installSettingsViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock, createStackOptionsCapture } = await import('@/dev/testkit/mocks/router');
        const stackOptionsCapture = createStackOptionsCapture();
        const routerMock = createExpoRouterMock({
            params: { actionId: 'review.start' },
            stackOptionsCapture,
        });
        const StackScreen = routerMock.module.Stack.Screen;
        return {
            ...routerMock.module,
            Stack: Object.assign(routerMock.module.Stack, {
                Screen: (props: { options?: Record<string, unknown> }) => {
                    StackScreen(props);
                    capture.stackOptions = stackOptionsCapture.getResolved();
                    return React.createElement('StackScreen', props);
                },
            }),
        };
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: () => [{ v: 1, actions: {} }, capture.setRawSettings] as const,
                useSetting: () => ({ privacy: { shareDeviceInventory: true } }),
            },
        });
    },
});

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: (props: Record<string, unknown>) => {
        capture.searchHeaders.push(props);
        capture.renderOrder.push('search');
        return React.createElement('SearchHeaderMock', props);
    },
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => {
        capture.switches.push(props);
        return React.createElement('Switch', props);
    },
}));

vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({
    SegmentedTabBar: (props: Record<string, unknown>) => {
        capture.segmentedTabBars.push(props);
        return React.createElement('SegmentedTabBar', props);
    },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => {
        capture.items.push(props);
        if (typeof props.testID === 'string') {
            capture.renderOrder.push(props.testID);
        }
        return React.createElement('ItemMock', {
            testID: props.testID,
        }, props.rightElement as React.ReactNode);
    },
}));

function containsSearchHeaderMock(node: React.ReactNode): boolean {
    return React.Children.toArray(node).some((child) => {
        if (!React.isValidElement(child)) {
            return false;
        }
        if (child.type === 'SearchHeaderMock') {
            return true;
        }
        if (typeof child.type === 'function' && child.type.name === 'SearchHeader') {
            return true;
        }
        return containsSearchHeaderMock((child.props as { children?: React.ReactNode }).children);
    });
}

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => {
        if (containsSearchHeaderMock(children)) {
            capture.itemGroupsWithSearchHeader += 1;
        }
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => {
        if (containsSearchHeaderMock(children)) {
            capture.itemListsWithSearchHeader += 1;
        }
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

afterEach(() => {
    standardCleanup();
    capture.reset();
    resetSettingsViewCommonModuleMockState();
});

describe('ActionSettingsDetailView', () => {
    it('renders approval-capable targets as mode tabs and ordinary placements as switches', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        const screen = await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        expect(capture.searchHeaders).toHaveLength(1);
        expect(capture.itemListsWithSearchHeader).toBe(0);
        expect(capture.itemGroupsWithSearchHeader).toBe(0);
        expect(capture.renderOrder.indexOf('search')).toBeLessThan(
            capture.renderOrder.indexOf('settings-actions:action:review.start:summary'),
        );
        expect(await screen.findByTestId('settings-actions:approval-mode-help')).toBeTruthy();
        expect(capture.switches.some((switchProps) =>
            switchProps.testID === 'settings-actions:action:review.start:enabled',
        )).toBe(true);
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:review.start:target:cli')).toBe(true);
        expect(capture.segmentedTabBars.some((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:cli:mode'
            && bar.activeTabId === 'allowed',
        )).toBe(true);
        expect(capture.switches.some((switchProps) =>
            switchProps.testID === 'settings-actions:action:review.start:target:command_palette:enabled',
        )).toBe(true);
    });

    it('persists ask-first approval mode through the canonical settings writer', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const cliMode = capture.segmentedTabBars.find((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:cli:mode',
        );
        expect(cliMode).toBeTruthy();

        (cliMode?.onSelectTab as (tabId: string) => void)('ask_first');

        expect(capture.setRawSettings).toHaveBeenCalledWith({
            v: 1,
            actions: {
                'review.start': {
                    enabledPlacements: [],
                    disabledSurfaces: [],
                    disabledPlacements: [],
                    approvalRequiredSurfaces: ['cli'],
                },
            },
        });
    });

    it('uses the action name as the route header title', async () => {
        const { ActionSettingsDetailView } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailView />);

        expect(capture.stackOptions?.headerTitle).toBe('Start review');
    });
});
