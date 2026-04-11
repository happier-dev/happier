import { describe, expect, it } from 'vitest';

import { ACCOUNT_CORE_SETTING_DEFINITIONS } from './accountCoreSettingDefinitions';

describe('ACCOUNT_CORE_SETTING_DEFINITIONS', () => {
    it('keeps separate Enter-to-send defaults for web and native', () => {
        expect(ACCOUNT_CORE_SETTING_DEFINITIONS.agentInputEnterToSend.default).toBe(true);
        expect(ACCOUNT_CORE_SETTING_DEFINITIONS.agentInputEnterToSendNative.default).toBe(false);
    });
});
