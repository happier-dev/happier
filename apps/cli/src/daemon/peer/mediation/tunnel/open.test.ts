import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
    createPeerRouteNonceSigningInputV1,
    createDirectRouteGrantSigningInputV1,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    type DirectRouteGrantPayloadV1,
    type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol';

type OpenModule = typeof import('./open');

async function loadOpenModule(): Promise<OpenModule | null> {
    const modulePath = './open.js';
    return import(modulePath).catch(() => null) as Promise<OpenModule | null>;
}

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}

const signingSeed = new Uint8Array(32).fill(7);
const signingKeyPair = tweetnacl.sign.keyPair.fromSeed(signingSeed);
const accountSeed = new Uint8Array(32).fill(9);
const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(accountSeed);

function createSignedTunnelGrant(overrides: Partial<DirectRouteGrantPayloadV1> = {}) {
    const payload: DirectRouteGrantPayloadV1 = {
        v: 1,
        grantId: 'grant_1',
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'tcp_tunnel',
        routeKind: 'loopback_direct',
        scope: {
            kind: 'tcp_tunnel',
            tunnelId: 'tun_1',
            allowedPorts: [3000],
            maxIdleMs: 30_000,
            maxDurationMs: 300_000,
            maxTotalBytes: 4096,
        },
        iat: 1_000,
        exp: 601_000,
        aud: 'happier-daemon-route-grant',
        endpointFingerprint: 'endpoint_1',
        ...overrides,
    };
    const signingInput = Buffer.from(createDirectRouteGrantSigningInputV1(payload), 'utf8');
    return {
        payload,
        signature: {
            keyId: 'key_1',
            alg: 'Ed25519' as const,
            valueBase64Url: toBase64Url(tweetnacl.sign.detached(signingInput, signingKeyPair.secretKey)),
        },
    };
}

function createOpen(overrides: Partial<PeerTcpTunnelOpenV1> = {}): PeerTcpTunnelOpenV1 {
    const nonceBase64Url = toBase64Url(new Uint8Array(32).fill(3));
    const nonceProof = {
        v: 1 as const,
        grantId: 'grant_1',
        routeKind: 'loopback_direct' as const,
        flowKind: 'tcp_tunnel' as const,
        endpointFingerprint: 'endpoint_1',
        nonceBase64Url,
        signatureBase64Url: toBase64Url(tweetnacl.sign.detached(
            Buffer.from(createPeerRouteNonceSigningInputV1({
                grantId: 'grant_1',
                routeKind: 'loopback_direct',
                flowKind: 'tcp_tunnel',
                endpointFingerprint: 'endpoint_1',
                nonceBase64Url,
            }), 'utf8'),
            accountKeyPair.secretKey,
        )),
    };

    return {
        v: 1,
        kind: 'open',
        tunnelId: 'tun_1',
        targetMachineId: 'machine_1',
        routeKind: 'loopback_direct',
        destination: { host: '127.0.0.1', port: 3000 },
        grant: createSignedTunnelGrant(),
        nonceProof,
        ...overrides,
    };
}

describe('openPeerTcpTunnel', () => {
    it('validates grant, scope, loopback destination, and returns the shared loopback stream path', async () => {
        const mod = await loadOpenModule();
        const connectTcp = vi.fn(async () => ({ close: vi.fn() }));
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        await expect(mod?.openPeerTcpTunnel({
            open: createOpen(),
            nowMs: 2_000,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
                accountPublicKey: toBase64Url(accountKeyPair.publicKey),
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            connectTcp,
        })).resolves.toMatchObject({
            ok: true,
            response: {
                streamPath: '/peer-mediation/v1/tunnel/stream',
                encoding: 'json_base64_v1',
            },
            receipt: 'peer.tunnel.opened',
        });

        expect(connectTcp).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3000 });
    });

    it('returns binary_frame_v2 in the open response when the loopback tunnel selected binary encoding', async () => {
        const mod = await loadOpenModule();
        const connectTcp = vi.fn(async () => ({ close: vi.fn() }));
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        await expect(mod?.openPeerTcpTunnel({
            open: createOpen({
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                supportedEncodings: ['json_base64_v1', PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
            }),
            nowMs: 2_000,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
                accountPublicKey: toBase64Url(accountKeyPair.publicKey),
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            connectTcp,
        })).resolves.toMatchObject({
            ok: true,
            response: {
                streamPath: '/peer-mediation/v1/tunnel/stream',
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
            receipt: 'peer.tunnel.opened',
        });
    });

    it('rejects disallowed destinations before opening a TCP connection', async () => {
        const mod = await loadOpenModule();
        const connectTcp = vi.fn(async () => ({ close: vi.fn() }));
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        await expect(mod?.openPeerTcpTunnel({
            open: createOpen({ destination: { host: '192.168.1.10', port: 3000 } }),
            nowMs: 2_000,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
                accountPublicKey: toBase64Url(accountKeyPair.publicKey),
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            connectTcp,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'destination_host_not_allowed',
            receipt: 'peer.route.fallback',
        });

        expect(connectTcp).not.toHaveBeenCalled();
    });

    it('normalizes bracketed IPv6 loopback before opening the TCP connection', async () => {
        const mod = await loadOpenModule();
        const connectTcp = vi.fn(async () => ({ close: vi.fn() }));
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        await expect(mod?.openPeerTcpTunnel({
            open: createOpen({ destination: { host: '[::1]', port: 3000 } }),
            nowMs: 2_000,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
                accountPublicKey: toBase64Url(accountKeyPair.publicKey),
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            connectTcp,
        })).resolves.toMatchObject({
            ok: true,
            receipt: 'peer.tunnel.opened',
        });

        expect(connectTcp).toHaveBeenCalledWith({ host: '::1', port: 3000 });
    });
});
