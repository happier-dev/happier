import { afterEach, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { PluginError } from '@happier-dev/plugin-sdk';
import { plugin } from './manifest.js';

const kits: Awaited<ReturnType<typeof createPluginTestkit>>[] = [];
afterEach(async () => { await Promise.all(kits.splice(0).map(kit => kit.dispose())); });
async function invoke(input: unknown, services: PluginTestServicesFixture) {
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    kits.push(kit);
    return kit.invokeAction('http/request', input, { surface: 'agent', services });
}
const destination = 'https://hooks.example.test/deployed';

it('executes the agent Action with Saved Secret headers and retains typed response facts', async () => {
    const requests: unknown[] = [];
    const reads: unknown[] = [];
    const unused = async (): Promise<never> => { throw new Error('Unexpected secret operation'); };
    const services = {
        secrets: { get: unused, set: unused, delete: unused, status: unused, saveShared: unused,
            async readSavedSecret(ref, options) { reads.push({ ref, revision: options?.resourceRevision }); return 'Bearer private-token'; } },
        http: createPluginHttpFixture({ async request(input, options) {
            expect(options?.signal).toBeInstanceOf(AbortSignal);
            requests.push(input);
            return { status: 201, headers: {}, body: new TextEncoder().encode('accepted 心拍') };
        } }),
    } satisfies PluginTestServicesFixture;
    const result = await invoke({ destination, method: 'POST', body: '{"deployed":true}',
        headers: [{ name: 'Authorization', secret: { ref: 'happier:shared-secret:v1:deploy-token', resourceRevision: 3 } }] }, services);
    expect(result).toEqual({ statusCode: 201, bodyExcerpt: 'accepted 心拍', durationMs: expect.any(Number) });
    expect(reads).toEqual([{ ref: 'happier:shared-secret:v1:deploy-token', revision: 3 }]);
    expect(requests).toEqual([{ url: destination, method: 'POST', redirect: 'manual',
        headers: { Authorization: 'Bearer private-token' }, body: new TextEncoder().encode('{"deployed":true}') }]);
    expect(JSON.stringify(result)).not.toContain('private-token');
});

it.each([199, 302, 503])('settles HTTP %s as a typed failure retaining response facts', async status => {
    await expect(invoke({ destination, method: 'GET' }, {
        http: createPluginHttpFixture({ async request() {
            return { status, headers: {}, body: new TextEncoder().encode('upstream refused') };
        } }),
    })).rejects.toMatchObject({ code: 'http_response_failed', retryable: false,
        details: { statusCode: status, bodyExcerpt: 'upstream refused', durationMs: expect.any(Number) } });
});

it('preserves the HTTP owner failure without retrying', async () => {
    let sends = 0;
    await expect(invoke({ destination, method: 'PUT', body: 'payload' }, {
        http: createPluginHttpFixture({ async request() {
            sends++;
            throw new PluginError({ code: 'plugin_fetch_response_too_large', message: 'Response exceeded the HTTP owner limit' });
        } }),
    })).rejects.toMatchObject({ code: 'plugin_fetch_response_too_large' });
    expect(sends).toBe(1);
});

it('does not send when Saved Secret acquisition is refused', async () => {
    let sends = 0;
    const unused = async (): Promise<never> => { throw new Error('Unexpected secret operation'); };
    await expect(invoke({ destination, method: 'POST',
        headers: [{ name: 'X-Api-Key', secret: { ref: 'happier:shared-secret:v1:denied', resourceRevision: 1 } }] }, {
        secrets: { get: unused, set: unused, delete: unused, status: unused, saveShared: unused,
            async readSavedSecret() { throw new PluginError({ code: 'secret_access_denied', message: 'Saved Secret unavailable' }); } },
        http: createPluginHttpFixture({ async request() { sends++; return { status: 200, headers: {}, body: new Uint8Array() }; } }),
    })).rejects.toMatchObject({ code: 'secret_access_denied' });
    expect(sends).toBe(0);
});
