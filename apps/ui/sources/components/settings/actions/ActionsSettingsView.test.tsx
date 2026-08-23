import * as React from 'react';

import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks, resetSettingsViewCommonModuleMockState } from '../settingsViewTestHelpers';
import { createUseSettingMock, createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';
import {
    createMachineAdministrationTargetSelectionMock,
    installMachineAdministrationTargetSelectionBoundary,
} from '@/dev/testkit/mocks/machineAdministrationTargetSelection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    items: [] as Array<Record<string, unknown>>,
    searchHeaders: [] as Array<Record<string, unknown>>,
    statusTexts: [] as Array<Record<string, unknown>>,
    notices: [] as Array<Record<string, unknown>>,
    groupTitles: [] as Array<unknown>,
    windowWidth: 800,
    setRawSettings: vi.fn(),
    routerPush: vi.fn(),
    reset() {
        this.items = [];
        this.searchHeaders = [];
        this.statusTexts = [];
        this.notices = [];
        this.groupTitles = [];
        this.windowWidth = 800;
        this.setRawSettings.mockReset();
        this.routerPush.mockReset();
    },
}));

const administrationTargetSelection = createMachineAdministrationTargetSelectionMock({
    selectedMachineId: null,
    machines: [
        { machineId: 'machine-a', displayName: 'Machine A' },
        { machineId: 'machine-b', displayName: 'Machine B' },
    ],
});
installMachineAdministrationTargetSelectionBoundary(administrationTargetSelection);
const administrationSelectionCalls: Array<Readonly<{
    selectionKey: string;
    options: unknown;
}>> = [];
vi.doMock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    ...administrationTargetSelection.module,
    useMachineAdministrationTargetSelection: (selectionKey: string, options: unknown) => {
        administrationSelectionCalls.push({ selectionKey, options });
        return administrationTargetSelection.module.useMachineAdministrationTargetSelection(selectionKey);
    },
}));

const daemonProjection = vi.hoisted(() => ({
    calls: [] as Array<Readonly<{ machineId?: unknown; serverId?: unknown; enabled?: unknown }>>,
    byMachineId: {} as Record<string, unknown>,
    reset() {
        this.calls = [];
        this.byMachineId = {};
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: (params: Readonly<{ machineId?: unknown; serverId?: unknown; enabled?: unknown }>) => {
        daemonProjection.calls.push(params);
        const machineId = typeof params.machineId === 'string' ? params.machineId : '';
        return daemonProjection.byMachineId[machineId] ?? { phase: 'idle', inputs: null };
    },
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
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: capture.routerPush,
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: createUseSettingMutableMockFromReader(() => [{ v: 1, actions: {} }, capture.setRawSettings] as const),
                useSetting: createUseSettingMock({ fallback: () => ({ privacy: { shareDeviceInventory: true } }) }),
            },
        });
    },
});

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: (props: Record<string, unknown>) => {
        capture.searchHeaders.push(props);
        return null;
    },
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: unknown }) => {
        if (title !== undefined) {
            capture.groupTitles.push(title);
        }
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('@/components/ui/lists/ItemInfoNotice', () => ({
    ItemInfoNotice: (props: Record<string, unknown>) => {
        capture.notices.push(props);
        return React.createElement('ItemInfoNotice', props);
    },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
        capture.items.push(props);
        return React.createElement(
            React.Fragment,
            null,
            props.children,
            props.subtitleAccessory as React.ReactNode,
            props.rightElement as React.ReactNode,
        );
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: { children?: React.ReactNode; testID?: string }) => {
        if (props.testID?.endsWith(':status')) {
            capture.statusTexts.push(props as Record<string, unknown>);
        }
        return React.createElement('TextMock', { testID: props.testID }, props.children);
    },
}));

afterEach(() => {
    standardCleanup();
    capture.reset();
    administrationTargetSelection.controller.reset();
    administrationSelectionCalls.length = 0;
    daemonProjection.reset();
    resetSettingsViewCommonModuleMockState();
});

