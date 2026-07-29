import { describe, expect, it } from 'vitest';

import {
    createPeerLoopbackEndpointFingerprint,
    createPeerLoopbackRouteCandidate,
    normalizePeerLoopbackEndpointUrl,
} from './loopbackEndpoint';

describe('loopbackEndpoint', () => {
    it('normalizes only local HTTP and WebSocket endpoint URLs for the probe path', () => {
        expect(normalizePeerLoopbackEndpointUrl('HTTP://LOCALHOST:3456/peer-mediation/v1/probe')).toBe(
            'http://localhost:3456/peer-mediation/v1/probe',
        );
        expect(normalizePeerLoopbackEndpointUrl('ws://[::1]:3456/peer-mediation/v1/probe')).toBe(
            'ws://[::1]:3456/peer-mediation/v1/probe',
        );

        for (const url of [
            'http://0.0.0.0:3456/peer-mediation/v1/probe',
            'http://192.168.1.10:3456/peer-mediation/v1/probe',
            'http://daemon.localhost:3456/peer-mediation/v1/probe',
            'https://127.0.0.1:3456/peer-mediation/v1/probe',
            'http://user:pass@127.0.0.1:3456/peer-mediation/v1/probe',
            'http://127.0.0.1:3456/peer-mediation/v1/probe?grant=secret',
            'http://127.0.0.1:3456/peer-mediation/v1/probe#secret',
            'http://127.0.0.1:3456/not-peer-mediation',
        ]) {
            expect(normalizePeerLoopbackEndpointUrl(url)).toBeNull();
        }
    });

    it('fingerprints normalized URL, route kind, and daemon runtime id without accepting raw secrets', () => {
        const base = createPeerLoopbackEndpointFingerprint({
            url: 'http://127.0.0.1:3456/peer-mediation/v1/probe',
            routeKind: 'loopback_direct',
            daemonRuntimeId: 'daemon-a',
        });
        const same = createPeerLoopbackEndpointFingerprint({
            url: 'HTTP://127.0.0.1:3456/peer-mediation/v1/probe',
            routeKind: 'loopback_direct',
            daemonRuntimeId: 'daemon-a',
        });
        const changed = createPeerLoopbackEndpointFingerprint({
            url: 'http://127.0.0.1:3456/peer-mediation/v1/probe',
            routeKind: 'loopback_direct',
            daemonRuntimeId: 'daemon-b',
        });

        expect(base).toBe(same);
        expect(base).not.toBe(changed);
        expect(base).toMatch(/^loopback_/);
    });

    it('creates a loopback route candidate with an endpoint fingerprint', () => {
        const candidate = createPeerLoopbackRouteCandidate({
            url: 'http://127.0.0.1:3456/peer-mediation/v1/probe',
            expiresAt: 10_000,
            daemonRuntimeId: 'daemon-a',
        });

        expect(candidate).toMatchObject({
            routeKind: 'loopback_direct',
            enabled: true,
            endpoint: {
                transport: 'http',
                mechanism: 'loopback_http',
                url: 'http://127.0.0.1:3456/peer-mediation/v1/probe',
            },
        });
        expect(candidate.endpoint?.endpointFingerprint).toMatch(/^loopback_/);
    });

    it('rejects a URL-only loopback fingerprint without a fresh daemon runtime id', () => {
        // @ts-expect-error The public contract requires a fresh runtime id; keep a runtime guard for untyped callers.
        expect(() => createPeerLoopbackRouteCandidate({
            url: 'http://127.0.0.1:3456/peer-mediation/v1/probe',
            expiresAt: 10_000,
        })).toThrow(/runtime id/i);
        expect(() => createPeerLoopbackEndpointFingerprint({
            url: 'http://127.0.0.1:3456/peer-mediation/v1/probe',
            routeKind: 'loopback_direct',
            daemonRuntimeId: '   ',
        })).toThrow(/runtime id/i);
    });
});
