import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountPortableAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { posthogPortableAccountRuntime, POSTHOG_ACCOUNT_DIAGNOSTIC_CODES } from './account.js';
import { POSTHOG_API_ORIGIN_FIELD_ID, POSTHOG_CONNECTED_ACCOUNT_PURPOSE, POSTHOG_PERSONAL_API_KEY_FIELD_ID, POSTHOG_PERSONAL_API_KEY_MODE_ID } from '../posthogContracts.js';

describe('PostHog manual confirmation over HTTP', () => {
    let status = 200;
    let disconnect = false;
    let body: unknown;
    const received: string[] = [];
    const server = createServer((request, response) => {
        received.push(request.url ?? '');
        if (disconnect) { request.socket.destroy(); return; }
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
    });
    let fixtureOrigin: string;

    beforeAll(async () => {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected a local HTTP listener');
        fixtureOrigin = `http://127.0.0.1:${address.port}`;
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    beforeEach(() => {
        status = 200;
        disconnect = false;
        received.length = 0;
        body = { count: 1, results: [{ id: '00000000-0000-4000-8000-0000000000b1', name: 'Example organization', slug: 'example-organization' }], next: null, previous: null };
    });

    function fixture(origin = 'https://eu.posthog.com') {
        const controller = new AbortController();
        const staged = new Map<string, string>();
        const destinations: string[] = [];
        const context = {
            plugin: { id: 'happier.posthog', version: '0.0.0' },
            contribution: { id: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, qualifiedId: `happier.posthog/${POSTHOG_CONNECTED_ACCOUNT_PURPOSE}` },
            surface: 'ui', invokedAtMs: 1, signal: controller.signal,
            service: { pluginId: 'happier.posthog', localId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE },
            attempt: { kind: 'connect', attemptId: 'posthog-confirmation-fixture' },
            configuration: {
                target: { kind: 'service', service: { pluginId: 'happier.posthog', localId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE }, modeId: POSTHOG_PERSONAL_API_KEY_MODE_ID },
                revision: '1', values: { [POSTHOG_API_ORIGIN_FIELD_ID]: origin }, async getSecret() { return null; },
            },
            attemptCredentials: {
                async get(key: string) { return staged.get(key) ?? null; },
                async set(key: string, value: string) { staged.set(key, value); },
                async delete(key: string) { staged.delete(key); },
            },
            services: { http: createPluginHttpFixture({ async request(input, options) {
                destinations.push(input.url);
                // Only the network boundary is substituted: preserve the exact configured
                // destination and send its request path through a real local HTTP server.
                const destination = new URL(input.url);
                const response = await fetch(`${fixtureOrigin}${destination.pathname}${destination.search}`, {
                    method: input.method, headers: input.headers, redirect: input.redirect, signal: options?.signal,
                });
                return { status: response.status, headers: {}, body: new Uint8Array(await response.arrayBuffer()) };
            } }) },
        } satisfies ConnectedAccountPortableAuthenticationContext;
        const mode = posthogPortableAccountRuntime.authentication.modes[POSTHOG_PERSONAL_API_KEY_MODE_ID];
        if (mode.kind !== 'manual') throw new Error('Expected the manual PostHog mode');
        return { controller, staged, destinations,
            submit: () => mode.complete({ fields: { [POSTHOG_PERSONAL_API_KEY_FIELD_ID]: 'qa-posthog-synthetic' } }, context),
        };
    }

    it.each([401, 403])('classifies HTTP %s as credential refusal without staging', async code => {
        status = code;
        body = { detail: 'Synthetic credential refused' };
        const f = fixture();
        expect(await f.submit()).toMatchObject({ status: 'rejected', diagnostic: { code: POSTHOG_ACCOUNT_DIAGNOSTIC_CODES.credentialRejected } });
        expect(f.staged.size).toBe(0);
        expect(received).toEqual(['/api/organizations/?limit=1']);
    });

    it.each(['https://eu.posthog.com', 'https://us.posthog.com'])('confirms once against the explicitly configured %s deployment', async origin => {
        const f = fixture(origin);
        expect(await f.submit()).toMatchObject({ status: 'connected', displayName: new URL(origin).host });
        expect(f.staged.get(POSTHOG_PERSONAL_API_KEY_FIELD_ID)).toBe('qa-posthog-synthetic');
        expect(f.destinations).toEqual([`${origin}/api/organizations/?limit=1`]);
        expect(received).toEqual(['/api/organizations/?limit=1']);
    });

    it('keeps a transport failure distinct from a credential refusal', async () => {
        disconnect = true;
        const f = fixture();
        expect(await f.submit()).toMatchObject({ status: 'unavailable', diagnostic: { code: POSTHOG_ACCOUNT_DIAGNOSTIC_CODES.verificationUnavailable } });
        expect(f.staged.size).toBe(0);
        expect(f.destinations).toHaveLength(1);
    });

    it('does not call an unavailable provider an invalid credential', async () => {
        status = 503;
        const f = fixture();
        expect(await f.submit()).toMatchObject({ status: 'unavailable', diagnostic: { code: POSTHOG_ACCOUNT_DIAGNOSTIC_CODES.verificationUnavailable } });
        expect(f.staged.size).toBe(0);
    });

    it('propagates cancellation without staging or sending a request', async () => {
        const f = fixture();
        f.controller.abort();
        await expect(f.submit()).rejects.toMatchObject({ name: 'AbortError' });
        expect(f.staged.size).toBe(0);
        expect(received).toHaveLength(0);
    });
});
