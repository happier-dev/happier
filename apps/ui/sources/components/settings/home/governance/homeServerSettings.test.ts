import { describe, expect, it } from 'vitest';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { homeRegistrySettingDeclaration } from './homeServerSettings';

describe('Home registry setting declarations', () => {
    it('resolves the Home name at its canonical Overview declaration rather than guessing its page', () => {
        const key = SERVER_CONFIG.HAPPIER_HOME_DISPLAY_NAME.key;
        const result = homeRegistrySettingDeclaration(key);
        expect(result?.declaration.storage).toMatchObject({ scope: 'home', kind: 'homeSettings', key });
        expect(result?.entry.key).toBe(key);
    });
});
