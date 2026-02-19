import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Platform: {
        OS: 'web',
        select: (spec: Record<string, unknown>) =>
            spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
    },
}));

vi.mock('@expo/vector-icons', async () => {
    const Ionicons = Object.assign(
        (props: any) => React.createElement('Ionicons', props),
        { glyphMap: {} },
    );
    return { Ionicons };
});

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: vi.fn(async () => false),
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/settings/features/FeatureDiagnosticsPanel', () => ({
    FeatureDiagnosticsPanel: () => null,
}));

const useServerFeaturesMainSelectionSnapshotMock = vi.fn();
const useEffectiveServerSelectionMock = vi.fn();

vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        useServerFeaturesMainSelectionSnapshot: (...args: any[]) => useServerFeaturesMainSelectionSnapshotMock(...args),
    };
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => useEffectiveServerSelectionMock(),
}));

type MutableHookResult<T> = readonly [T, (next: T) => void];

function createNoopMutable<T>(value: T): MutableHookResult<T> {
    return [value, vi.fn()] as const;
}

const useSettingMutableMock = vi.fn();
const useLocalSettingMutableMock = vi.fn();

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => useSettingMutableMock(key),
    useLocalSettingMutable: (key: string) => useLocalSettingMutableMock(key),
}));

describe('FeaturesSettingsScreen (web settings moved)', () => {
    beforeEach(() => {
        useEffectiveServerSelectionMock.mockReturnValue({ serverIds: [] });
        useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({ status: 'ready', serverIds: [], snapshotsByServerId: {} });

        useSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'experiments') return createNoopMutable(false);
            if (key === 'featureToggles') return createNoopMutable({});
            if (key === 'useProfiles') return createNoopMutable(false);
            if (key === 'agentInputEnterToSend') return createNoopMutable(false);
            if (key === 'agentInputHistoryScope') return createNoopMutable('perSession');
            if (key === 'showEnvironmentBadge') return createNoopMutable(false);
            if (key === 'useEnhancedSessionWizard') return createNoopMutable(false);
            if (key === 'useMachinePickerSearch') return createNoopMutable(false);
            if (key === 'usePathPickerSearch') return createNoopMutable(false);
            return createNoopMutable(null);
        });

        useLocalSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'commandPaletteEnabled') return createNoopMutable(false);
            if (key === 'markdownCopyV2') return createNoopMutable(false);
            if (key === 'devModeEnabled') return createNoopMutable(false);
            return createNoopMutable(false);
        });
    });

    it('does not show Enter-to-send or Message history (moved to Session settings)', async () => {
        const { default: FeaturesSettingsScreen } = await import('./features');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(FeaturesSettingsScreen));
        });

        const items = tree.root.findAllByType('Item' as any);
        const titles = items.map((i) => i.props.title);

        expect(titles).not.toContain('settingsFeatures.enterToSend');
        expect(titles).not.toContain('settingsFeatures.historyScope');
    });
});
