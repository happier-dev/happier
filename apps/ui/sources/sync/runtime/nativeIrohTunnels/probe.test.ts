import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeIrohHomeTunnelOrigin } from './probe';
import type { IrohHomeTunnelRequest } from './types';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const HOME_IDENTITY = 'srv_home_probe_a';

function createRequest(overrides: Partial<IrohHomeTunnelRequest> = {}): IrohHomeTunnelRequest {
    return {
        remoteHostId: 'profile-a',
        purpose: 'home',
        homeServerIdentityId: HOME_IDENTITY,
        endpointId: 'endpoint-a',
        canonicalServerUrl: 'https://probe-home.example.test',
        policy: 'automatic',
        verification: { kind: 'authenticated', token: 'token-a' },
        ...overrides,
    };
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function homeFeatures(serverIdentityId = HOME_IDENTITY): Response {
    return jsonResponse(200, { features: {}, capabilities: { serverIdentity: { serverIdentityId } } });
}

describe('Iroh Home tunnel origin probe', () => {
    afterEach(() => {
        resetRuntimeFetch();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each(['foreground', 'hidden desktop restore'])('proves the Home identity before the token reaches the lease origin during %s', async (context) => {
        if (context === 'hidden desktop restore') {
            vi.stubGlobal('document', { visibilityState: 'hidden' });
            vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn() });
        }
        const origin = context === 'hidden desktop restore' ? 'https://probe-home.example.test' : 'http://127.0.0.1:45701';
        const requests: Array<{ url: string; authorization: string | null }> = [];
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            const authorization = new Headers(init?.headers).get('Authorization');
            requests.push({ url, authorization });
            if (url === `${origin}/v1/auth/ping`) return jsonResponse(200, { ok: true });
            // The features proof must be carried by the lease's exact runtime origin.
            if (url === `${origin}/v1/features`) return homeFeatures();
            throw new Error(`unexpected probe request ${url}`);
        });

        await expect(probeIrohHomeTunnelOrigin(origin, createRequest())).resolves.toEqual({ ok: true });

        expect(requests).toEqual([
            { url: `${origin}/v1/features`, authorization: null },
            { url: `${origin}/v1/auth/ping`, authorization: 'Bearer token-a' },
        ]);
    });

    it('verifies a pre-token enrollment origin with Home identity and health but no authenticated ping', async () => {
        const requests: string[] = [];
        setRuntimeFetch(async (input) => {
            const url = String(input);
            requests.push(url);
            if (url === 'http://127.0.0.1:45707/health') return jsonResponse(200, { ok: true });
            if (url === 'http://127.0.0.1:45707/v1/features') return homeFeatures();
            throw new Error(`unexpected probe request ${url}`);
        });

        await expect(probeIrohHomeTunnelOrigin(
            'http://127.0.0.1:45707',
            createRequest({ verification: { kind: 'enrollment' } }),
        )).resolves.toEqual({ ok: true });

        expect(requests).toEqual([
            'http://127.0.0.1:45707/v1/features',
            'http://127.0.0.1:45707/health',
        ]);
    });

    it('fails closed without any request when an authenticated token or expected identity is missing', async () => {
        const runtimeFetch = vi.fn(async () => jsonResponse(200, {}));
        setRuntimeFetch(runtimeFetch);

        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45702', createRequest({
            verification: { kind: 'authenticated', token: '   ' },
        })))
            .resolves.toEqual({ ok: false, reason: 'auth-failed' });
        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45702', createRequest({ homeServerIdentityId: '  ' })))
            .resolves.toEqual({ ok: false, reason: 'auth-failed' });

        expect(runtimeFetch).not.toHaveBeenCalled();
    });

    it('maps a rejected authenticated ping for the proven Home to an auth failure', async () => {
        setRuntimeFetch(async (input) => {
            const url = String(input);
            if (url.endsWith('/v1/features')) return homeFeatures();
            if (url.endsWith('/v1/auth/ping')) return jsonResponse(401, { error: 'expired' });
            throw new Error(`unexpected probe request ${url}`);
        });

        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45703', createRequest()))
            .resolves.toEqual({ ok: false, reason: 'auth-failed' });
    });

    it('maps an overloaded readiness endpoint on the proven Home to a health failure', async () => {
        setRuntimeFetch(async (input) => String(input).endsWith('/v1/features')
            ? homeFeatures()
            : jsonResponse(503, { error: 'overloaded' }));

        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45704', createRequest()))
            .resolves.toEqual({ ok: false, reason: 'health-unavailable' });
    });

    it.each([
        ['reports another Home', () => homeFeatures('srv_home_other'), 'identity-mismatch'],
        ['cannot prove a Home at all', () => jsonResponse(500, {}), 'features-unavailable'],
    ] as const)('sends no credential to an origin that %s', async (_name, features, reason) => {
        const authorized: string[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            if (new Headers(init?.headers).has('Authorization')) authorized.push(url);
            return url.endsWith('/v1/features') ? features() : jsonResponse(200, { ok: true });
        });

        await expect(probeIrohHomeTunnelOrigin('http://127.0.0.1:45705', createRequest()))
            .resolves.toEqual({ ok: false, reason });
        expect(authorized).toEqual([]);
    });
});