describe('ActionsSettingsView', () => {
    it('renders actions as a searchable list without inline target controls', async () => {
        capture.reset();
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);

        expect(capture.searchHeaders).toHaveLength(1);
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:review.start')).toBe(true);
        expect(capture.items.every((item) => String(item.testID).startsWith('settings-actions:action:'))).toBe(true);
    });

    it('requires an explicit machine and never mixes contributed actions from different daemon projections', async () => {
        capture.reset();
        daemonProjection.byMachineId = {
            'machine-a': {
                phase: 'ready',
                inputs: {
                    pluginProjectionById: {
                        'com.acme.a': {
                            pluginId: 'com.acme.a',
                            actions: [{
                                id: 'review/a',
                                title: 'Action from machine A',
                                description: null,
                                icon: null,
                                surfaces: ['plugin'],
                                placementBindings: [],
                            }],
                        },
                    },
                },
            },
            'machine-b': {
                phase: 'ready',
                inputs: {
                    pluginProjectionById: {
                        'com.acme.b': {
                            pluginId: 'com.acme.b',
                            actions: [{
                                id: 'review/b',
                                title: 'Action from machine B',
                                description: null,
                                icon: null,
                                surfaces: [],
                                placementBindings: [],
                            }],
                        },
                    },
                },
            },
        };
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);
        expect(administrationSelectionCalls).toContainEqual({
            selectionKey: 'actions.settings',
            options: { allowSoleCandidate: false },
        });
        expect(capture.notices.some((notice) => (
            notice.testID === 'settings-actions:contributed:machine-selection-required'
        ))).toBe(true);
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:com.acme.a/actions/review/a')).toBe(false);

        capture.items = [];
        await act(async () => {
            administrationTargetSelection.controller.select('machine-a');
        });
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:com.acme.a/actions/review/a')).toBe(true);
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:com.acme.b/actions/review/b')).toBe(false);

        capture.items = [];
        await act(async () => {
            administrationTargetSelection.controller.select('machine-b');
        });
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:com.acme.a/actions/review/a')).toBe(false);
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:com.acme.b/actions/review/b')).toBe(true);
    });

    it('exposes browser recording attach in action settings now its executor is wired (§3.2)', async () => {
        // FINALIZATION-PLAN §3.2/§3.3: `browser.recording.attachToComposer` has a real executor and
        // is surfaced on ui/agent, so it is now a configurable settings row. The no-executor
        // related executor-backed recording actions are configurable; unrelated families stay hidden.
        capture.reset();
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);

        const searchHeader = capture.searchHeaders[0];
        expect(typeof searchHeader?.onChangeText).toBe('function');

        capture.items = [];
        await act(async () => {
            (searchHeader?.onChangeText as (value: string) => void)('browser');
        });

        expect(capture.items.some((item) => item.testID === 'settings-actions:action:browser.recording.attachToComposer')).toBe(true);
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:browser.recording.start')).toBe(true);
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:review.start')).toBe(false);
    });

    it('groups actions into runtime family sections with localized headers (§3.3)', async () => {
        capture.reset();
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);

        const searchHeader = capture.searchHeaders[0];
        capture.groupTitles = [];
        capture.items = [];
        await act(async () => {
            (searchHeader?.onChangeText as (value: string) => void)('browser');
        });

        // A Browser family section header is rendered, and the grouped rows are browser actions.
        expect(capture.groupTitles).toContain('settingsActions.families.browser.title');
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:browser.navigate')).toBe(true);
    });

    it('opens an action detail page from the action row without toggling action enablement', async () => {
        capture.reset();
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);

        const reviewRow = capture.items.find((item) => item.testID === 'settings-actions:action:review.start');
        expect(reviewRow).toBeTruthy();

        const onPress = reviewRow?.onPress as undefined | (() => void);
        expect(typeof onPress).toBe('function');
        onPress?.();

        expect(capture.routerPush).toHaveBeenCalledWith('/settings/actions/review.start');
        expect(capture.setRawSettings).not.toHaveBeenCalled();
    });

    it('shows a compact target status and settings affordance beside each action switch', async () => {
        capture.reset();
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        const screen = await renderScreen(<ActionsSettingsView />);

        const reviewRow = capture.items.find((item) => item.testID === 'settings-actions:action:review.start');
        expect(reviewRow).toBeTruthy();
        expect(reviewRow?.showChevron).toBe(false);
        expect(reviewRow?.rightElementOutsidePressable).toBe(true);
        expect(await screen.findByTestId('settings-actions:action:review.start:status')).toBeTruthy();
        expect(await screen.findByTestId('settings-actions:action:review.start:configure')).toBeTruthy();
        expect((await screen.findByTestId('settings-actions:action:review.start:enabled'))?.props.accessibilityLabel).toBe(reviewRow?.title);
    });

    it('moves compact status into the text column on narrow mobile widths', async () => {
        capture.reset();
        capture.windowWidth = 390;
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);

        const reviewRow = capture.items.find((item) => item.testID === 'settings-actions:action:review.start');
        expect(reviewRow).toBeTruthy();
        expect(reviewRow?.subtitleAccessory).toBeTruthy();
        expect(capture.statusTexts.some((status) =>
            status.testID === 'settings-actions:action:review.start:status',
        )).toBe(true);
    });
});
