import { describe, expect, it } from 'vitest';

import { getSettingsBreadcrumbs, getSettingsStackScreenDefinitions } from './settingsRouteRegistry';

describe('settingsRouteRegistry', () => {
    it('gives the prompts navigator ownership of its screen headers', () => {
        const settings = getSettingsStackScreenDefinitions((key) => key);
        expect(settings.find((entry) => entry.name === 'prompts')?.options.headerShown).toBe(false);
        expect(settings.some((entry) => entry.name.startsWith('prompts/'))).toBe(false);

        const prompts = getSettingsStackScreenDefinitions((key) => key, 'prompts');
        expect(prompts.find((entry) => entry.name === 'docs/index')?.options).toMatchObject({ headerShown: true });
        expect(typeof prompts.find((entry) => entry.name === 'index')?.options.headerTitle).toBe('function');
        expect(prompts.some((entry) => entry.name === 'account')).toBe(false);
    });

    it('registers the actions detail route chrome', () => {
        const definitions = getSettingsStackScreenDefinitions((key) => key);
        const routeNames = definitions.map((definition) => definition.name);

        expect(routeNames).toContain('actions/[actionId]');
    });

    it('gives native login import the shared settings header and back navigation', () => {
        const definition = getSettingsStackScreenDefinitions((key) => key)
            .find((entry) => entry.name === 'connected-services/import');

        expect(definition?.options).toMatchObject({
            headerBackTitle: 'common.back',
            headerShown: true,
        });
        expect(typeof definition?.options.headerTitle).toBe('function');
    });

    it('links every upper level of a nested settings screen and not the current one', () => {
        const crumbs = getSettingsBreadcrumbs(
            (key) => key,
            'connected-services/provider-state-sharing',
            [
                { name: 'connected-services/index', titleKey: 'settings.connectedServices' },
                { name: 'connected-services/provider-state-sharing', titleKey: 'connectedServices.providerStateSharing.title' },
            ],
            'settings',
        );
        expect(crumbs).toEqual([
            { title: 'settings.title', href: '/settings' },
            { title: 'settings.connectedServices', href: '/settings/connected-services' },
            { title: 'connectedServices.providerStateSharing.title' },
        ]);
    });

    it('roots prompts breadcrumbs under the prompts navigator and skips routes that need params', () => {
        const crumbs = getSettingsBreadcrumbs(
            (key) => key,
            'docs/[id]/export',
            [
                { name: 'docs/index', titleKey: 'promptLibrary.prompts' },
                { name: 'docs/[id]', titleKey: 'promptLibrary.editPrompt' },
                { name: 'docs/[id]/export', titleKey: 'promptLibrary.externalAssetsExportTitle' },
            ],
            'prompts',
        );
        expect(crumbs).toEqual([
            { title: 'settings.title', href: '/settings' },
            { title: 'settings.prompts', href: '/settings/prompts' },
            { title: 'promptLibrary.prompts', href: '/settings/prompts/docs' },
            { title: 'promptLibrary.editPrompt' },
            { title: 'promptLibrary.externalAssetsExportTitle' },
        ]);
    });
});
