import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBoundedInvocation } from '@happier-dev/triage-sources/runtime';

import { normalizePosthogApiOrigin, type PosthogApiOrigin } from '../connect/origin.js';
import {
    createPosthogApiClient,
    type PosthogMaterializationOutcome,
    type PosthogTransportRequest,
} from './client.js';

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);

function requireOrigin(raw: string): PosthogApiOrigin {
    const resolved = normalizePosthogApiOrigin(raw);
    if (!resolved.ok) {
        throw new Error(`fixture origin must normalize: ${raw}`);
    }
    return resolved.origin;
}

const ORIGIN = requireOrigin('https://eu.posthog.com');

type Recorded = Readonly<{ url: string; request: PosthogTransportRequest }>;

function jsonResponse(
    body: unknown,
    init?: Readonly<{ status?: number; headers?: Readonly<Record<string, string>> }>,
): Response {
    return new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

function readObject(body: unknown): Readonly<Record<string, unknown>> | null {
    return typeof body === 'object' && body !== null && !Array.isArray(body)
        ? body as Readonly<Record<string, unknown>>
        : null;
}

function setup(options?: Readonly<{
    respond?: (call: number) => Promise<Response>;
    materialize?: () => Promise<PosthogMaterializationOutcome>;
}>) {
    const calls: Recorded[] = [];
    const materializeCalls: { origin: string; signal: AbortSignal }[] = [];
    const client = createPosthogApiClient({
        origin: ORIGIN,
        now: () => NOW,
        // The materializer settles its own outcome: which header name is asked for,
        // and whether a withdrawn call is a cancellation or a refused account, belong
        // to `@happier-dev/triage-sources`, not to this client.
        materializeHeaders: async (request, transportOptions) => {
            materializeCalls.push({ origin: request.origin, signal: transportOptions.signal });
            transportOptions.signal.throwIfAborted();
            if (options?.materialize !== undefined) {
                return await options.materialize();
            }
            return { ok: true, authorization: 'Bearer test-personal-api-key' };
        },
        transport: async (url, request) => {
            calls.push({ url, request });
            const respond = options?.respond;
            if (respond === undefined) {
                return jsonResponse({ ok: true });
            }
            return await respond(calls.length);
        },
    });
    return { client, calls, materializeCalls };
}

describe('createPosthogApiClient request construction', () => {
    it('targets the materialized origin and attaches only the authorization header', async () => {
        const { client, calls, materializeCalls } = setup();

        const result = await client.requestJson({
            method: 'POST',
            path: '/api/projects/7/error_tracking/query/issues/',
            body: { limit: 100 },
        }, readObject, {});

        expect(result).toEqual({ ok: true, value: { ok: true } });
        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call?.url).toBe('https://eu.posthog.com/api/projects/7/error_tracking/query/issues/');
        expect(call?.request.method).toBe('POST');
        expect(call?.request.headers).toEqual({
            authorization: 'Bearer test-personal-api-key',
            accept: 'application/json',
            'content-type': 'application/json',
        });
        expect(call?.request.body).toBe(JSON.stringify({ limit: 100 }));
        expect(materializeCalls).toEqual([{
            origin: 'https://eu.posthog.com',
            signal: expect.any(AbortSignal),
        }]);
    });

    it('never follows a redirect, because a followed 3xx would read a different resource', async () => {
        const { client, calls } = setup({
            respond: async () => new Response(null, {
                status: 308,
                headers: { location: 'https://eu.posthog.com/api/projects/7/error_tracking/issues/other/' },
            }),
        });

        const result = await client.requestJson({
            method: 'GET',
            path: '/api/projects/7/error_tracking/issues/1111/',
        }, readObject, {});

        expect(result).toEqual({ ok: false, failure: { kind: 'redirected', status: 308 } });
        expect(calls[0]?.request.redirect).toBe('manual');
        expect(calls).toHaveLength(1);
    });

    it('appends only the query parameters it was given', async () => {
        const { client, calls } = setup();

        await client.requestJson({
            method: 'GET',
            path: '/api/organizations/',
            query: { limit: '100', offset: '0' },
        }, readObject, {});

        expect(calls[0]?.url).toBe('https://eu.posthog.com/api/organizations/?limit=100&offset=0');
    });
});

