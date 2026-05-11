import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks, resetSettingsViewCommonModuleMockState } from '../settingsViewTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    items: [] as Array<Record<string, unknown>>,
    searchHeaders: [] as Array<Record<string, unknown>>,
    setRawSettings: vi.fn(),
    routerPush: vi.fn(),
    reset() {
        this.items = [];
        this.searchHeaders = [];
        this.setRawSettings.mockReset();
        this.routerPush.mockReset();
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

installSettingsViewCommonModuleMocks({
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
                useSettingMutable: () => [{ v: 1, actions: {} }, capture.setRawSettings] as const,
                useSetting: () => ({ privacy: { shareDeviceInventory: true } }),
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
    Switch: () => null,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
        capture.items.push(props);
        return React.createElement(React.Fragment, null, props.children, props.rightElement as React.ReactNode);
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

describe('ActionsSettingsView', () => {
    it('renders actions as a searchable list without inline target controls', async () => {
        capture.reset();
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);

        expect(capture.searchHeaders).toHaveLength(1);
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:review.start')).toBe(true);
        expect(capture.items.every((item) => String(item.testID).startsWith('settings-actions:action:'))).toBe(true);
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
        expect(await screen.findByTestId('settings-actions:action:review.start:status')).toBeTruthy();
        expect(await screen.findByTestId('settings-actions:action:review.start:configure')).toBeTruthy();
    });
});
