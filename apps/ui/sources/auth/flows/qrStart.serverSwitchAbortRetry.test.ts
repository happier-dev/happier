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

        let callCount = 0;
        setRuntimeFetch(async () => {
            callCount += 1;
            if (callCount === 1) {
                abortServerFetches('server-switch');
                throw new DOMException('Aborted', 'AbortError');
            }
            return new Response(null, { status: 200 });
        });

        await expect(authQRStart(generateAuthKeyPair())).resolves.toBe(true);
        expect(callCount).toBe(2);
    });

    it('returns false after repeated server-switch aborts', async () => {
        upsertAndActivateServer({ serverUrl: 'http://server.example.test', scope: 'tab' });

        let callCount = 0;
        setRuntimeFetch(async () => {
            callCount += 1;
            abortServerFetches('server-switch');
            throw new DOMException('Aborted', 'AbortError');
        });

        await expect(authQRStart(generateAuthKeyPair())).resolves.toBe(false);
        expect(callCount).toBeGreaterThan(1);
        expect(callCount).toBeLessThan(8);
    });
});
