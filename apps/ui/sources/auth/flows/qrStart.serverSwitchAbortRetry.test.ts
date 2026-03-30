import { afterEach, describe, expect, it } from 'vitest';

import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { abortServerFetches, resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';

import { authQRStart, generateAuthKeyPair } from './qrStart';

describe('authQRStart', () => {
    afterEach(() => {
        resetRuntimeFetch();
    });

    it('retries when aborted due to a server switch', async () => {
        upsertAndActivateServer({ serverUrl: 'http://server.example.test', scope: 'tab' });

        let totalFetchCount = 0;
        let authRequestCount = 0;
        let didAbort = false;

        setRuntimeFetch(async (input) => {
            totalFetchCount += 1;
            const url = String(input ?? '');
            const isAuthRequest = url.includes('/v1/auth/account/request');

            if (isAuthRequest) {
                authRequestCount += 1;
                if (!didAbort) {
                    didAbort = true;
                    abortServerFetches('server-switch');
                    throw new DOMException('Aborted', 'AbortError');
                }
            }

            return new Response(null, { status: 200 });
        });

        await expect(authQRStart(generateAuthKeyPair())).resolves.toBe(true);
        expect(authRequestCount).toBe(2);
        expect(totalFetchCount).toBeGreaterThanOrEqual(authRequestCount);
    });

    it('returns false after repeated server-switch aborts', async () => {
        upsertAndActivateServer({ serverUrl: 'http://server.example.test', scope: 'tab' });

        let totalFetchCount = 0;
        let authRequestCount = 0;

        setRuntimeFetch(async (input) => {
            totalFetchCount += 1;
            const url = String(input ?? '');
            const isAuthRequest = url.includes('/v1/auth/account/request');

            if (isAuthRequest) {
                authRequestCount += 1;
                abortServerFetches('server-switch');
                throw new DOMException('Aborted', 'AbortError');
            }

            return new Response(null, { status: 200 });
        });

        await expect(authQRStart(generateAuthKeyPair())).resolves.toBe(false);
        expect(authRequestCount).toBeGreaterThan(1);
        expect(authRequestCount).toBeLessThanOrEqual(4);
        expect(totalFetchCount).toBeGreaterThanOrEqual(authRequestCount);
    });
});