describe('createPosthogApiClient throttle classification', () => {
    it('returns one typed rate-limit failure with the provider deadline and does not retry', async () => {
        const { client, calls } = setup({
            respond: async () => jsonResponse({ detail: 'throttled' }, {
                status: 429,
                headers: { 'retry-after': '37' },
            }),
        });

        const result = await client.requestJson({
            method: 'POST',
            path: '/api/projects/7/error_tracking/query/issues/',
            body: {},
        }, readObject, {});

        expect(result).toEqual({
            ok: false,
            failure: { kind: 'rateLimited', status: 429, retryNotBeforeMs: NOW + 37_000 },
        });
        expect(calls).toHaveLength(1);
    });

    it('omits the retry deadline entirely when the provider supplied no valid evidence', async () => {
        const { client, calls } = setup({
            respond: async () => jsonResponse({}, { status: 429, headers: { 'retry-after': 'shortly' } }),
        });

        const result = await client.requestJson({
            method: 'POST',
            path: '/api/projects/7/error_tracking/query/issues/',
            body: {},
        }, readObject, {});

        expect(result).toEqual({ ok: false, failure: { kind: 'rateLimited', status: 429 } });
        expect(calls).toHaveLength(1);
    });

    it('does not retry a server failure either', async () => {
        const { client, calls } = setup({ respond: async () => jsonResponse({}, { status: 503 }) });

        const result = await client.requestJson({
            method: 'GET',
            path: '/api/organizations/',
        }, readObject, {});

        expect(result).toEqual({ ok: false, failure: { kind: 'server', status: 503 } });
        expect(calls).toHaveLength(1);
    });
});

describe('createPosthogApiClient owner-provided cancellation', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('layers no timer over an aggregate-driven read and resolves as cancelled on caller abort', async () => {
        const { client, calls, materializeCalls } = setup({
            respond: async () => await new Promise<Response>(() => {
                // never settles
            }),
        });
        const controller = new AbortController();
        const pending = client.requestJson({
            method: 'POST',
            path: '/api/projects/7/error_tracking/query/issues/',
            body: {},
        }, readObject, { signal: controller.signal });

        await vi.advanceTimersByTimeAsync(600_000);
        expect(calls[0]?.request.signal).toBe(controller.signal);
        expect(materializeCalls[0]?.signal).toBe(controller.signal);
        controller.abort();

        await expect(pending).resolves.toEqual({ ok: false, failure: { kind: 'cancelled' } });
    });

    it('uses the source invocation deadline signal without allocating a request timer', async () => {
        const { client } = setup({
            respond: async () => await new Promise<Response>(() => {
                // never settles
            }),
        });

        const invocation = createBoundedInvocation({ timeoutMs: 5_000 });
        const pending = client.requestJson({
            method: 'GET',
            path: '/api/organizations/',
        }, readObject, { signal: invocation.signal });

        await vi.advanceTimersByTimeAsync(5_000);

        await expect(pending).resolves.toEqual({ ok: false, failure: { kind: 'timeout' } });
        invocation.dispose();
    });

    it('keeps caller cancellation distinct from the source invocation deadline', async () => {
        const { client } = setup({
            respond: async () => await new Promise<Response>(() => {
                // never settles
            }),
        });
        const controller = new AbortController();
        const invocation = createBoundedInvocation({
            callerSignal: controller.signal,
            timeoutMs: 30_000,
        });

        const pending = client.requestJson({
            method: 'GET',
            path: '/api/organizations/',
        }, readObject, { signal: invocation.signal });

        await vi.advanceTimersByTimeAsync(1_000);
        controller.abort();

        await expect(pending).resolves.toEqual({ ok: false, failure: { kind: 'cancelled' } });
        invocation.dispose();
    });

    it('makes a late transport resolve after the deadline inert', async () => {
        let settle: ((response: Response) => void) | undefined;
        const { client } = setup({
            respond: async () => await new Promise<Response>((resolve) => {
                settle = resolve;
            }),
        });

        const invocation = createBoundedInvocation({ timeoutMs: 1_000 });
        const pending = client.requestJson({
            method: 'GET',
            path: '/api/organizations/',
        }, readObject, { signal: invocation.signal });

        await vi.advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toEqual({ ok: false, failure: { kind: 'timeout' } });

        settle?.(jsonResponse({ late: true }));
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toEqual({ ok: false, failure: { kind: 'timeout' } });
        invocation.dispose();
    });

    it('makes a late transport rejection after cancellation inert', async () => {
        let fail: ((error: unknown) => void) | undefined;
        const { client } = setup({
            respond: async () => await new Promise<Response>((_resolve, reject) => {
                fail = reject;
            }),
        });
        const controller = new AbortController();

        const pending = client.requestJson({
            method: 'GET',
            path: '/api/organizations/',
        }, readObject, { signal: controller.signal });

        controller.abort();
        await expect(pending).resolves.toEqual({ ok: false, failure: { kind: 'cancelled' } });

        fail?.(new Error('late transport failure'));
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toEqual({ ok: false, failure: { kind: 'cancelled' } });
    });

    it('returns cancelled without materializing a credential when already aborted', async () => {
        const { client, calls, materializeCalls } = setup();
        const controller = new AbortController();
        controller.abort();

        await expect(client.requestJson({
            method: 'GET',
            path: '/api/organizations/',
        }, readObject, { signal: controller.signal })).resolves.toEqual({
            ok: false,
            failure: { kind: 'cancelled' },
        });
        expect(calls).toHaveLength(0);
        expect(materializeCalls).toHaveLength(0);
    });
});

