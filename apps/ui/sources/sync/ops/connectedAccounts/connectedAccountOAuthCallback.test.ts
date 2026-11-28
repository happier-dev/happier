import { describe, expect, it, vi } from 'vitest';
import { CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1 } from '@happier-dev/protocol/connect/oauthAuthorizationResponse';
import { parseOauthCallbackUrl } from '@/utils/auth/oauthCore';
import { completeConnectedAccountOAuthCallback, createConnectedAccountOAuthCallbackController } from './connectedAccountOAuthCallback';

const callbackUrl = `${CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1}?code=code&state=attempt.with.dots.nonce&iss=`;

describe('Connected Account callback controller', () => {
    it('retains only the error code for an unauthenticated denial', async () => {
        const callbackUrl = `${CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1}?${new URLSearchParams({
            error: 'invalid_scope',
            error_description: 'Workspace and project access must be requested at the same level.',
            state: '00000000-0000-4000-8000-000000000000.qa-denial-sample',
        })}`;
        expect(await completeConnectedAccountOAuthCallback({ callbackUrl })).toEqual({
            kind: 'denied',
            denial: { error: 'invalid_scope' },
        });
    });

    it('strips synchronously before completion or Account readiness, preserving the exact incoming answer', async () => {
        const replaceUrl = vi.fn();
        const controller = createConnectedAccountOAuthCallbackController({ callbackUrl, browser: { replaceUrl, close() {} } });
        expect(replaceUrl).toHaveBeenCalledExactlyOnceWith('/oauth/connected-account/callback');
        expect(await controller.complete()).toEqual({ kind: 'paste', answer: callbackUrl });
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

    it.each([
        ['code#state, which the Connect sheet reads back exactly', `${CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1}?code=Ab9_x-Q&state=attempt-1.nonce`, 'Ab9_x-Q#attempt-1.nonce'],
        ['the whole callback when it carries an issuer', `${CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1}?code=c&state=attempt-1.nonce&iss=https%3A%2F%2Fissuer.example`, null],
        ['the whole callback when the code cannot stand before a #', `${CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1}?code=a%3Db&state=attempt-1.nonce`, null],
    ])('hands the person %s', async (_name, incoming, compact) => {
        const outcome = await completeConnectedAccountOAuthCallback({ callbackUrl: incoming, browser: { replaceUrl() {}, close() {} } });
        const answer = compact ?? incoming;
        expect(outcome).toEqual({ kind: 'paste', answer });
        const pasted = parseOauthCallbackUrl({ url: answer, redirectUri: CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1 });
        const original = new URL(incoming).searchParams;
        expect(pasted).toMatchObject({ code: original.get('code'), state: original.get('state') });
    });
});
