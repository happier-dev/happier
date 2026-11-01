import { describe, expect, it } from 'vitest';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { homeRegistrySettingDeclaration } from './homeServerSettings';
import { HOME_OVERVIEW_SETTINGS } from './homeOverviewSettings';

describe('Home registry setting declarations', () => {
    it('projects Home name storage and labels from its canonical Overview declaration', () => {
        const key = SERVER_CONFIG.HAPPIER_HOME_DISPLAY_NAME.key;
        const result = homeRegistrySettingDeclaration(key);
        expect(result?.declaration.storage).toMatchObject({ scope: 'home', kind: 'homeSettings', key });
        expect(result?.entry.key).toBe(key);
        expect(result?.declaration).toEqual(HOME_OVERVIEW_SETTINGS.sections.thisHome.settings.homeName);
    });
});
