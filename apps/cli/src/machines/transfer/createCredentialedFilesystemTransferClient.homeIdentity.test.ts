import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIRECT_ROUTE_GRANT_AUDIENCE_V1, IrohMachineHandshakeV1Schema, createDirectRouteGrantSigningInputV2,
    type DirectRouteGrantPayloadV2 } from '@happier-dev/protocol';
import { DirectRouteGrantRequestV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
// Collect the real lazily loaded client graph before timing tunnel behavior.
import '@/api/api';
import { createCredentialedFilesystemTransferClient } from './createCredentialedFilesystemTransferClient';

// The addon and HTTP calls are OS/network boundaries. Home comparison, grant
// validation, handshake creation and runtime ownership remain real.
const nativeBoundary = vi.hoisted(() => ({ load: vi.fn(), dial: vi.fn() }));
vi.mock('@happier-dev/iroh-native/node', async original => ({
    ...await original<typeof import('@happier-dev/iroh-native/node')>(), loadIrohNodeNative: nativeBoundary.load,
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('credentialed filesystem transfer Home identity', () => {
    it('opens the captured canonical Home from its local profile and denies a foreign Home before network admission', async () => {
        const issuer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(81));
        const trustRoot = { keyId: 'home-issuer', publicKey: Buffer.from(issuer.publicKey).toString('base64url') };
        const requests: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            requests.push(path);
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'account' } };
            if (path === '/v1/machines') return { status: 200, data: [{ id: 'holder', kind: 'persistent', active: true,
                revokedAt: null, replacedByMachineId: null,
                operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'b'.repeat(64) } },
                operationProtocolCapabilitiesRevision: 1 }] };
            throw new Error(`Unexpected transfer HTTP read: ${path}`);
        });
        const nativeFetch = globalThis.fetch;
        vi.stubGlobal('fetch', vi.fn(async (...args: Parameters<typeof fetch>) => {
            if (new URL(String(args[0])).pathname.startsWith('/v1/features')) return Response.json({ features: {}, capabilities: {
                machines: { peerMediation: { grantSigningKeys: [trustRoot] } } } });
            return nativeFetch(...args);
        }));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            requests.push(path);
            expect(path).toBe('/v1/machines/peer/mediation/route-grants');
            const request = DirectRouteGrantRequestV2Schema.parse(body);
            const now = Date.now();
            const payload = { v: 2, grantId: 'finite-home-grant', accountId: 'account', machineId: request.machineId,
                flowKind: request.flowKind, routeKind: request.routeKind, scope: request.scope, iat: now, exp: now + request.ttlMs,
                aud: DIRECT_ROUTE_GRANT_AUDIENCE_V1, endpointFingerprint: request.endpointFingerprint,
                iroh: request.iroh, proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url } satisfies DirectRouteGrantPayloadV2;
            return { status: 200, data: { ok: true, grant: { payload, signature: { alg: 'Ed25519', keyId: trustRoot.keyId,
                valueBase64Url: Buffer.from(nacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)), issuer.secretKey)).toString('base64url') } } } };
        });
        nativeBoundary.dial.mockImplementation(async (request: { handshakeJson: string }) => {
            expect(IrohMachineHandshakeV1Schema.parse(JSON.parse(request.handshakeJson)).accountId).toBe('account');
            return { machineTunnelId: 'home-tunnel', endpointHandle: 'home-endpoint', localPort: 12345,
                connectionActive: true, remoteEndpointId: 'b'.repeat(64), observedPath: 'direct', startedAtMs: 1, lastErrorCode: null };
        });
        nativeBoundary.load.mockReturnValue({ available: true, native: {
            createEndpoint: async () => ({ endpointHandle: 'home-endpoint', endpointId: 'a'.repeat(64) }),
            getEndpointStatus: async () => ({ active: true, endpointId: 'a'.repeat(64), relayUrls: [], directAddresses: [] }),
            startMachineTunnel: nativeBoundary.dial, stopMachineTunnel: async () => {}, shutdownEndpoint: async () => {},
        } });
        const client = await createCredentialedFilesystemTransferClient({
            credentials: { token: 'account-transfer', credentialProvenance: 'stored_session', encryption: null },
            serverId: 'local-home-profile', serverIdentityId: 'srv_home', serverApiUrl: 'https://transfer-home.test',
            executeAction: async () => { throw new Error('Tunnel admission does not execute a filesystem Action'); },
        });
        try {
            const beforeForeign = [...requests];
            await expect(client.openMachineTunnel({ targetMachineId: 'holder', serverId: 'srv_foreign' }))
                .rejects.toThrow('server_scope_mismatch');
            expect(requests).toEqual(beforeForeign);
            const tunnel = await client.openMachineTunnel({ targetMachineId: 'holder', serverId: 'srv_home' });
            expect(tunnel.localPort).toBe(12345);
            await tunnel.close();
        } finally { await client.close(); }
    });
});
