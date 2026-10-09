import { describe, expect, it } from 'vitest';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { createCuaNativeClient } from './nativeClient.js';

describe('single Cua client Fleet transport', () => {
    it('preserves the native gateway path prefix when resolving claim routes', async () => {
        const urls: string[] = [];
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: { async run() { throw new Error('Not a CLI call'); } },
            fleet: { origin: 'https://fleet.example/cyclops', http: { async request(request) {
                urls.push(request.url);
                return { status: 404, finalUrl: request.url, headers: {}, body: new Uint8Array() };
            } } } });
        expect(await native.fleetJson({ method: 'GET', path: 'api/k8s/claims/owned' })).toEqual({ kind: 'success', value: { status: 404, value: null } });
        expect(urls).toEqual(['https://fleet.example/cyclops/api/k8s/claims/owned']);
    });
    it('uses only the controller-bound origin, preserves HTTP status and keeps credentials out of outcomes', async () => {
        const requests: Parameters<HttpService['request']>[0][] = [];
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: { async run() { throw new Error('Not a CLI call'); } },
            fleet: { origin: 'https://fleet.example/', headers: { Authorization: 'Bearer private' }, http: {
                async request(request) {
                    requests.push(request);
                    return { status: 404, finalUrl: request.url, headers: {}, body: new TextEncoder().encode('{"kind":"Status","code":404}') };
                },
            } } });
        expect(await native.fleetJson({ method: 'GET', path: '/api/k8s/claims/owned' })).toEqual({ kind: 'success', value: { status: 404, value: { kind: 'Status', code: 404 } } });
        expect(requests[0]).toMatchObject({ url: 'https://fleet.example/api/k8s/claims/owned', method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer private' } });
        expect(await native.fleetJson({ method: 'GET', path: '//other.example/api' })).toMatchObject({ kind: 'unknown' });
        expect(requests).toHaveLength(1);
    });
    it('preserves no-content release success and cancellation, and treats unreadable or unauthorized transport as unknown', async () => {
        const responses = [204, 401];
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: { async run() { throw new Error('Not a CLI call'); } },
            fleet: { origin: 'https://fleet.example', http: { async request(request) {
                const status = responses.shift()!;
                return { status, finalUrl: request.url, headers: {}, body: status === 204 ? new Uint8Array() : new TextEncoder().encode('private error') };
            } } } });
        expect(await native.fleetJson({ method: 'DELETE', path: '/api/claim' })).toEqual({ kind: 'success', value: { status: 204, value: null } });
        expect(await native.fleetJson({ method: 'GET', path: '/api/claim' })).toEqual({ kind: 'unknown', reason: 'response' });
        await expect(native.fleetJson({ method: 'POST', path: '/api/claim' }, AbortSignal.abort())).rejects.toThrow();
    });
});
