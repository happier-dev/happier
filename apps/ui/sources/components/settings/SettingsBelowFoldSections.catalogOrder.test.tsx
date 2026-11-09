import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';

const catalogState = vi.hoisted(() => ({ tree: [] as ResolvedSettingsPageNode[] }));

vi.mock('@/components/settings/catalog/runtime/useResolvedSettingsPageIdentity', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/settings/catalog/runtime/useResolvedSettingsPageIdentity')>(),
    useResolvedSettingsPageNavigation: () => ({
        tree: catalogState.tree,
        activePageId: null,
        search: () => [],
    }),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('ItemGroup', props, children)
    ),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/settings/SettingsDeveloperSection', () => ({
    SettingsDeveloperSection: () => null,
}));

const CATALOG_TREE: ResolvedSettingsPageNode[] = [{
    id: 'settings',
    title: 'Settings',
    route: '/settings',
    keywords: [],
    children: [{
        id: 'groupAiAndAgents',
        title: 'AI and Agents',
        keywords: [],
        children: [{ id: 'agents', title: 'Agents', route: '/settings/agents', keywords: [] }],
    }, {
        id: 'groupSessionsBehavior',
        title: 'Sessions',
        keywords: [],
        children: [{ id: 'session', title: 'Session', route: '/settings/session', keywords: [] }],
    }, {
        id: 'groupFilesAndSourceControl',
        title: 'Files',
        keywords: [],
        children: [{ id: 'attachments', title: 'Attachments', route: '/settings/attachments', keywords: [] }],
    }, {
        id: 'groupSystem',
        title: 'System',
        keywords: [],
        children: [{ id: 'servers', title: 'Servers', route: '/settings/servers', keywords: [] }],
    }, {
        id: 'pluginSettingsGroup:acme.review:review',
        title: 'Review',
        keywords: [],
        children: [{
            id: 'pluginSettingsPage:acme.review:policy',
            title: 'Review policy',
            route: '/settings/plugins/acme.review/policy',
            keywords: ['review'],
            pluginSettingsPage: { pluginId: 'acme.review', pageId: 'policy' },
        }],
    }],
}];

const GROUP_TITLES = ['AI and Agents', 'Sessions', 'Files', 'System', 'Review'];

async function renderSections(props: Readonly<{ catalog: boolean; stage: number }>) {
    catalogState.tree = CATALOG_TREE;
    const push = vi.fn();
    const onNavigate = vi.fn();
    const { SettingsBelowFoldSections, SettingsCatalogGroups } = await import('./SettingsBelowFoldSections');
    const Sections = props.catalog ? SettingsCatalogGroups : SettingsBelowFoldSections;
    const screen = await renderScreen(
        <Sections
            appVersion="1.0.0"
            automationsNeedLocalEnablement={false}
            devModeEnabled={false}
            handleGitHub={vi.fn()}
            handleReportIssue={vi.fn()}
            handleVersionClick={vi.fn()}
            onNavigate={onNavigate}
            router={{ push } as never}
            showAutomations={false}
            showChangelog={false}
            showRateUs={false}
            stage={props.stage}
            supportUs={null}
        />,
    );
    const groupTitles = screen.findAllByType('ItemGroup' as never).map((group) => group.props.title);
    return { screen, push, onNavigate, groupTitles };
}

describe('SettingsBelowFoldSections catalog order', () => {
    it('keeps catalog groups ordered and delegates every catalog destination to the host navigation owner', async () => {
        const { screen, push, onNavigate, groupTitles } = await renderSections({ catalog: true, stage: 3 });

        expect(groupTitles.filter((title) => GROUP_TITLES.includes(title))).toEqual(GROUP_TITLES);

        for (const [title, route] of [
            ['Agents', '/settings/agents'],
            ['Session', '/settings/session'],
            ['Attachments', '/settings/attachments'],
            ['Servers', '/settings/servers'],
            ['Review policy', '/settings/plugins/acme.review/policy'],
        ] as const) {
            screen.findAllByProps({ title })[0]?.props.onPress();
            expect(onNavigate).toHaveBeenCalledWith(route);
        }
        expect(push).not.toHaveBeenCalled();
    });

    it('keeps the categories out of the sections below the fold, keeping About', async () => {
        const { groupTitles } = await renderSections({ catalog: false, stage: 4 });

        expect(groupTitles.filter((title) => GROUP_TITLES.includes(title))).toEqual([]);
        expect(groupTitles).toContain('settings.about');
    });
});
