import { describe, expect, it } from 'vitest';

import type { PluginConnectedAccountAuthenticationModeV2 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';

import { rankConnectedAccountSetupModes } from './rankConnectedAccountSetupModes';

type Mode = Pick<PluginConnectedAccountAuthenticationModeV2, 'id' | 'kind'>;
const mode = (id: string, kind: Mode['kind']): Mode => ({ id, kind });

describe('rankConnectedAccountSetupModes', () => {
    it('recommends the sign-in that works from any device first: a code, then a browser, then pasting a key', () => {
        const ranked = rankConnectedAccountSetupModes([
            mode('setup-token', 'manual'),
            mode('oauth', 'oauthAuthorizationCode'),
            mode('device', 'oauthDeviceCode'),
        ]);

        expect(ranked.map((entry) => [entry.mode.id, entry.recommended])).toEqual([
            ['device', true],
            ['oauth', false],
            ['setup-token', false],
        ]);
    });

    it('recommends nothing when there is only one way to sign in, and keeps the declared order within a kind', () => {
        expect(rankConnectedAccountSetupModes([mode('api-key', 'manual')]).map((entry) => entry.recommended)).toEqual([false]);
        expect(rankConnectedAccountSetupModes([mode('a', 'manual'), mode('b', 'manual')]).map((entry) => entry.mode.id)).toEqual(['a', 'b']);
    });
});
