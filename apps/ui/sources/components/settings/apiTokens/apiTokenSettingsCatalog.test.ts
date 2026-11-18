import { describe, expect, it } from 'vitest';

import { flattenSettingsPageCatalog, SETTINGS_PAGE_CATALOG } from '@/components/settings/catalog/pageCatalog';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { getSettingsStackScreenDefinitions } from '@/components/settings/navigation/settingsRouteRegistry';
import { settingsSearchKeywordsTranslations } from '@/text/translations/settingsSearchKeywordsTranslations';

describe('API Tokens Settings route', () => {
    it('is a searchable Account child with canonical route and native chrome', () => {
        expect(SETTINGS_ROUTES.apiTokens).toBe('/settings/account/api-tokens');
        const catalog = flattenSettingsPageCatalog(SETTINGS_PAGE_CATALOG);
        const account = catalog.find((node) => node.id === 'account');
        const security = catalog.find((node) => node.id === 'accountSecurity');
        const apiTokens = catalog.find((node) => node.id === 'apiTokens');

        expect(account?.children?.some((child) => child.id === 'accountSecurity')).toBe(true);
        expect(security?.route).toBe('/settings/account/security');
        expect(security?.children?.some((child) => child.id === 'apiTokens')).toBe(true);
        expect(apiTokens).toMatchObject({
            route: '/settings/account/api-tokens',
            titleKey: 'settingsApiTokens.title',
        });
        // Search words are translated (one comma-separated key per page), so every locale can find the page.
        expect(apiTokens?.keywordsKey).toBe('settingsSearchKeywords.apiTokens');
        const englishWords = settingsSearchKeywordsTranslations.en.settingsSearchKeywords.apiTokens
            .split(',').map((word) => word.trim());
        expect(englishWords).toEqual(expect.arrayContaining(['api token', 'personal access token', 'automation']));

        const chrome = getSettingsStackScreenDefinitions((key) => key);
        const tokenChrome = chrome.find((definition) => definition.name === 'account/api-tokens')?.options;
        // The page owns its title. The stack header supplies the parent Back control.
        expect(tokenChrome?.headerTitle).toBe('');
        expect(tokenChrome?.headerLeft).toEqual(expect.any(Function));
    });
});
