import { describe, expect, it } from 'vitest';

import { flattenSettingsPageCatalog, SETTINGS_PAGE_CATALOG } from '@/components/settings/catalog/pageCatalog';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { getSettingsStackScreenDefinitions } from '@/components/settings/navigation/settingsRouteRegistry';

describe('API Tokens Settings route', () => {
    it('is a searchable Account child with canonical route and native chrome', () => {
        expect(SETTINGS_ROUTES.apiTokens).toBe('/settings/account/api-tokens');
        const catalog = flattenSettingsPageCatalog(SETTINGS_PAGE_CATALOG);
        const account = catalog.find((node) => node.id === 'account');
        const apiTokens = catalog.find((node) => node.id === 'apiTokens');

        expect(account?.children?.some((child) => child.id === 'apiTokens')).toBe(true);
        expect(apiTokens).toMatchObject({
            route: '/settings/account/api-tokens',
            titleKey: 'settingsApiTokens.title',
        });
        expect(apiTokens?.keywords).toEqual(expect.arrayContaining(['api token', 'personal access token', 'automation']));

        const chrome = getSettingsStackScreenDefinitions((key) => key);
        expect(chrome.find((definition) => definition.name === 'account/api-tokens')?.options.headerTitle)
            .toBe('settingsApiTokens.title');
    });
});
