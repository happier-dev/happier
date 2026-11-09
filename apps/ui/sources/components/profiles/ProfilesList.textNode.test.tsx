import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installProfilesCommonModuleMocks } from './profilesTestHelpers';

const profilesListState = vi.hoisted(() => ({
    groups: {
        favoriteIds: new Set<string>(),
        favoriteProfiles: [],
        customProfiles: [],
        sharedProfiles: [],
        builtInProfiles: [],
    } as any,
}));

const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

installProfilesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1024, height: 768 }),
        });
    },
    storage: async () => {
        const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: createUseSettingMock(),
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

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
    buildProfilesListGroups: () => profilesListState.groups,
}));

vi.mock('@/components/profiles/profileDisplay', () => ({
    getProfileDisplayName: () => 'Profile',
}));

vi.mock('@/constants/Typography', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/constants/Typography')>();
    return { ...actual, Typography: { ...actual.Typography, default: () => ({}) } };
});

vi.mock('@/sync/domains/profiles/profileSecrets', () => ({
    hasRequiredSecret: () => false,
}));

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

// Load the real component during collection; cold module transformation is not a test action.
const { ProfilesList } = await import('./ProfilesList');

describe('ProfilesList', () => {
    it('does not emit raw text nodes under non-Text parents when selection icons render as text on web', async () => {

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

    it('assigns stable `testID`s to profile rows for E2E automation', async () => {
        profilesListState.groups = {
            favoriteIds: new Set<string>(),
            favoriteProfiles: [],
            customProfiles: [],
            sharedProfiles: [],
            builtInProfiles: [
                {
                    id: 'anthropic',
                    name: 'Anthropic',
                    isBuiltIn: true,
                    compatibility: {},
                    compatibilityByTargetKey: {},
                    environmentVariables: [],
                },
            ],
        };

        const screen = await renderScreen(
            <ProfilesList
                customProfiles={[]}
                favoriteProfileIds={[]}
                onFavoriteProfileIdsChange={() => {}}
                selectedProfileId={null}
                onPressDefaultEnvironment={() => {}}
                machineId={null}
                includeDefaultEnvironmentRow
            />,
        );

        expect(screen.findAllByProps({ testID: 'profiles-list-row:default-environment' }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ testID: 'profiles-list-row:anthropic' }).length).toBeGreaterThan(0);
    });

    it('draws no selection on a page, which lists profiles rather than choosing one', async () => {
        profilesListState.groups = {
            favoriteIds: new Set<string>(),
            favoriteProfiles: [],
            customProfiles: [],
            sharedProfiles: [],
            builtInProfiles: [
                {
                    id: 'anthropic',
                    name: 'Anthropic',
                    isBuiltIn: true,
                    compatibility: {},
                    compatibilityByTargetKey: {},
                    environmentVariables: [],
                },
            ],
        };
        const render = (presentation: 'page' | 'grouped') => renderScreen(
            <ProfilesList
                presentation={presentation}
                customProfiles={[]}
                favoriteProfileIds={[]}
                onFavoriteProfileIdsChange={() => {}}
                selectedProfileId={null}
                onPressDefaultEnvironment={() => {}}
                machineId={null}
                includeDefaultEnvironmentRow
            />,
        );
        const selectedRowIds = (screen: Awaited<ReturnType<typeof render>>) => screen
            .findAll((node) => node.props?.selected === true && typeof node.props?.testID === 'string')
            .map((node) => node.props.testID as string);

        // A picker marks the no-profile choice as the current selection; a page marks nothing.
        expect(selectedRowIds(await render('grouped'))).toContain('profiles-list-row:default-environment');
        expect(selectedRowIds(await render('page'))).toEqual([]);
    });

    it('draws a page row\'s status as the shared status glyph at the end of the row, not as words in its line', async () => {
        profilesListState.groups = {
            favoriteIds: new Set<string>(),
            favoriteProfiles: [],
            customProfiles: [
                { id: 'mine', name: 'Mine', isBuiltIn: false, compatibility: {}, compatibilityByTargetKey: {}, environmentVariables: [] },
                { id: 'quiet', name: 'Quiet', isBuiltIn: false, compatibility: {}, compatibilityByTargetKey: {}, environmentVariables: [] },
            ],
            sharedProfiles: [],
            builtInProfiles: [],
        };
        const screen = await renderScreen(
            <ProfilesList
                presentation="page"
                customProfiles={[]}
                favoriteProfileIds={[]}
                onFavoriteProfileIdsChange={() => {}}
                selectedProfileId={null}
                machineId={null}
                getProfileStatus={(profile) => profile.id === 'mine' ? { status: 'off', label: 'Disabled' } : null}
            />,
        );
        const row = (id: string) => screen.findAll((node) => node.props?.testID === `profiles-list-row:${id}` && node.props?.title !== undefined)[0];
        expect(row('mine')?.props.rightElement.props).toMatchObject({ status: 'off', label: 'Disabled' });
        expect(row('mine')?.props.subtitle).toBe('Subtitle');
        expect(row('quiet')?.props.rightElement ?? null).toBeNull();
    });

    it('lets a page row open its profile, with its operations on the profile page instead of on the row', async () => {
        profilesListState.groups = {
            favoriteIds: new Set<string>(),
            favoriteProfiles: [],
            customProfiles: [],
            sharedProfiles: [],
            builtInProfiles: [
                {
                    id: 'anthropic',
                    name: 'Anthropic',
                    isBuiltIn: true,
                    compatibility: {},
                    compatibilityByTargetKey: {},
                    environmentVariables: [],
                },
            ],
        };
        const render = (presentation: 'page' | 'grouped') => renderScreen(
            <ProfilesList
                presentation={presentation}
                customProfiles={[]}
                favoriteProfileIds={[]}
                onFavoriteProfileIdsChange={() => {}}
                selectedProfileId={null}
                onPressDefaultEnvironment={() => {}}
                machineId={null}
                includeDefaultEnvironmentRow
            />,
        );
        const row = (screen: Awaited<ReturnType<typeof render>>, id: string) => screen
            .findAll((node) => node.props?.testID === id && 'showChevron' in node.props).at(0);

        for (const id of ['profiles-list-row:anthropic', 'profiles-list-row:default-environment']) {
            // A picker row carries its quick actions; a page row is a destination.
            expect(row(await render('grouped'), id)?.props.rightElement).toBeTruthy();
            const pageRow = row(await render('page'), id);
            expect(pageRow?.props.rightElement ?? null).toBeNull();
            expect(pageRow?.props.showChevron).toBe(true);
        }
    });
    it('embeds in a page section as one flat run of picker rows, with no list chrome or sub-headings of its own', async () => {
        profilesListState.groups = {
            favoriteIds: new Set<string>(['anthropic']),
            favoriteProfiles: [
                { id: 'anthropic', name: 'Anthropic', isBuiltIn: true, compatibility: {}, compatibilityByTargetKey: {}, environmentVariables: [] },
            ],
            customProfiles: [
                { id: 'mine', name: 'Mine', isBuiltIn: false, compatibility: {}, compatibilityByTargetKey: {}, environmentVariables: [] },
            ],
            sharedProfiles: [],
            builtInProfiles: [
                { id: 'openai', name: 'OpenAI', isBuiltIn: true, compatibility: {}, compatibilityByTargetKey: {}, environmentVariables: [] },
            ],
        };
        const screen = await renderScreen(
            <ProfilesList
                presentation="embedded"
                section={{ title: 'Profile', description: 'What the session starts with.' }}
                customProfiles={[]}
                favoriteProfileIds={[]}
                onFavoriteProfileIdsChange={() => {}}
                selectedProfileId={null}
                onPressDefaultEnvironment={() => {}}
                machineId={null}
                includeDefaultEnvironmentRow
                includeAddProfileRow
                onAddProfilePress={() => {}}
            />,
        );

        // The list is the page section itself: no list of its own, and one sheet
        // holding every row, so no sub-heading ("Built-in profiles") is indented off the section's edge.
        expect(screen.findAll((node) => (node.type as unknown) === 'ItemList')).toHaveLength(0);
        const sheets = screen.findAll((node) => (node.type as unknown) === 'ItemGroup');
        expect(sheets).toHaveLength(1);
        expect(sheets[0]!.props.title).toBe('Profile');
        for (const id of ['default-environment', 'anthropic', 'mine', 'openai']) {
            expect(screen.findAllByProps({ testID: `profiles-list-row:${id}` }).length).toBeGreaterThan(0);
        }
        expect(screen.findAllByProps({ testID: 'profiles-list-add-profile' }).length).toBeGreaterThan(0);
        // It still chooses a profile like a picker.
        const selected = screen.findAll((node) => node.props?.selected === true && typeof node.props?.testID === 'string');
        expect(selected.map((node) => node.props.testID)).toContain('profiles-list-row:default-environment');
    });
});
