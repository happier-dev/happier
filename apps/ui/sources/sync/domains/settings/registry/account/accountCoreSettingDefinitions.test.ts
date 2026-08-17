import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol';

describe('Protocol Account settings catalog', () => {
    it('keeps separate Enter-to-send defaults for web and native', () => {
        expect(ACCOUNT_SETTING_DEFINITIONS.agentInputEnterToSend.default).toBe(true);
        expect(ACCOUNT_SETTING_DEFINITIONS.agentInputEnterToSendNative.default).toBe(false);
    });
});
