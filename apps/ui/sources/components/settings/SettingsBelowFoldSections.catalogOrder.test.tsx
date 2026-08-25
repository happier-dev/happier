import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';

const catalogState = vi.hoisted(() => ({ tree: [] as ResolvedSettingsPageNode[] }));

vi.mock('@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog', () => ({
    useResolvedSettingsPageCatalog: () => ({
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

describe('SettingsBelowFoldSections catalog order', () => {
    it('keeps catalog groups ordered and delegates every catalog destination to the host navigation owner', async () => {
        catalogState.tree = [{
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
        const push = vi.fn();
        const onNavigate = vi.fn();
        const { SettingsBelowFoldSections } = await import('./SettingsBelowFoldSections');
        const screen = await renderScreen(
            <SettingsBelowFoldSections
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
                stage={3}
                terminalUseTmux={false}
                theme={{ colors: { text: { secondary: '#777' } } } as never}
            />,
        );

        const rootTitles = screen.findAllByType('ItemGroup' as never)
            .map((group) => group.props.title)
            .filter((title): title is string => ['AI and Agents', 'Sessions', 'Files', 'System', 'Review'].includes(title));
        expect(rootTitles).toEqual(['AI and Agents', 'Sessions', 'Files', 'System', 'Review']);

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
});
