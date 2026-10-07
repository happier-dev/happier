import { vi } from 'vitest';
import {
    DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema,
    createDirectRouteGrantSigningInputV2,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import nacl from 'tweetnacl';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { FileViewRpcRequest } from './views/sessionFilesViewTestkit';

export const SESSION_FILE_MACHINE_CARRIER_ORIGIN = 'http://127.0.0.1:48126';
const sdk = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), tunnels: new Map<string, Record<string, unknown>>() }));

// The physical native SDK is replaced; endpoint, admission, grants, encrypted
// transfer, destination and preview lifecycle owners all remain real.
vi.mock('@happier-dev/iroh-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/iroh-native')>();
    const native: import('@happier-dev/iroh-native').NativeIrohModule = {
        getAvailability: () => ({ available: true }),
        createEndpoint: async () => ({ endpointHandle: 'preview-endpoint', endpointId: 'b'.repeat(64), relayPolicy: 'automatic', relayMode: 'custom', capProfile: 'machineBulk', relayUrls: ['https://relay.example.test'] }),
        startMachineTunnel: (input) => sdk.start(input),
        stopMachineTunnel: (leaseId) => sdk.stop(leaseId),
        getTunnelStatus: async (tunnelId) => sdk.tunnels.get(tunnelId) ?? null,
        ensureHomeTunnel: async () => { throw new Error('Test Home uses its HTTPS transport'); },
        releaseHomeTunnel: async () => {},
        shutdownEndpoint: async () => {},
    };
    return { ...actual, getOptionalHappierIrohNativeModule: () => native };
});

export function createSessionFileNativeTransferBoundary(input: Readonly<{ bytes?: Uint8Array; name?: string }> = {}) {
    let bytes = input.bytes ?? new Uint8Array([97, 98, 99]);
    let name = input.name ?? 'file.png';
    let nextGate: ReturnType<typeof createDeferred<void>> | null = null;
    let counter = 0;
    const exports = new Map<string, { bytes: Uint8Array; name: string }>();
    const prepares: FileViewRpcRequest[] = [];
    const httpRequests: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    const grantRequests: Array<ReturnType<typeof DirectRouteGrantRequestV2Schema.parse>> = [];
    sdk.start.mockReset();
    sdk.stop.mockReset();
    sdk.tunnels.clear();
    sdk.stop.mockImplementation(async (leaseId: string) => { sdk.tunnels.delete(leaseId); });
    sdk.start.mockImplementation(async (input: { handshakeJson: string }) => {
        const { IrohMachineHandshakeV1Schema, verifyPeerRouteEphemeralProofV2 } = await import('@happier-dev/protocol');
        const handshake = IrohMachineHandshakeV1Schema.parse(JSON.parse(input.handshakeJson));
        const proof = verifyPeerRouteEphemeralProofV2({ grant: handshake.grant, proof: handshake.proof });
        if (!proof.valid) throw new Error(`Invalid client proof: ${proof.reasonCode}`);
        const lease = { machineTunnelId: `preview-lease-${counter}`, endpointHandle: 'preview-endpoint', localPort: 48126,
            connectionActive: true, remoteEndpointId: handshake.target.endpointId, observedPath: 'relay', startedAtMs: Date.now(), lastErrorCode: null };
        sdk.tunnels.set(lease.machineTunnelId, lease);
        return lease;
    });
    return {
        origin: SESSION_FILE_MACHINE_CARRIER_ORIGIN, prepares, httpRequests, grantRequests,
        nativeStarts: sdk.start, nativeStops: sdk.stop,
        setPayload(nextBytes: Uint8Array, nextName = name) { bytes = nextBytes; name = nextName; },
        deferNextOpen() { const gate = createDeferred<void>(); nextGate = gate; return gate; },
        rpc(request: FileViewRpcRequest) {
            if (request.method === RPC_METHODS.STAT_FILE) return { success: true, exists: true, kind: 'file', sizeBytes: bytes.byteLength };
            if (request.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE) return { success: true };
            if (request.method !== RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE) return undefined;
            prepares.push(request);
            // This is the external daemon wire bag, not an internal parser.
            const payload = request.payload as { t?: string; handle?: { name: string } };
            const transferId = `preview-transfer-${++counter}`;
            const exportedName = payload.t === 'composer_media_stage_inspect_v1' ? payload.handle?.name ?? name : name;
            exports.set(transferId, { bytes: new Uint8Array(bytes), name: exportedName });
            return { success: true, transferId, name: exportedName, sizeBytes: bytes.byteLength, expiresAt: Date.now() + 60_000,
                endpointCandidates: [{ kind: 'http', url: `${SESSION_FILE_MACHINE_CARRIER_ORIGIN}/machine-transfers/direct/${transferId}`, authorizationToken: 'preview-export-token', expiresAt: Date.now() + 60_000 }] };
        },
        async request(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/peer/mediation/route-grants') {
                const request = DirectRouteGrantRequestV2Schema.parse(JSON.parse(String(init?.body)));
                grantRequests.push(request);
                const payload = { v: 2 as const, grantId: `preview-grant-${grantRequests.length}`, accountId: 'alice', machineId: request.machineId,
                    flowKind: request.flowKind, routeKind: request.routeKind, scope: request.scope, iat: Date.now(), exp: Date.now() + request.ttlMs,
                    aud: 'happier-daemon-route-grant' as const, endpointFingerprint: request.endpointFingerprint,
                    proofKind: 'ephemeral_ed25519' as const, ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url, iroh: request.iroh };
                const serverKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(6));
                const signature = nacl.sign.detached(new TextEncoder().encode(createDirectRouteGrantSigningInputV2(payload)), serverKey.secretKey);
                const grant = SignedDirectRouteGrantV2Schema.parse({ payload, signature: { keyId: 'preview-home-signing-key', alg: 'Ed25519', valueBase64Url: Buffer.from(signature).toString('base64url') } });
                return Response.json({ ok: true, grant });
            }
            if (parsed.origin !== SESSION_FILE_MACHINE_CARRIER_ORIGIN) return new Response('{}', { status: 404 });
            httpRequests.push({ url: parsed.href, signal: init?.signal });
            const segments = parsed.pathname.split('/');
            const transferId = segments[3];
            const exported = exports.get(transferId);
            if (!exported) return new Response('{}', { status: 404 });
            if (parsed.pathname.endsWith('/open')) {
                const gate = nextGate; nextGate = null;
                if (gate) await gate.promise;
                const { createTransferManifestHasher } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher');
                const hasher = createTransferManifestHasher(); hasher.update(exported.bytes);
                return Response.json({ transferId, totalChunks: 1, sizeBytes: exported.bytes.byteLength, manifestHash: hasher.digestManifestHash() });
            }
            if (parsed.pathname.endsWith('/chunks/0')) {
                const { createEncryptedTransferChunkEnvelope } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
                const envelope = await createEncryptedTransferChunkEnvelope({ transferId, sequence: 0, payload: exported.bytes,
                    recipientPublicKeyBase64: new Headers(init?.headers).get('x-happier-transfer-recipient-public-key') ?? '' });
                return Response.json({ transferId, kind: 'chunk', sequence: 0, ...envelope });
            }
            return new Response('{}', { status: 404 });
        },
    };
}
