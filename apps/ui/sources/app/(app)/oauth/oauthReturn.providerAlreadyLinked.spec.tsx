import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    flushOAuthEffects,
    localSearchParamsMock,
    loginSpy,
    modal,
    replaceSpy,
    resetOAuthHarness,
    runWithOAuthScreen,
} from '@/auth/providers/github/test/oauthReturnHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@shopify/react-native-skia', () => ({}));

afterEach(() => {
    vi.unstubAllGlobals();
    resetOAuthHarness();
});

describe('oauth/[provider] return', () => {
    it('routes to /restore when provider identity is already linked to another account', async () => {
        replaceSpy.mockReset();
        loginSpy.mockReset();
        modal.alert.mockReset();
        localSearchParamsMock.mockReturnValue({
            provider: 'github',
            flow: 'auth',
            pending: 'p1',
        });
        const originalFetch = globalThis.fetch;
        const fetchMock = vi.fn(async () =>
            new Response(JSON.stringify({ error: 'provider-already-linked' }), {
                status: 409,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        await runWithOAuthScreen(async () => {
            await flushOAuthEffects();
            expect(modal.alert).toHaveBeenCalledTimes(1);
            expect(replaceSpy).toHaveBeenCalledWith('/restore');
            expect(loginSpy).not.toHaveBeenCalled();
        });
        vi.stubGlobal('fetch', originalFetch);
    });
});
