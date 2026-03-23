import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 1024, height: 768 }),
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (
        props: Record<string, unknown> & {
            leftElement?: React.ReactNode;
            rightElement?: React.ReactNode;
            subtitle?: React.ReactNode;
        },
    ) =>
        React.createElement('Item', props, [
            props.leftElement == null ? null : React.createElement('Text', { key: 'left' }, props.leftElement),
            React.createElement(React.Fragment, { key: 'right' }, props.rightElement),
            props.subtitle == null ? null : React.createElement('Text', { key: 'subtitle' }, props.subtitle),
        ]),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: () => null,
}));

vi.mock('@/components/sessions/new/components/ProfileCompatibilityIcon', () => ({
    ProfileCompatibilityIcon: () => null,
}));

vi.mock('@/components/profiles/ProfileRequirementsBadge', () => ({
    ProfileRequirementsBadge: () => null,
}));

vi.mock('@/utils/ui/ignoreNextRowPress', () => ({
    ignoreNextRowPress: () => {},
}));

vi.mock('@/sync/domains/profiles/profileGrouping', () => ({
    toggleFavoriteProfileId: (current: string[], profileId: string) =>
        current.includes(profileId) ? current.filter((id) => id !== profileId) : [...current, profileId],
}));

vi.mock('@/components/profiles/profileActions', () => ({
    buildProfileActions: () => [],
}));

vi.mock('@/components/profiles/profileListModel', () => ({
    getDefaultProfileListStrings: () => ({}),
    getProfileSubtitle: () => 'Subtitle',
    buildProfilesListGroups: () => ({
        favoriteIds: new Set<string>(),
        favoriteProfiles: [],
        customProfiles: [],
        builtInProfiles: [],
    }),
}));

vi.mock('@/components/profiles/profileDisplay', () => ({
    getProfileDisplayName: () => 'Profile',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/sync/domains/profiles/profileSecrets', () => ({
    hasRequiredSecret: () => false,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: createUseSettingMock(),
    });
});

vi.mock('@/agents/catalog/enabled', () => ({
    getEnabledAgentIds: () => ['codex'],
}));

vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
    getResolvedBackendCatalogEntries: () => [],
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) =>
        React.createElement('Text', props, children),
}));

describe('ProfilesList', () => {
    it('does not emit raw text nodes under non-Text parents when selection icons render as text on web', async () => {
        const { ProfilesList } = await import('./ProfilesList');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ProfilesList
                    customProfiles={[]}
                    favoriteProfileIds={[]}
                    onFavoriteProfileIdsChange={() => {}}
                    selectedProfileId={null}
                    onPressDefaultEnvironment={() => {}}
                    machineId={null}
                    includeDefaultEnvironmentRow
                />)).tree;

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string' || typeof node === 'number') {
                const value = String(node);
                if (parentType !== 'Text' && value.trim().length > 0) badNodes.push({ parent: parentType, value });
                return;
            }
            if (Array.isArray(node)) {
                for (const item of node) walk(item, parentType);
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : parentType;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(tree.toJSON(), null);
        expect(badNodes).toEqual([]);

        act(() => {
            tree.unmount();
        });
    });
});
