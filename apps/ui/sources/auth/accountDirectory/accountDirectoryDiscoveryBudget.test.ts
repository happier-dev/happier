import { afterEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn() }));
// The network is the boundary; feature decoding, cache and HTTP lifecycle stay real.
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch: boundary.request,
}));

import { accountDirectoryAuthClient } from './accountDirectoryAuthClient';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createDeferred } from '@/dev/testkit';

describe('account-service discovery lifetime', () => {
    afterEach(() => {
        vi.useRealTimers();
        boundary.request.mockReset();
        resetServerFeaturesClientForTests();
    });

    it('waits for a valid slow endpoint observation instead of declaring a pending request unreachable', async () => {
        vi.useFakeTimers();
        const response = createDeferred<Response>();
        let requestSignal: AbortSignal | null | undefined;
        boundary.request.mockImplementation((_url: unknown, init?: RequestInit) => {
            requestSignal = init?.signal;
            return response.promise;
        });
        let settled = false;
        const discovery = accountDirectoryAuthClient.discoverAuthenticationMethods({ endpointUrl: 'https://slow-directory.test' })
            .then((result) => { settled = true; return result; });

        await vi.advanceTimersByTimeAsync(61_000);
        expect(settled).toBe(false);
        expect(requestSignal?.aborted).toBe(false);
        response.resolve(Response.json({ features: {}, capabilities: {} }));
        // This endpoint answered as an ordinary Home. A pending request is never an outage.
        await expect(discovery).resolves.toMatchObject({
            kind: 'not_account_service',
            snapshot: { status: 'ready' },
        });
    });
});
