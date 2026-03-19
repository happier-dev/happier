import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    selectionTilesProps: [] as Array<Record<string, unknown>>,
    items: [] as Array<Record<string, unknown>>,
    reset() {
        this.selectionTilesProps = [];
        this.items = [];
    },
}));

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            textSecondary: '#6b7280',
            success: '#16a34a',
            warningCritical: '#dc2626',
        },
    };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme) : input) },
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId !== 'voice',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: () => [{ v: 1, actions: {} }, vi.fn()] as const,
    useSetting: () => ({ privacy: { shareDeviceInventory: true } }),
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/components/ui/forms/SelectionTiles', () => ({
    SelectionTiles: (props: Record<string, unknown>) => {
        capture.selectionTilesProps.push(props);
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
        return React.createElement(React.Fragment, null, props.children);
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('./buildActionSettingsEntries', () => ({
    buildActionSettingsEntries: () => [{
        actionId: 'paths.list_recent',
        title: 'Paths',
        description: 'List recent paths',
        enabled: true,
        targets: [
            {
                id: 'voice_panel',
                titleKey: 'settingsActions.targets.voice_panel.title',
                subtitleKey: 'settingsActions.targets.voice_panel.subtitle',
                icon: 'mic-outline',
                category: 'voice',
                state: 'unavailable',
                selected: false,
                reasonKey: 'settingsActions.reasons.voiceFeature',
            },
        ],
    }],
    resolveActionSettingsTargetSelections: () => ({ app: [], voice: [], integrations: [] }),
}));

describe('ActionsSettingsView', () => {
    it('shows unavailable targets in the summary list instead of inline tiles', async () => {
        capture.reset();
        const { ActionsSettingsView } = await import('./ActionsSettingsView');

        await act(async () => {
            renderer.create(<ActionsSettingsView />);
        });

        const voiceSection = capture.selectionTilesProps.find((props) => Array.isArray(props.options));
        expect(voiceSection).toBeUndefined();

        const unavailableSummaryItem = capture.items.find((item) =>
            item.subtitle === 'settingsActions.targets.voice_panel.title. settingsActions.reasons.voiceFeature',
        );
        expect(unavailableSummaryItem).toBeTruthy();
        expect(unavailableSummaryItem?.title).toBe('Paths');
    });
});
