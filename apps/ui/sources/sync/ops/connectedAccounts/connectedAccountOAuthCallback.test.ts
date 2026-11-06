import { describe, expect, it, vi } from 'vitest';
import { CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1 } from '@happier-dev/protocol/connect/oauthAuthorizationResponse';
import { completeConnectedAccountOAuthCallback, createConnectedAccountOAuthCallbackController } from './connectedAccountOAuthCallback';

const callbackUrl = `${CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1}?code=code&state=attempt.with.dots.nonce&iss=`;

describe('Connected Account callback controller', () => {
    it('strips synchronously before completion or Account readiness, preserving the exact incoming answer', async () => {
        const replaceUrl = vi.fn();
        const controller = createConnectedAccountOAuthCallbackController({ callbackUrl, browser: { replaceUrl, close() {} } });
        expect(replaceUrl).toHaveBeenCalledExactlyOnceWith('/oauth/connected-account/callback');
        expect(await controller.complete()).toEqual({ kind: 'paste', callbackUrl });
        expect(replaceUrl).toHaveBeenCalledTimes(1);
    });

    it.each([
        'https://foreign.example/callback?code=code&state=attempt.nonce',
        `${CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1}?code=code&state=unroutable`,
        `${CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1}?code=code&state=attempt.nonce&error=access_denied`,
    ])('refuses untrusted or contradictory callback facts without an Action: %s', async callbackUrl => {
        const postMessage = vi.fn();
        const executeAction = vi.fn();
        expect(await completeConnectedAccountOAuthCallback({ callbackUrl,
            browser: { replaceUrl() {}, close() {}, opener: { origin: 'https://app.happier.dev', postMessage } },
            account: { serverId: 'home', expectedAccountId: 'account', assertCurrent() {}, executeAction },
        })).toEqual({ kind: 'invalid' });
        expect(postMessage).not.toHaveBeenCalled();
        expect(executeAction).not.toHaveBeenCalled();
    });

});
