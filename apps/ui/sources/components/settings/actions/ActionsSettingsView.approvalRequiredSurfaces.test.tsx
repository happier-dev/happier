import * as React from 'react';

import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    actionId: 'review.start',
    targetId: 'mcp',
    targetSelected: true,
    setRawSettings: vi.fn<(next: unknown) => void>(),
    switchProps: [] as Array<Record<string, unknown>>,
    reset() {
        this.actionId = 'review.start';
        this.targetId = 'mcp';
        this.targetSelected = true;
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
                        'session.title.set': {
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
        actionId: capture.actionId,
        title: 'Review',
        description: 'Start review',
        enabled: true,
        targets: [
            {
                id: capture.targetId,
                titleKey: capture.targetId === 'cli'
                    ? 'settingsActions.targets.cli.title'
                    : 'settingsActions.targets.mcp.title',
                subtitleKey: capture.targetId === 'cli'
                    ? 'settingsActions.targets.cli.subtitle'
                    : 'settingsActions.targets.mcp.subtitle',
                icon: 'cube-outline',
                category: 'integrations',
                state: 'on',
                selected: capture.targetSelected,
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
        capture.actionId = 'review.start';
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
                'session.title.set': {
                    enabledPlacements: [],
                    disabledSurfaces: [],
                    disabledPlacements: [],
                    approvalRequiredSurfaces: [],
                },
            },
        });
    });

    it('does not show approvalRequiredSurfaces toggle for session.title.set', async () => {
        capture.reset();
        capture.actionId = 'session.title.set';
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);

        expect(capture.switchProps).toHaveLength(0);
    });

    it('shows approvalRequiredSurfaces toggle for actions without explicit approval metadata', async () => {
        capture.reset();
        capture.actionId = 'agents.backends.list';
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);

        expect(capture.switchProps).toHaveLength(1);
    });

    it('persists approvalRequiredSurfaces for cli surface targets', async () => {
        capture.reset();
        capture.actionId = 'review.start';
        capture.targetId = 'cli';
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);

        expect(capture.switchProps).toHaveLength(1);
        expect(capture.switchProps[0]?.testID).toBe('settings-actions:action:review.start:target:cli:require-approval');

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
                    approvalRequiredSurfaces: ['cli'],
                },
                'session.title.set': {
                    enabledPlacements: [],
                    disabledSurfaces: [],
                    disabledPlacements: [],
                    approvalRequiredSurfaces: [],
                },
            },
        });
    });

    it('does not show the approvalRequiredSurfaces toggle when the target tile is not selected', async () => {
        capture.reset();
        capture.actionId = 'session.title.set';
        capture.targetSelected = false;
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await renderScreen(<ActionsSettingsView />);

        expect(capture.switchProps).toHaveLength(0);
    });
});
