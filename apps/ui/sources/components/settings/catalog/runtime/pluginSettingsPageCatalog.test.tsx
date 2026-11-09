import { describe, expect, it } from 'vitest';

import { normalizePluginUiSettingsPageBindingV1 } from '@happier-dev/protocol/plugins/ui';

import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSettingsGroupProjection,
    type PluginUiSettingsPageProjection,
} from '@/sync/domains/plugins/ui/projection';

import type * as React from 'react';
import { InstalledPluginMarkById } from '@/components/plugins/shared/InstalledPluginMarkById';

import {
    mergeAdmittedPluginSettingsPages,
    readPluginSettingsPageRouteParams,
    resolveAdmittedPluginSettingsPage,
} from './pluginSettingsPageCatalog';

function settingsBinding(pluginId: string, pageId: string, rendererId = 'settings-renderer') {
    const binding = normalizePluginUiSettingsPageBindingV1({
        pluginId,
        pageId,
        rendererId,
    });
    if (!binding) throw new Error('settings fixture needs a registry-normalized binding');
    return binding;
}

function group(pluginId: string, localId: string, title: string): PluginUiSettingsGroupProjection {
    return {
        id: `settingsGroup:${pluginId}:${localId}`,
        pluginId,
        contributionKind: 'settingsGroup',
        group: {
            id: { pluginId, localId },
            title,
            icon: 'settings',
        },
    };
}

function page(input: Readonly<{
    pluginId: string;
    localId: string;
    group: unknown;
    title: string;
    binding?: ReturnType<typeof settingsBinding>;
}>): PluginUiSettingsPageProjection {
    const binding = input.binding ?? settingsBinding(input.pluginId, input.localId);
    return {
        id: `settingsPage:${input.pluginId}:${input.localId}`,
        pluginId: input.pluginId,
        contributionKind: 'settingsPage',
        descriptorId: input.localId,
        page: {
            id: { pluginId: input.pluginId, localId: input.localId },
            group: input.group,
            title: input.title,
            keywords: ['review'],
            icon: 'settings',
        },
        binding,
        renderer: { kind: 'declarative' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
    };
}

function projection(input: Readonly<{
    groups?: readonly PluginUiSettingsGroupProjection[];
    pages: readonly PluginUiSettingsPageProjection[];
}>): PluginUiProjectionModel {
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        settingsGroupsById: Object.freeze(Object.fromEntries((input.groups ?? []).map((entry) => [entry.id, entry]))),
        settingsPagesById: Object.freeze(Object.fromEntries(input.pages.map((entry) => [entry.id, entry]))),
    };
}

const baseCatalog = [{
    id: 'settings',
    titleKey: 'settings.title',
    route: '/settings',
    children: [{
        id: 'groupGeneral',
        titleKey: 'settings.general',
        children: [{ id: 'plugins', titleKey: 'settingsPlugins.surfaces.navigationTitle', route: '/settings/plugins' }],
    }, {
        id: 'groupSystem',
        titleKey: 'settings.system',
        children: [],
    }],
}] as const;

