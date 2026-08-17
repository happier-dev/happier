import { describe, expect, it } from 'vitest';

import { normalizePluginUiSettingsPageBindingV1 } from '@happier-dev/protocol/plugins/ui';

import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSettingsGroupProjection,
    type PluginUiSettingsPageProjection,
} from '@/sync/domains/plugins/ui/projection';

import { mergeAdmittedPluginSettingsPages } from './pluginSettingsPageCatalog';

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
        children: [],
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
        expect(pluginGroup).toMatchObject({
            title: 'Review',
            children: [expect.objectContaining({
                id: 'pluginSettingsPage:acme.review:policy',
                route: '/settings/plugins/acme.review/policy',
            })],
        });
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
