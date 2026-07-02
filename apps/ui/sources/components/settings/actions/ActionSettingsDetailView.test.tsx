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
    dropdownMenus: [] as Array<Record<string, unknown>>,
    rawSettings: { v: 1, actions: {} } as unknown,
    stackOptions: null as Record<string, unknown> | null,
    switches: [] as Array<Record<string, unknown>>,
    windowWidth: 800,
    setRawSettings: vi.fn(),
    reset() {
        this.items = [];
        this.searchHeaders = [];
        this.itemListsWithSearchHeader = 0;
        this.itemGroupsWithSearchHeader = 0;
        this.renderOrder = [];
        this.segmentedTabBars = [];
        this.dropdownMenus = [];
        this.rawSettings = { v: 1, actions: {} };
        this.stackOptions = null;
        this.switches = [];
        this.windowWidth = 800;
        this.setRawSettings.mockReset();
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({
                width: capture.windowWidth,
                height: 844,
                scale: 2,
                fontScale: 1,
            }),
        });
    },
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
                useSettingMutable: () => [capture.rawSettings, (next: unknown) => {
                    capture.rawSettings = next;
                    capture.setRawSettings(next);
                }] as const,
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

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => {
        capture.dropdownMenus.push(props);
        return React.createElement('DropdownMenu', props);
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
        }, props.subtitleAccessory as React.ReactNode, props.rightElement as React.ReactNode);
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
                    toolExposureModes: {},
                },
            },
        });
    });

    it('renders tool exposure controls for eligible tool-backed integration surfaces', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        const screen = await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const sessionAgentExposure = capture.dropdownMenus.find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:session_agent:tool-exposure';
        });
        const mcpExposure = capture.dropdownMenus.find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:mcp:tool-exposure';
        });
        const cliExposure = capture.dropdownMenus.find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:cli:tool-exposure';
        });

        expect(sessionAgentExposure).toMatchObject({
            selectedId: 'default',
        });
        expect(mcpExposure).toMatchObject({
            selectedId: 'default',
        });
        expect(cliExposure).toMatchObject({
            selectedId: 'default',
        });
        expect((sessionAgentExposure?.items as Array<{ testID?: string }>).map((item) => item.testID)).toEqual([
            'settings-actions:action:review.start:target:session_agent:tool-exposure:default',
            'settings-actions:action:review.start:target:session_agent:tool-exposure:discoverable_only',
            'settings-actions:action:review.start:target:session_agent:tool-exposure:direct',
        ]);
        expect(capture.dropdownMenus.some((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:agent_input_chips:tool-exposure';
        })).toBe(false);
        expect(await screen.findByTestId(
            'settings-actions:action:review.start:target:session_agent:tool-exposure:resolved:discoverable_only',
        )).toBeTruthy();
        expect(await screen.findByTestId(
            'settings-actions:action:review.start:target:mcp:tool-exposure:resolved:direct',
        )).toBeTruthy();
    });

    it('persists direct tool exposure overrides and clears them when default is selected', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const sessionAgentExposure = capture.dropdownMenus.find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:session_agent:tool-exposure';
        });
        expect(sessionAgentExposure).toBeTruthy();

        (sessionAgentExposure?.onSelect as (itemId: string) => void)('direct');

        expect(capture.setRawSettings).toHaveBeenLastCalledWith({
            v: 1,
            actions: {
                'review.start': {
                    enabledPlacements: [],
                    disabledSurfaces: [],
                    disabledPlacements: [],
                    approvalRequiredSurfaces: [],
                    toolExposureModes: {
                        session_agent: 'direct',
                    },
                },
            },
        });

        capture.dropdownMenus = [];
        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);
        const resetSessionAgentExposure = capture.dropdownMenus.find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:session_agent:tool-exposure';
        });
        expect(resetSessionAgentExposure).toBeTruthy();

        (resetSessionAgentExposure?.onSelect as (itemId: string) => void)('default');

        expect(capture.setRawSettings).toHaveBeenLastCalledWith({
            v: 1,
            actions: {},
        });
    });

    it('moves approval mode controls into the target text column on narrow mobile widths', async () => {
        capture.windowWidth = 390;
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const cliTarget = capture.items.find((item) =>
            item.testID === 'settings-actions:action:review.start:target:cli',
        );
        expect(cliTarget).toBeTruthy();
        expect(cliTarget?.rightElement).toBeFalsy();
        expect(cliTarget?.subtitleAccessory).toBeTruthy();
        expect(capture.segmentedTabBars.some((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:cli:mode'
            && bar.activeTabId === 'allowed',
        )).toBe(true);
    });

    it('uses the action name as the route header title', async () => {
        const { ActionSettingsDetailView } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailView />);

        expect(capture.stackOptions?.headerTitle).toBe('Start review');
    });
});