describe('mergeAdmittedPluginSettingsPages', () => {
    it('feeds the one Settings tree with qualified pages in host and same-plugin groups', () => {
        const model = projection({
            groups: [group('acme.review', 'review', 'Review')],
            pages: [
                page({
                    pluginId: 'acme.review',
                    localId: 'defaults',
                    group: { kind: 'host', id: 'general' },
                    title: 'Review defaults',
                }),
                page({
                    pluginId: 'acme.review',
                    localId: 'policy',
                    group: { kind: 'plugin', id: { pluginId: 'acme.review', localId: 'review' } },
                    title: 'Review policy',
                }),
            ],
        });

        const catalog = mergeAdmittedPluginSettingsPages({ baseCatalog, projection: model, locale: 'en' });
        const root = catalog[0];
        if (!root) throw new Error('root catalog row is required');
        const general = root.children?.find((entry) => entry.id === 'groupGeneral');
        const pluginGroup = root.children?.find((entry) => entry.id === 'pluginSettingsGroup:acme.review:review');

        expect(general?.children).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'pluginSettingsPage:acme.review:defaults',
                title: 'Review defaults',
                route: '/settings/plugins/acme.review/defaults',
                pluginSettingsPage: { pluginId: 'acme.review', pageId: 'defaults' },
            }),
        ]));
        expect(pluginGroup).toBeUndefined();
        // A page in a host group reads as one of the host's rows (Settings → Channels, owner Q2): it leads
        // with its declared glyph, like its neighbours, not the plugin's mark.
        const hostRowIcon = general?.children?.find((entry) => entry.id === 'pluginSettingsPage:acme.review:defaults')
            ?.icon?.({ theme: { colors: { text: { secondary: 'ink' } } } as never }) as React.ReactElement<{ name?: string }> | undefined;
        expect(hostRowIcon?.type).not.toBe(InstalledPluginMarkById);
        expect(hostRowIcon?.props.name).toBe('gear');
        // Plugin destinations are disclosed under the Plugins page's own row, not a heading of their own.
        expect(root.children?.find((entry) => entry.id === 'groupPlugins')).toBeUndefined();
        const plugins = general?.children?.find((entry) => entry.id === 'plugins');
        expect(plugins).toMatchObject({
            route: '/settings/plugins',
            children: [expect.objectContaining({
                id: 'pluginSettingsPage:acme.review:policy',
                title: 'Review',
                subtitle: 'Review policy',
                route: '/settings/plugins/acme.review/policy',
            })],
        });
    });

    it('names a one-page plugin group once, by its plugin, and keeps a several-page group as its own section', () => {
        const model = projection({
            groups: [
                group('acme.github', 'github', 'GitHub'),
                group('acme.gitlab', 'gitlab', 'GitLab'),
                group('acme.channels', 'channels', 'Conversation channels'),
            ],
            pages: [
                page({ pluginId: 'acme.github', localId: 'sources', group: { kind: 'plugin', id: { pluginId: 'acme.github', localId: 'github' } }, title: 'PRs & Issues' }),
                page({ pluginId: 'acme.gitlab', localId: 'sources', group: { kind: 'plugin', id: { pluginId: 'acme.gitlab', localId: 'gitlab' } }, title: 'PRs & Issues' }),
                page({ pluginId: 'acme.channels', localId: 'connections', group: { kind: 'plugin', id: { pluginId: 'acme.channels', localId: 'channels' } }, title: 'Connections' }),
                page({ pluginId: 'acme.channels', localId: 'routing', group: { kind: 'plugin', id: { pluginId: 'acme.channels', localId: 'channels' } }, title: 'Routing' }),
            ],
        });

        const catalog = mergeAdmittedPluginSettingsPages({ baseCatalog, projection: model, locale: 'en' });
        const rootChildren = catalog[0]?.children ?? [];
        // Every plugin destination sits under the Plugins row (disclosed on demand); no heading per plugin
        // and no heading of their own in the rail.
        expect(rootChildren.map((entry) => entry.id)).toEqual(['groupGeneral', 'groupSystem']);
        const plugins = rootChildren[0]!.children!.find((entry) => entry.id === 'plugins')!;
        expect(plugins.children?.map((entry) => [entry.title, entry.route ?? null])).toEqual([
            ['Conversation channels', null],
            ['GitHub', '/settings/plugins/acme.github/sources'],
            ['GitLab', '/settings/plugins/acme.gitlab/sources'],
        ]);
        // The page's own title stays findable even though the row is named by its plugin.
        expect(plugins.children?.[1]?.keywords).toEqual(expect.arrayContaining(['PRs & Issues']));
        expect(plugins.children?.[0]?.children?.map((entry) => entry.title)).toEqual(['Connections', 'Routing']);
        // Each plugin row leads with that plugin's own mark, not a shared generic glyph.
        const markOf = (entry: (typeof rootChildren)[number] | undefined) => {
            const icon = entry?.icon?.({ theme: {} as never }) as React.ReactElement<{ pluginId?: string }> | undefined;
            return icon?.type === InstalledPluginMarkById ? icon.props.pluginId : null;
        };
        expect(plugins.children?.map(markOf)).toEqual(['acme.channels', 'acme.github', 'acme.gitlab']);
    });

    it('fails closed for a foreign plugin group or a binding that is not its projected Settings destination', () => {
        const model = projection({
            groups: [group('acme.review', 'review', 'Review')],
            pages: [
                page({
                    pluginId: 'acme.review',
                    localId: 'foreign-group',
                    group: { kind: 'plugin', id: { pluginId: 'other.plugin', localId: 'review' } },
                    title: 'Foreign group',
                }),
                page({
                    pluginId: 'acme.review',
                    localId: 'wrong-binding',
                    group: { kind: 'host', id: 'system' },
                    title: 'Wrong binding',
                    binding: settingsBinding('acme.review', 'another-page'),
                }),
            ],
        });

        const catalog = mergeAdmittedPluginSettingsPages({ baseCatalog, projection: model, locale: 'en' });
        const ids = JSON.stringify(catalog);

        expect(ids).not.toContain('foreign-group');
        expect(ids).not.toContain('wrong-binding');
        expect(ids).not.toContain('pluginSettingsGroup:acme.review:review');
    });
});

