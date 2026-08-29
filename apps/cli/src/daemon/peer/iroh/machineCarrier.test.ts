import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
    createDirectRouteGrantSigningInputV1,
    type DirectRouteGrantPayloadV1,
    type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';

import {
    MACHINE_CARRIER_ALPN_V1,
    createMachineCarrierAdapter,
    MachineCarrierError,
    type MachineCarrierOperationKind,
} from './machineCarrier';

const signingSeed = new Uint8Array(32).fill(9);
const signingKeyPair = tweetnacl.sign.keyPair.fromSeed(signingSeed);
const endpointId = 'endpoint-1';
const trustRoots = [{
    keyId: 'key-1',
    publicKey: Buffer.from(signingKeyPair.publicKey).toString('base64url'),
}];

function createGrant(overrides: Partial<DirectRouteGrantPayloadV1> = {}): SignedDirectRouteGrantV1 {
    const payload: DirectRouteGrantPayloadV1 = {
        v: 1,
        grantId: 'grant-1',
        grantFamilyId: 'family-1',
        accountId: 'account-1',
        machineId: 'machine-1',
        flowKind: 'bounded_transfer',
        routeKind: 'iroh_peer',
        scope: {
            kind: 'bounded_transfer',
            mode: 'single',
            transferId: 'operation-1',
            maxBytes: 1024,
        },
        iat: 1_000,
        exp: 10_000,
        aud: 'happier-daemon-route-grant',
        endpointFingerprint: endpointId,
        ...overrides,
    };
    const signature = tweetnacl.sign.detached(
        Buffer.from(createDirectRouteGrantSigningInputV1(payload), 'utf8'),
        signingKeyPair.secretKey,
    );
    return {
        payload,
        signature: {
            keyId: 'key-1',
            alg: 'Ed25519',
            valueBase64Url: Buffer.from(signature).toString('base64url'),
        },
    };
}

function createAdapter(path: 'direct' | 'relay') {
    return createMachineCarrierAdapter({
        accountId: 'account-1',
        machineId: 'machine-1',
        trustRoots,
        nowMs: () => 2_000,
        connect: async (input) => ({
            alpn: input.alpn,
            observedPath: path,
            close: async () => undefined,
        }),
    });
}

describe('machine/1 carrier lifecycle', () => {
    it.each([
        'file_transfer',
        'attachment_transfer',
        'workspace_sync',
    ] as MachineCarrierOperationKind[])('admits %s through the existing grant authority', async (operationKind) => {
        const adapter = createAdapter('direct');
        const session = await adapter.open({
            operationKind,
            operationId: 'operation-1',
            peerEndpointId: endpointId,
            grant: createGrant(),
        });

        expect(session).toMatchObject({
            alpn: MACHINE_CARRIER_ALPN_V1,
            operationKind,
            operationId: 'operation-1',
            observedPath: 'direct',
        });
        await session.close();
    });

    it('reports a relayed observed path without selecting a server-relay fallback', async () => {
        const session = await createAdapter('relay').open({
            operationKind: 'file_transfer',
            operationId: 'operation-1',
            peerEndpointId: endpointId,
            grant: createGrant(),
        });

        expect(session.observedPath).toBe('relay');
        expect(session.alpn).toBe(MACHINE_CARRIER_ALPN_V1);
    });

    it('rejects a server-relay grant as a typed error before connecting', async () => {
        let connectCalls = 0;
        const adapter = createMachineCarrierAdapter({
            accountId: 'account-1',
            machineId: 'machine-1',
            trustRoots,
            nowMs: () => 2_000,
            connect: async () => {
                connectCalls += 1;
                return { observedPath: 'relay', close: async () => undefined };
            },
        });

        await expect(adapter.open({
            operationKind: 'file_transfer',
            operationId: 'operation-1',
            peerEndpointId: endpointId,
            // Deliberately malformed raw boundary fixture: mutate a signed valid
            // grant after signing so the adapter rejects it before connect.
            grant: ({ ...createGrant(), payload: { ...createGrant().payload, routeKind: 'server_relay' } } as unknown) as SignedDirectRouteGrantV1,
        })).rejects.toMatchObject<Partial<MachineCarrierError>>({
            code: 'route_kind_unsupported',
        });
        expect(connectCalls).toBe(0);
    });

    it('rejects an expired grant before dialing the endpoint', async () => {
        let connectCalls = 0;
        const adapter = createMachineCarrierAdapter({
            accountId: 'account-1', machineId: 'machine-1', trustRoots, nowMs: () => 20_000,
            connect: async () => { connectCalls += 1; return { observedPath: 'direct', close: async () => undefined }; },
        });
        await expect(adapter.open({ operationKind: 'attachment_transfer', operationId: 'operation-1', peerEndpointId: endpointId, grant: createGrant() }))
            .rejects.toMatchObject<Partial<MachineCarrierError>>({ code: 'grant_expired' });
        expect(connectCalls).toBe(0);
    });

    it('does not admit a machine-rpc grant for a file transfer', async () => {
        const adapter = createAdapter('direct');
        await expect(adapter.open({
            operationKind: 'file_transfer', operationId: 'operation-1', peerEndpointId: endpointId,
            grant: createGrant({ flowKind: 'machine_rpc' as DirectRouteGrantPayloadV1['flowKind'], scope: {
                kind: 'machine_rpc', rpcScopeId: 'operation-1', allowedMethods: ['transfer.open'], maxCalls: 1, maxIdleMs: 1000,
            } }),
        })).rejects.toMatchObject<Partial<MachineCarrierError>>({ code: 'grant_flow_mismatch' });
    });

    it('checks the machine/endpoint role handshake before dialing', async () => {
        let connectCalls = 0;
        const adapter = createMachineCarrierAdapter({
            accountId: 'account-1', machineId: 'machine-1', localEndpointId: 'local-endpoint',
            role: 'acceptor', trustRoots, nowMs: () => 2_000,
            connect: async () => { connectCalls += 1; return { observedPath: 'direct', close: async () => undefined }; },
        });
        await expect(adapter.open({
            operationKind: 'file_transfer', operationId: 'operation-1', peerEndpointId: endpointId,
            grant: createGrant(),
            handshake: {
                sourceMachineId: 'machine-source', targetMachineId: 'machine-1',
                sourceEndpointId: endpointId, targetEndpointId: 'wrong-endpoint', role: 'acceptor',
            },
        })).rejects.toMatchObject<Partial<MachineCarrierError>>({ code: 'target_endpoint_mismatch' });
        expect(connectCalls).toBe(0);
    });
});
