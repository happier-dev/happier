import * as React from 'react';

import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    setRawSettings: vi.fn<(next: unknown) => void>(),
    switchProps: [] as Array<Record<string, unknown>>,
    reset() {
        this.setRawSettings = vi.fn<(next: unknown) => void>();
        this.switchProps = [];
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

installSettingsViewCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: () => [{
                    v: 1,
                    actions: {
                        'review.start': {
                            enabledPlacements: [],
                            disabledSurfaces: [],
                            disabledPlacements: [],
                            approvalRequiredSurfaces: [],
                        },
                    },
                }, capture.setRawSettings] as const,
                useSetting: () => ({ privacy: { shareDeviceInventory: true } }),
            },
        });
    },
});

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/components/ui/forms/SelectionTiles', () => ({
    SelectionTiles: (props: Record<string, unknown>) => {
        const renderOptionFooter = props.renderOptionFooter as undefined | ((params: any) => React.ReactNode);
        if (typeof renderOptionFooter !== 'function') {
            return null;
        }

        const options = props.options as Array<{ id: string }>;
        const selectedIds = props.value as string[];
        if (!Array.isArray(options) || options.length === 0) {
            return null;
        }

        const option = options[0]!;
        const selected = Array.isArray(selectedIds) ? selectedIds.includes(option.id) : false;
        return React.createElement(React.Fragment, null, renderOptionFooter({ option, selected, disabled: false }));
    },
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => {
        capture.switchProps.push(props);
        return null;
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('./buildActionSettingsEntries', () => ({
    buildActionSettingsEntries: () => [{
        actionId: 'review.start',
        title: 'Review',
        description: 'Start review',
        enabled: true,
        targets: [
            {
                id: 'mcp',
                titleKey: 'settingsActions.targets.mcp.title',
                subtitleKey: 'settingsActions.targets.mcp.subtitle',
                icon: 'cube-outline',
                category: 'integrations',
                state: 'on',
                selected: true,
            },
        ],
    }],
    resolveActionSettingsTargetSelections: (targets: Array<{ id: string; category: string; selected: boolean }>) => {
        const selected = (targets ?? []).filter((target) => target.selected).map((target) => target.id);
        return { app: [], voice: [], integrations: selected };
    },
}));

describe('ActionsSettingsView approvals required surfaces', () => {
    it('persists approvalRequiredSurfaces for selected surface targets', async () => {
        capture.reset();
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);

        expect(capture.switchProps).toHaveLength(1);
        const onValueChange = capture.switchProps[0]?.onValueChange as undefined | ((next: boolean) => void);
        expect(typeof onValueChange).toBe('function');

        await act(async () => {
            onValueChange?.(true);
        });

        expect(capture.setRawSettings).toHaveBeenCalledWith({
            v: 1,
            actions: {
                'review.start': {
                    enabledPlacements: [],
                    disabledSurfaces: [],
                    disabledPlacements: [],
                    approvalRequiredSurfaces: ['mcp'],
                },
            },
        });
    });
});
