import { describe, expect, it, vi } from 'vitest';
import { MCP_OAUTH_CALLBACK_URL_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';

import { completeMcpOAuthCallback } from './mcpOAuthCallback';

const callbackUrl = `${MCP_OAUTH_CALLBACK_URL_V1}?code=code-1&state=attempt.with.dots.nonce&iss=https%3A%2F%2Fissuer.example`;

describe('MCP OAuth callback controller', () => {
    it('strips the browser URL before handing off to a hosted web app opener only, without an Action', async () => {
        const effects: unknown[] = [];
        const executeAction = vi.fn();
        const outcome = await completeMcpOAuthCallback({
            callbackUrl,
            browser: { replaceUrl: path => effects.push(path), close: () => effects.push('closed'),
                opener: { origin: 'https://cloud.happier.dev', postMessage: (message, origin) => effects.push({ message, origin }) } },
            account: { serverId: 'home', expectedAccountId: 'account', assertCurrent() {}, executeAction },
        });
        expect(outcome).toEqual({ kind: 'opener' });
        expect(effects).toEqual(['/oauth/mcp/callback', { origin: 'https://cloud.happier.dev', message: {
            type: 'happier.mcp.oauth', code: 'code-1', state: 'attempt.with.dots.nonce', iss: 'https://issuer.example',
        } }, 'closed']);
        expect(executeAction).not.toHaveBeenCalled();
    });

    it('returns the full callback, not a raw code, to signed-out paste presentation', async () => {
        const replaceUrl = vi.fn();
        expect(await completeMcpOAuthCallback({ callbackUrl, browser: { replaceUrl, close() {} } }))
            .toEqual({ kind: 'paste', callbackUrl });
        expect(replaceUrl).toHaveBeenCalledWith('/oauth/mcp/callback');
    });

    it('strips an invalid callback without posting untrusted response facts', async () => {
        const replaceUrl = vi.fn();
        const postMessage = vi.fn();
        expect(await completeMcpOAuthCallback({ callbackUrl: 'https://foreign.example/callback?code=code&state=attempt.nonce',
            browser: { replaceUrl, close() {}, opener: { postMessage } } }))
            .toEqual({ kind: 'invalid' });
        expect(replaceUrl).toHaveBeenCalledWith('/oauth/mcp/callback');
        expect(postMessage).not.toHaveBeenCalled();
    });

    it.each([
        `${MCP_OAUTH_CALLBACK_URL_V1}?code=code&state=attempt.nonce&error=access_denied`,
        `${MCP_OAUTH_CALLBACK_URL_V1}?code=code`,
        `${MCP_OAUTH_CALLBACK_URL_V1}?code=code&state=unroutable`,
    ])('does not hand off incomplete or contradictory response facts: %s', async (callbackUrl) => {
        const postMessage = vi.fn();
        const replaceUrl = vi.fn();
        expect(await completeMcpOAuthCallback({ callbackUrl,
            browser: { replaceUrl, close() {}, opener: { postMessage } } }))
            .toEqual({ kind: 'invalid' });
        expect(replaceUrl).toHaveBeenCalledWith('/oauth/mcp/callback');
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('preserves an explicitly empty issuer for daemon validation', async () => {
        const postMessage = vi.fn();
        expect(await completeMcpOAuthCallback({ callbackUrl: `${MCP_OAUTH_CALLBACK_URL_V1}?code=code&state=attempt.nonce&iss=`,
            browser: { replaceUrl() {}, close() {}, opener: { origin: 'https://cloud.happier.dev', postMessage } } }))
            .toEqual({ kind: 'opener' });
        expect(postMessage).toHaveBeenCalledWith({ type: 'happier.mcp.oauth', code: 'code', state: 'attempt.nonce', iss: '' }, 'https://cloud.happier.dev');
    });

    it('rejects retired Account custody before Action work', async () => {
        const executeAction = vi.fn();
        await expect(completeMcpOAuthCallback({ callbackUrl, account: {
            serverId: 'home', expectedAccountId: 'old-account', executeAction,
            assertCurrent: () => { throw new Error('account_retired'); },
        } })).rejects.toThrow('account_retired');
        expect(executeAction).not.toHaveBeenCalled();
    });

});