describe('createPosthogApiClient follow-up URL handling', () => {
    it('follows a provider next URL on the exact materialized origin', async () => {
        const { client, calls } = setup();

        const result = await client.followJson(
            'https://eu.posthog.com/api/organizations/?limit=100&offset=100',
            readObject,
            {},
        );

        expect(result).toEqual({ ok: true, value: { ok: true } });
        expect(calls[0]?.url).toBe('https://eu.posthog.com/api/organizations/?limit=100&offset=100');
    });

    it('refuses a cross-origin next URL and never materializes a credential for it', async () => {
        const { client, calls, materializeCalls } = setup();

        const result = await client.followJson(
            'https://attacker.example/api/organizations/',
            readObject,
            {},
        );

        expect(result).toEqual({ ok: false, failure: { kind: 'originMismatch' } });
        expect(calls).toHaveLength(0);
        expect(materializeCalls).toHaveLength(0);
    });

    it('refuses a relative or malformed next URL', async () => {
        const { client } = setup();

        await expect(client.followJson('/api/organizations/?offset=100', readObject, {}))
            .resolves.toEqual({ ok: false, failure: { kind: 'originMismatch' } });
        await expect(client.followJson('nonsense', readObject, {}))
            .resolves.toEqual({ ok: false, failure: { kind: 'originMismatch' } });
    });
});

describe('createPosthogApiClient response parsing boundary', () => {
    it('maps a non-JSON body to a typed malformed response', async () => {
        const { client } = setup({
            respond: async () => new Response('<html>maintenance</html>', {
                status: 200,
                headers: { 'content-type': 'text/html' },
            }),
        });

        await expect(client.requestJson({ method: 'GET', path: '/api/organizations/' }, readObject, {}))
            .resolves.toEqual({ ok: false, failure: { kind: 'malformedResponse', at: 'body' } });
    });

    it('maps a rejected strict parse to a typed malformed response', async () => {
        const { client } = setup({ respond: async () => jsonResponse([1, 2, 3]) });

        await expect(client.requestJson({ method: 'GET', path: '/api/organizations/' }, readObject, {}))
            .resolves.toEqual({ ok: false, failure: { kind: 'malformedResponse', at: 'schema' } });
    });

    it('maps a transport rejection to a typed transport failure without provider text', async () => {
        const { client } = setup({
            respond: async () => {
                throw new Error('ECONNRESET while talking to eu.posthog.com');
            },
        });

        await expect(client.requestJson({ method: 'GET', path: '/api/organizations/' }, readObject, {}))
            .resolves.toEqual({ ok: false, failure: { kind: 'transport' } });
    });

    it('maps a credential materialization failure to a typed unauthorized failure', async () => {
        const { client, calls } = setup({
            materialize: async () => {
                throw new Error('connected account unavailable');
            },
        });

        await expect(client.requestJson({ method: 'GET', path: '/api/organizations/' }, readObject, {}))
            .resolves.toEqual({ ok: false, failure: { kind: 'unauthorized', status: 0 } });
        expect(calls).toHaveLength(0);
    });

    it('returns the materializer\u2019s own settled failure and sends nothing', async () => {
        // Deciding that a materialization carries no usable `authorization` is the
        // shared owner's rule; what this client owes is to send no request once that
        // owner has refused, rather than calling the provider anonymously.
        const { client, calls } = setup({
            materialize: async () => ({ ok: false, failure: { kind: 'unauthorized', status: 0 } }),
        });

        await expect(client.requestJson({ method: 'GET', path: '/api/organizations/' }, readObject, {}))
            .resolves.toEqual({ ok: false, failure: { kind: 'unauthorized', status: 0 } });
        expect(calls).toHaveLength(0);
    });
});
