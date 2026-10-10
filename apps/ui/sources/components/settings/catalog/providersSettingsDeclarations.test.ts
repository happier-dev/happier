import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { SETTINGS_PAGE_DECLARATIONS } from './settingsPageDeclarations';
import { buildSettingHref } from './settingDeclarations';
import { SETTINGS_ROUTES } from './routes';

describe('Providers settings search', () => {
    it('offers collection controls at their declared anchors under the Providers feature owner', () => {
        const page = SETTINGS_PAGE_DECLARATIONS.find(candidate => candidate.pageId === 'providers' && !candidate.subpage);
        expect(page).toBeDefined();
        for (const anchor of ['providers.connections', 'providers.add', 'providers.custom', 'providers.local']) {
            const setting = Object.values(page!.settings).find(candidate => candidate.anchor === anchor);
            expect(setting, anchor).toBeDefined();
            expect(buildSettingHref(SETTINGS_ROUTES.providers, setting!)).toBe(`/settings/providers?setting=${anchor}`);
        }
        expect(page!.settings.local!.featureId).toBe('providers.localDiscovery');
    });
});
