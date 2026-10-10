import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';

import {
    createPeerRouteNonceSigningInputV1,
    createDirectRouteGrantSigningInputV1,
    createDirectRouteGrantSigningInputV2,
    createEphemeralPeerRouteProofHandleV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    type DirectRouteGrantPayloadV1,
    type DirectRouteGrantPayloadV2,
    type PeerTcpTunnelOpenV1,
    type PeerTcpTunnelOpenV2,
} from '@happier-dev/protocol';
import { createAtomicRouteGrantConsumption } from './grantConsumption';
import { createLocalServicePreviewRegistry, registerLocalServicePreview } from '../../../local/services/preview/registry';
import { createLocalServicePreviewRoutes } from '../../../local/services/preview/routes';
import { localServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { LocalServicePreviewNativeRegistrationRequestV1Schema } from '@happier-dev/protocol/local/services/preview/nativeDirect';

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

function createLegacyOpen(overrides: Partial<PeerTcpTunnelOpenV1> = {}): PeerTcpTunnelOpenV1 {
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

function createOpen(overrides: Partial<PeerTcpTunnelOpenV2> = {}): PeerTcpTunnelOpenV2 {
    const handle = createEphemeralPeerRouteProofHandleV2({ randomBytes: (length) => new Uint8Array(length).fill(9) });
    const payload: DirectRouteGrantPayloadV2 = {
        v: 2, grantId: 'grant_1', accountId: 'account_1', machineId: 'machine_1',
        flowKind: 'tcp_tunnel', routeKind: 'loopback_direct',
        scope: { kind: 'tcp_tunnel', tunnelId: 'tun_1', allowedPorts: [3000] },
        iat: 1_000, exp: 601_000, aud: 'happier-daemon-route-grant', endpointFingerprint: 'endpoint_1',
        proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url,
    };
    const grant = {
        payload,
        signature: {
            keyId: 'key_1', alg: 'Ed25519' as const,
            valueBase64Url: toBase64Url(tweetnacl.sign.detached(
                Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'), signingKeyPair.secretKey,
            )),
        },
    };
    try {
        return {
            v: 2, kind: 'open', tunnelId: 'tun_1', targetMachineId: 'machine_1', routeKind: 'loopback_direct',
            destination: { host: '127.0.0.1', port: 3000 }, grant, proof: handle.sign(grant), ...overrides,
        };
    } finally {
        handle.dispose();
    }
}

describe('openPeerTcpTunnel', () => {
    it('admits a signed sessionless iroh viewer only with its exact current native control lease', async () => {
        const mod = await loadOpenModule();
        if (!mod) throw new Error('open owner unavailable');
        const registry = createLocalServicePreviewRegistry();
        const registered = registerLocalServicePreview(registry, {
            previewId: 'project-preview', machineId: 'machine_1', owner: { kind: 'user', id: 'starter' },
            serviceTarget: { kind: 'managed_service', managedServiceId: 'actual-instance', machineId: 'machine_1', cwd: '/workspace/app',
                declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest', name: 'web' } } },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'Web', addressLabel: 'localhost:5173' }, originMode: 'host',
        });
        if (!registered.ok) throw new Error(registered.reasonCode);
        const binding = localServicePreviewDirectBindingV1(registered.resource);
        const control = new PassThrough();
        let currentGrant = true;
        const routes = createLocalServicePreviewRoutes({
            machineId: 'machine_1', accountId: 'custodian', registry,
            // The Home HTTP control lease is the genuine network boundary. Local binding,
            // native adapter lifetime, signatures and tunnel admission remain real.
            server: { token: 'custodian-token', serverBaseUrl: 'https://home.example.test', http: {
                async post(_url, body) {
                    const request = LocalServicePreviewNativeRegistrationRequestV1Schema.parse(body);
                    expect(request).toEqual({ ...binding, grantId: 'viewer-grant' });
                    if (!currentGrant) throw new Error('native grant retired');
                    queueMicrotask(() => control.write(`${JSON.stringify({ v: 1, kind: 'preview_registration_admitted', previewId: binding.previewId })}\n`));
                    return { data: control };
                },
                async delete() { return { data: { ok: true } }; },
            } },
        });
        const handle = createEphemeralPeerRouteProofHandleV2({ randomBytes: (length) => new Uint8Array(length).fill(5) });
        const payload: DirectRouteGrantPayloadV2 = {
            v: 2, grantId: 'viewer-grant', accountId: 'shared-viewer', machineId: 'machine_1',
            flowKind: 'tcp_tunnel', routeKind: 'iroh_peer',
            scope: { kind: 'tcp_tunnel', tunnelId: 'viewer-tunnel', allowedPorts: [5173], preview: binding },
            iat: 1_000, exp: null, aud: 'happier-daemon-route-grant', endpointFingerprint: 'b'.repeat(64),
            iroh: { initiator: { kind: 'account_client', endpointId: 'a'.repeat(64) }, target: { machineId: 'machine_1', endpointId: 'b'.repeat(64) }, operationKind: 'tcp_tunnel' },
            proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url,
        };
        const grant = { payload, signature: { keyId: 'key_1', alg: 'Ed25519' as const,
            valueBase64Url: toBase64Url(tweetnacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)), signingKeyPair.secretKey)) } };
        const input = {
            open: { v: 2, kind: 'open', tunnelId: 'viewer-tunnel', targetMachineId: 'machine_1', routeKind: 'iroh_peer',
                destination: { host: '127.0.0.1', port: 5173 }, grant, proof: handle.sign(grant) },
            nowMs: 2_000, expected: { accountId: 'custodian', machineId: 'machine_1', endpointFingerprint: 'endpoint_1', irohEndpointId: 'b'.repeat(64) },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            acquirePreviewApplication: routes.acquireNativeApplication,
        };
        const consumption = () => createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' });
        let admitted: Awaited<ReturnType<OpenModule['openPeerTcpTunnel']>> | undefined;
        try {
            admitted = await mod.openPeerTcpTunnel({ ...input, grantConsumption: consumption() });
            expect(admitted).toMatchObject({ ok: true, routeKind: 'iroh_peer' });
            if (!admitted.ok || !admitted.previewApplication) throw new Error('native application missing');
            const retired = once(admitted.previewApplication.signal, 'abort');
            control.end();
            await retired;
            expect(admitted.previewApplication.signal.aborted).toBe(true);
            currentGrant = false;
            expect(await mod.openPeerTcpTunnel({ ...input, grantConsumption: consumption() }))
                .toMatchObject({ ok: false, reasonCode: 'preview_registration_unavailable' });
            expect(await mod.openPeerTcpTunnel({ ...input, acquirePreviewApplication: undefined, grantConsumption: consumption() }))
                .toMatchObject({ ok: false, reasonCode: 'preview_registration_unavailable' });
            expect(await mod.openPeerTcpTunnel({ ...input, open: { ...input.open, grant: { ...grant,
                payload: { ...payload, accountId: 'forged-viewer' } } }, grantConsumption: consumption() }))
                .toMatchObject({ ok: false, reasonCode: 'grant_bad_signature' });
        } finally {
            control.destroy();
            if (admitted?.ok) await admitted.previewApplication?.close();
            handle.dispose();
        }
    });
    it('refuses a signed preview when its canonical registration authority is absent', async () => {
        const mod = await loadOpenModule();
        if (!mod) throw new Error('open owner unavailable');
        const handle = createEphemeralPeerRouteProofHandleV2({ randomBytes: (length) => new Uint8Array(length).fill(5) });
        const payload: DirectRouteGrantPayloadV2 = {
            v: 2, grantId: 'preview-grant', accountId: 'account_1', machineId: 'machine_1',
            flowKind: 'tcp_tunnel', routeKind: 'iroh_peer',
            scope: { kind: 'tcp_tunnel', tunnelId: 'preview-tunnel', allowedPorts: [5173], preview: {
                previewId: 'preview-1', machineId: 'machine_1', owner: { kind: 'user', id: 'account_1' },
                target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            } },
            iat: 1_000, exp: null, aud: 'happier-daemon-route-grant', endpointFingerprint: 'b'.repeat(64),
            iroh: { initiator: { kind: 'account_client', endpointId: 'a'.repeat(64) }, target: { machineId: 'machine_1', endpointId: 'b'.repeat(64) }, operationKind: 'tcp_tunnel' },
            proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url,
        };
        const grant = { payload, signature: { keyId: 'key_1', alg: 'Ed25519' as const,
            valueBase64Url: toBase64Url(tweetnacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)), signingKeyPair.secretKey)) } };
        try {
            const result = await mod.openPeerTcpTunnel({
                open: { v: 2, kind: 'open', tunnelId: 'preview-tunnel', targetMachineId: 'machine_1', routeKind: 'iroh_peer',
                    destination: { host: '127.0.0.1', port: 5173 }, grant, proof: handle.sign(grant) },
                nowMs: 2_000, expected: { accountId: 'account_1', machineId: 'machine_1', endpointFingerprint: 'endpoint_1', irohEndpointId: 'b'.repeat(64) },
                trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
                grantConsumption: createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' }),
            });
            expect(result).toMatchObject({ ok: false, reasonCode: 'preview_registration_unavailable' });
        } finally { handle.dispose(); }
    });
    it('rejects the retired account-signed direct tunnel before destination admission', async () => {
        const mod = await loadOpenModule();
        expect(mod).not.toBeNull();
        const result = await mod!.openPeerTcpTunnel({
            open: createLegacyOpen(),
            nowMs: 2_000,
            expected: {
                accountId: 'account_1', machineId: 'machine_1', endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            grantConsumption: createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' }),
        });
        expect(result).toMatchObject({ ok: false, reasonCode: 'open_invalid' });
    });

    it.each(['loopback_direct', 'iroh_peer'] as const)('admits a %s V2 tunnel with the canonical ephemeral proof and no account signing key', async (routeKind) => {
        const mod = await loadOpenModule();
        const handle = createEphemeralPeerRouteProofHandleV2({
            randomBytes: (length) => new Uint8Array(length).fill(length === 32 ? 4 : 5),
        });
        const payload: DirectRouteGrantPayloadV2 = {
            v: 2, grantId: 'grant_v2', accountId: 'account_1', machineId: 'machine_1',
            flowKind: 'tcp_tunnel', routeKind,
            scope: { kind: 'tcp_tunnel', tunnelId: 'tun_v2', allowedPorts: [3000], },
            iat: 1_000, exp: 601_000, aud: 'happier-daemon-route-grant', endpointFingerprint: routeKind === 'iroh_peer' ? 'b'.repeat(64) : 'endpoint_1',
            ...(routeKind === 'iroh_peer' ? { iroh: {
                initiator: { kind: 'account_client' as const, endpointId: 'a'.repeat(64) },
                target: { machineId: 'machine_1', endpointId: 'b'.repeat(64) },
                operationKind: 'tcp_tunnel' as const,
            } } : {}),
            proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url,
        };
        const grant = {
            payload,
            signature: {
                keyId: 'key_1', alg: 'Ed25519' as const,
                valueBase64Url: toBase64Url(tweetnacl.sign.detached(
                    Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'), signingKeyPair.secretKey,
                )),
            },
        };
        const proof = handle.sign(grant);
        const consumption = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' });
        const open = {
            v: 2 as const, kind: 'open' as const, tunnelId: 'tun_v2', targetMachineId: 'machine_1',
            routeKind, destination: { host: '127.0.0.1', port: 3000 }, grant, proof,
        };
        const input = {
            open,
            nowMs: 2_000,
            expected: {
                accountId: 'account_1', machineId: 'machine_1', endpointFingerprint: 'endpoint_1',
                ...(routeKind === 'iroh_peer' ? { irohEndpointId: 'b'.repeat(64) } : {}),
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            grantConsumption: consumption,
            connectTcp: vi.fn(async () => ({ close: vi.fn() })),
        };

        if (routeKind === 'iroh_peer') {
            await expect(mod?.openPeerTcpTunnel({ ...input, open: {
                ...open, destination: { host: '127.0.0.1', port: 3001 },
            } })).resolves.toMatchObject({ ok: false, reasonCode: 'destination_port_not_allowed' });
            await expect(mod?.openPeerTcpTunnel({ ...input, expected: {
                ...input.expected, irohEndpointId: 'c'.repeat(64),
            } })).resolves.toMatchObject({ ok: false, reasonCode: 'grant_endpoint_mismatch' });
        }
        await expect(mod?.openPeerTcpTunnel(input)).resolves.toMatchObject({ ok: true, receipt: 'peer.tunnel.opened' });
        await expect(mod?.openPeerTcpTunnel(input)).resolves.toMatchObject({ ok: false, reasonCode: 'grant_already_consumed' });
    });

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
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            grantConsumption: createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' }),
            connectTcp,
        })).resolves.toMatchObject({
            ok: true,
            response: {
                streamPath: '/peer-mediation/v1/tunnel/stream',
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
            receipt: 'peer.tunnel.opened',
        });

        expect(connectTcp).not.toHaveBeenCalled();
    });

    it('returns binary_frame_v2 in the open response when the loopback tunnel selected binary encoding', async () => {
        const mod = await loadOpenModule();
        const connectTcp = vi.fn(async () => ({ close: vi.fn() }));
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        await expect(mod?.openPeerTcpTunnel({
            open: createOpen({
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
            }),
            nowMs: 2_000,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            grantConsumption: createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' }),
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

    it('rejects the removed JSON/base64 encoding at the open schema boundary', async () => {
        const mod = await loadOpenModule();
        const connectTcp = vi.fn(async () => ({ close: vi.fn() }));
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        // The removed encoding no longer exists in the canonical Protocol type, so this boundary
        // case is built as wire input rather than through the typed open builder.
        const openWithRemovedEncoding: unknown = {
            ...createOpen({ selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 }),
            supportedEncodings: ['json_base64_v1'],
        };

        await expect(mod?.openPeerTcpTunnel({
            open: openWithRemovedEncoding,
            nowMs: 2_000,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            grantConsumption: createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' }),
            connectTcp,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'open_invalid',
            receipt: 'peer.route.fallback',
        });
        expect(connectTcp).not.toHaveBeenCalled();
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
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            grantConsumption: createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' }),
            connectTcp,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'destination_host_not_allowed',
            receipt: 'peer.route.fallback',
        });

        expect(connectTcp).not.toHaveBeenCalled();
    });

    it.each(['2130706433', '0177.0.0.1', '::ffff:127.0.0.1'])(
        'uses the protocol loopback owner for the literal destination %s',
        async (host) => {
            const mod = await loadOpenModule();
            expect(mod?.isPeerTcpTunnelLoopbackDestinationHost(host)).toBe(true);
        },
    );

    it('normalizes bracketed IPv6 loopback for the admitted child destination without dialing TCP', async () => {
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
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            grantConsumption: createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' }),
            connectTcp,
        })).resolves.toMatchObject({
            ok: true,
            receipt: 'peer.tunnel.opened',
            // Every child resolves the destination normalized by the signed admission owner.
            destination: { host: '::1', port: 3000 },
        });

        expect(connectTcp).not.toHaveBeenCalled();
    });

    it('refuses a loopback direct open that names no TCP destination', async () => {
        const mod = await loadOpenModule();
        const connectTcp = vi.fn(async () => ({ close: vi.fn() }));
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        // Protocol V1 admits a destination-free open only for the provider-broker application
        // relay, which is a `server_relay` route this direct owner never serves.
        const { destination, ...openWithoutDestination } = createOpen();
        expect(destination).toBeDefined();

        await expect(mod?.openPeerTcpTunnel({
            open: openWithoutDestination,
            nowMs: 2_000,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            grantConsumption: createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' }),
            connectTcp,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'open_invalid',
            receipt: 'peer.route.fallback',
        });

        expect(connectTcp).not.toHaveBeenCalled();
    });
});
