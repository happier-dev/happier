import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit/rootLayoutTestkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Platform: {
        OS: 'ios',
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

describe('FeaturesSettingsScreen gating', () => {
    beforeEach(() => {
        vi.resetModules();
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        delete process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV;

        useEffectiveServerSelectionMock.mockReturnValue({ serverIds: [] });
        useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({ status: 'ready', serverIds: [], snapshotsByServerId: {} });

        useSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'experiments') return createNoopMutable(true);
            if (key === 'featureToggles') return createNoopMutable({});
            if (key === 'useProfiles') return createNoopMutable(false);
            if (key === 'agentInputEnterToSend') return createNoopMutable(false);
            if (key === 'agentInputHistoryScope') return createNoopMutable('perSession');
            if (key === 'hideInactiveSessions') return createNoopMutable(false);
            if (key === 'groupInactiveSessionsByProject') return createNoopMutable(false);
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

    it('hides build-policy denied feature toggles from the list', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV = 'production';
        vi.resetModules();
        const { getFeatureBuildPolicyDecision } = await import('@/sync/domains/features/featureBuildPolicy');
        expect(getFeatureBuildPolicyDecision('execution.runs')).toBe('deny');

        const { default: FeaturesSettingsScreen } = await import('./features');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(FeaturesSettingsScreen));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const allTitles = items.map((i) => i.props.title);
        const featureGroup = tree!.root.findAllByType('ItemGroup' as any).find((g) => g.props.title === 'Features') ?? null;
        const featureItems = featureGroup ? featureGroup.findAllByType('Item' as any) : [];
        const titles = featureItems.map((i) => i.props.title);

        expect(allTitles).not.toContain('settingsFeatures.hideInactiveSessions');
        expect(allTitles).not.toContain('settingsFeatures.sessionListActiveGrouping');
        expect(allTitles).not.toContain('settingsFeatures.sessionListInactiveGrouping');
        expect(titles).not.toContain('settingsFeatures.expExecutionRuns');
        expect(titles).not.toContain('settingsFeatures.expFriends');
        expect(titles).not.toContain('settingsFeatures.expScmOperations');
    });

    it('hides server-disabled toggles even when build policy allows them', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = 'social.friends';

        useEffectiveServerSelectionMock.mockReturnValue({ serverIds: ['server-1'] });
        useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({
            status: 'ready',
            serverIds: ['server-1'],
            snapshotsByServerId: {
                'server-1': {
                    status: 'ready',
                    features: createRootLayoutFeaturesResponse({
                        features: {
                            social: { friends: { enabled: false } },
                        },
                    }),
                },
            },
        });

        const { default: FeaturesSettingsScreen } = await import('./features');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(FeaturesSettingsScreen));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const allTitles = items.map((i) => i.props.title);
        const featureGroup = tree!.root.findAllByType('ItemGroup' as any).find((g) => g.props.title === 'Features') ?? null;
        const featureItems = featureGroup ? featureGroup.findAllByType('Item' as any) : [];
        const titles = featureItems.map((i) => i.props.title);

        expect(allTitles).not.toContain('settingsFeatures.hideInactiveSessions');
        expect(allTitles).not.toContain('settingsFeatures.sessionListActiveGrouping');
        expect(allTitles).not.toContain('settingsFeatures.sessionListInactiveGrouping');
        expect(titles).not.toContain('settingsFeatures.expFriends');
    });
});