describe('resolveAdmittedPluginSettingsPage', () => {
    it('names an opened page the way the Settings tree names its row, so a tab never says another page\'s title', () => {
        // Sentry's only page is titled "PRs & Issues": as a tab or page header that names the PRs & Issues
        // page itself, which is a different destination. The tree already names a one-page group by its
        // plugin; the opened page follows the same rule. A several-page group keeps each page's own title.
        const model = projection({
            groups: [group('acme.sentry', 'sentry', 'Sentry'), group('acme.channels', 'channels', 'Conversation channels')],
            pages: [
                page({ pluginId: 'acme.sentry', localId: 'sources', group: { kind: 'plugin', id: { pluginId: 'acme.sentry', localId: 'sentry' } }, title: 'PRs & Issues' }),
                page({ pluginId: 'acme.channels', localId: 'connections', group: { kind: 'plugin', id: { pluginId: 'acme.channels', localId: 'channels' } }, title: 'Connections' }),
                page({ pluginId: 'acme.channels', localId: 'routing', group: { kind: 'plugin', id: { pluginId: 'acme.channels', localId: 'channels' } }, title: 'Routing' }),
            ],
        });
        expect(resolveAdmittedPluginSettingsPage({ projection: model, pluginId: 'acme.sentry', pageId: 'sources', locale: 'en' })?.title).toBe('Sentry');
        expect(resolveAdmittedPluginSettingsPage({ projection: model, pluginId: 'acme.channels', pageId: 'routing', locale: 'en' })?.title).toBe('Routing');
    });
});

describe('readPluginSettingsPageRouteParams', () => {
    it('treats an absent sub-location as the page root and rejects malformed present locations', () => {
        expect(readPluginSettingsPageRouteParams({
            pluginId: 'acme.review',
            pageId: 'policy',
        })).toEqual({
            pluginId: 'acme.review',
            pageId: 'policy',
            subPath: '',
        });
        expect(readPluginSettingsPageRouteParams({
            pluginId: 'acme.review',
            pageId: 'policy',
            subPath: ['bindings/1', 'bindings/2'],
        })).toEqual({
            pluginId: 'acme.review',
            pageId: 'policy',
            subPath: null,
        });
        expect(readPluginSettingsPageRouteParams({
            pluginId: 'acme.review',
            pageId: 'policy',
            subPath: 42,
        })).toEqual({
            pluginId: 'acme.review',
            pageId: 'policy',
            subPath: null,
        });
    });
});
