import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerFetchAtEndpoint } from './client';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';

const serverUrl = 'https://body-contract.example.test';
const path = '/v1/sharing/public/share-id';

afterEach(async () => {
    await resetServerReachabilitySupervisors();
    resetRuntimeFetch();
});

describe.each(['endpoint', 'scoped', 'semantic'] as const)('%s request body headers', (transport) => {
    async function request(init: RequestInit): Promise<RequestInit> {
        let issued: RequestInit | undefined;
        // Only the external HTTP/carrier boundary is replaced. Request composition,
        // compatibility, authentication and reachability remain real.
        const send = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
            if (String(url) === `${serverUrl}${path}`) issued = options;
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        });
        setRuntimeFetch(send);
        if (transport === 'scoped') {
            await runtimeFetchWithServerReachability({
                serverUrl, token: 'account-token', url: `${serverUrl}${path}`, init,
            });
        } else {
            const carrier: HomeCarrier = {
                endpointId: 'a'.repeat(64),
                readObservedPath: () => 'relay',
                request: send,
                createWebSocket: () => { throw new Error('HTTP test'); },
            };
            await createServerFetchAtEndpoint({
                endpointUrl: serverUrl,
                credentials: { token: 'account-token' },
                ...(transport === 'semantic' ? { homeCarrier: carrier } : {}),
            })(path, init, { retry: 'none' });
        }
        expect(issued).toBeDefined();
        return issued!;
    }

    const emptyBodyRequests: RequestInit[] = [
        { method: 'GET', body: undefined, headers: { 'Content-Type': 'application/json' } },
        { method: 'DELETE', body: null, headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }) },
        { method: 'DELETE', body: undefined, headers: { 'content-type': 'application/problem+json' } },
        { method: 'POST', body: '', headers: [['CONTENT-TYPE', 'application/json']] },
    ];
    it.each(emptyBodyRequests)('omits JSON content type for an empty $method request', async (init) => {
        const issued = await request(init);
        expect(new Headers(issued.headers).get('content-type')).toBeNull();
        expect(issued.body).toBe(init.body);
    });

    it('preserves the JSON content type and body for a populated request', async () => {
        const body = JSON.stringify({ subject: { type: 'artifact', artifactId: 'artifact-id' } });
        const issued = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        expect(new Headers(issued.headers).get('content-type')).toBe('application/json');
        expect(issued.body).toBe(body);
    });

    it('preserves an explicitly supplied non-JSON content type', async () => {
        const issued = await request({ method: 'DELETE', headers: { 'Content-Type': 'application/octet-stream' } });
        expect(new Headers(issued.headers).get('content-type')).toBe('application/octet-stream');
    });
});
