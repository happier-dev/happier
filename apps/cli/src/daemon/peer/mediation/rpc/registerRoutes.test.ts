import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
    PEER_MACHINE_RPC_DIRECT_PATH_V2,
    PeerMachineRpcDirectResponseV2Schema,
    createDirectRouteGrantSigningInputV2,
    createPeerRouteProofSigningInputV2,
    digestSignedDirectRouteGrantV2,
    type DirectRouteGrantPayloadV2,
    type PeerMachineRpcDirectRequestV2,
    type PeerRouteEphemeralProofV2,
    type SignedDirectRouteGrantV2,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerPeerMediationMachineRpcDirectRoutes } from './registerRoutes';

const serverKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}

function createGrant(input: Readonly<{
    grantId?: string;
    iat?: number;
    exp?: number;
    ephemeralSeed?: number;
}> = {}): Readonly<{
    grant: SignedDirectRouteGrantV2;
    ephemeralSecretKey: Uint8Array;
}> {
    const ephemeralKeyPair = tweetnacl.sign.keyPair.fromSeed(
        new Uint8Array(32).fill(input.ephemeralSeed ?? 8),
    );
    const payload: DirectRouteGrantPayloadV2 = {
        v: 2,
        grantId: input.grantId ?? 'grant_rpc_v2',
        grantFamilyId: 'family_rpc_v2',
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        scope: {
            kind: 'machine_rpc',
            rpcScopeId: `machine_1:${RPC_METHODS.DAEMON_MEMORY_STATUS}`,
            allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
            maxCalls: 2,
            maxIdleMs: 30_000,
        },
        iat: input.iat ?? 1_000,
        exp: input.exp ?? 3_000,
        aud: 'happier-daemon-route-grant',
        endpointFingerprint: 'endpoint_1',
        proofKind: 'ephemeral_ed25519',
        ephemeralPublicKeyBase64Url: toBase64Url(ephemeralKeyPair.publicKey),
    };
    return {
        grant: {
            payload,
            signature: {
                keyId: 'server_key_1',
                alg: 'Ed25519',
                valueBase64Url: toBase64Url(tweetnacl.sign.detached(
                    Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'),
                    serverKeyPair.secretKey,
                )),
            },
        },
        ephemeralSecretKey: ephemeralKeyPair.secretKey,
    };
}

function createProof(input: Readonly<{
    grant: SignedDirectRouteGrantV2;
    ephemeralSecretKey: Uint8Array;
    nonceByte: number;
}>): PeerRouteEphemeralProofV2 {
    const digest = digestSignedDirectRouteGrantV2(input.grant);
    const nonce = new Uint8Array(16).fill(input.nonceByte);
    return {
        v: 2,
        kind: 'ephemeral_ed25519',
        signedGrantDigestBase64Url: toBase64Url(digest),
        nonceBase64Url: toBase64Url(nonce),
        signatureBase64Url: toBase64Url(tweetnacl.sign.detached(
            createPeerRouteProofSigningInputV2({ digest, nonce }),
            input.ephemeralSecretKey,
        )),
    };
}

function createRequest(input: Readonly<{
    requestId: string;
    grant: SignedDirectRouteGrantV2;
    proof: PeerRouteEphemeralProofV2;
}>): PeerMachineRpcDirectRequestV2 {
    return {
        v: 2,
        requestId: input.requestId,
        method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        params: {},
        routeKind: 'loopback_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: 'endpoint_1',
        grant: input.grant,
        proof: input.proof,
    };
}

function createApp(input: Readonly<{
    nowMs: () => number;
    invokeLocal: (method: string, params: unknown) => Promise<unknown>;
    localPerPeerMaxConcurrentCalls?: number;
}>) {
    const app = fastify({ logger: false });
    registerPeerMediationMachineRpcDirectRoutes(app, {
        nowMs: input.nowMs,
        expected: {
            accountId: 'account_1',
            machineId: 'machine_1',
            flowKind: 'machine_rpc',
            routeKind: 'loopback_direct',
            endpointFingerprint: 'endpoint_1',
        },
        trustRoots: [{ keyId: 'server_key_1', publicKey: toBase64Url(serverKeyPair.publicKey) }],
        rpcHandlerManager: { invokeLocal: input.invokeLocal },
        localPerPeerMaxConcurrentCalls: input.localPerPeerMaxConcurrentCalls,
    });
    return app;
}

describe('registerPeerMediationMachineRpcDirectRoutes V2 grant admission', () => {
    it('consumes one signed grant even when a replay uses an independently valid nonce and signature', async () => {
        const signed = createGrant();
        const app = createApp({ nowMs: () => 2_000, invokeLocal: async () => ({ ok: true }) });
        const first = createRequest({
            requestId: 'request_1',
            grant: signed.grant,
            proof: createProof({ ...signed, nonceByte: 1 }),
        });
        const second = createRequest({
            requestId: 'request_2',
            grant: signed.grant,
            proof: createProof({ ...signed, nonceByte: 2 }),
        });

        expect((await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2, payload: first })).json())
            .toMatchObject({ v: 2, ok: true });
        expect((await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2, payload: second })).json())
            .toMatchObject({ v: 2, ok: false, reasonCode: 'direct_call_limit_exceeded' });
        await app.close();
    });

    it('admits exactly one concurrent winner for a signed grant', async () => {
        const signed = createGrant();
        let invoked = 0;
        const app = createApp({
            nowMs: () => 2_000,
            invokeLocal: async () => {
                invoked += 1;
                await Promise.resolve();
                return { ok: true };
            },
        });
        const responses = await Promise.all([1, 2].map(async (nonceByte) => (
            await app.inject({
                method: 'POST',
                url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                payload: createRequest({
                    requestId: `request_${nonceByte}`,
                    grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte }),
                }),
            })
        ).json()));

        expect(responses.filter((response) => response.ok === true)).toHaveLength(1);
        expect(responses.filter((response) => response.reasonCode === 'direct_call_limit_exceeded')).toHaveLength(1);
        expect(invoked).toBe(1);
        await app.close();
    });

    it('returns a typed terminal response for a throwing handler and retains consumption', async () => {
        const signed = createGrant();
        let invoked = 0;
        const app = createApp({
            nowMs: () => 2_000,
            localPerPeerMaxConcurrentCalls: 1,
            invokeLocal: async () => {
                invoked += 1;
                throw new Error('local handler failed');
            },
        });
        const post = async (nonceByte: number) => (
            await app.inject({
                method: 'POST',
                url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                payload: createRequest({
                    requestId: `request_${nonceByte}`,
                    grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte }),
                }),
            })
        ).json();

        expect(PeerMachineRpcDirectResponseV2Schema.parse(await post(1)))
            .toMatchObject({ v: 2, ok: false, reasonCode: 'handler_unavailable' });
        expect(await post(2)).toMatchObject({ v: 2, ok: false, reasonCode: 'direct_call_limit_exceeded' });
        expect(await post(3)).toMatchObject({ v: 2, ok: false, reasonCode: 'direct_call_limit_exceeded' });
        const fresh = createGrant({ grantId: 'grant_after_handler_throw', ephemeralSeed: 9 });
        expect((await app.inject({
            method: 'POST',
            url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
            payload: createRequest({
                requestId: 'request_fresh',
                grant: fresh.grant,
                proof: createProof({ ...fresh, nonceByte: 4 }),
            }),
        })).json()).toMatchObject({ v: 2, ok: false, reasonCode: 'handler_unavailable' });
        expect(invoked).toBe(2);
        await app.close();
    });

    it('retains consumption when the activated handler returns unavailable', async () => {
        const signed = createGrant();
        const app = createApp({
            nowMs: () => 2_000,
            invokeLocal: async () => ({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        });
        const post = async (nonceByte: number) => (
            await app.inject({
                method: 'POST',
                url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                payload: createRequest({
                    requestId: `request_${nonceByte}`,
                    grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte }),
                }),
            })
        ).json();

        expect(await post(1)).toMatchObject({ v: 2, ok: false, reasonCode: 'handler_unavailable' });
        expect(await post(2)).toMatchObject({ v: 2, ok: false, reasonCode: 'direct_call_limit_exceeded' });
        await app.close();
    });

    it('does not reserve on invalid proof or scope and prunes consumption at expiry for a fresh grant', async () => {
        let nowMs = 2_000;
        let invoked = 0;
        const app = createApp({ nowMs: () => nowMs, invokeLocal: async () => ({ invocation: ++invoked }) });
        const signed = createGrant();
        const validProof = createProof({ ...signed, nonceByte: 1 });
        const invalidProof: PeerRouteEphemeralProofV2 = {
            ...validProof,
            signatureBase64Url: toBase64Url(new Uint8Array(64).fill(99)),
        };

        expect((await app.inject({
            method: 'POST',
            url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
            payload: {
                ...createRequest({
                    requestId: 'outside_scope',
                    grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte: 0 }),
                }),
                method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET,
            },
        })).json()).toMatchObject({ v: 2, ok: false, reasonCode: 'method_not_allowed_by_grant' });

        expect((await app.inject({
            method: 'POST',
            url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
            payload: createRequest({ requestId: 'invalid', grant: signed.grant, proof: invalidProof }),
        })).json()).toMatchObject({ v: 2, ok: false, reasonCode: 'nonce_bad_signature' });
        expect((await app.inject({
            method: 'POST',
            url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
            payload: createRequest({ requestId: 'valid', grant: signed.grant, proof: validProof }),
        })).json()).toMatchObject({ v: 2, ok: true });

        nowMs = 3_000;
        const fresh = createGrant({ grantId: signed.grant.payload.grantId, iat: 3_000, exp: 4_000, ephemeralSeed: 9 });
        expect((await app.inject({
            method: 'POST',
            url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
            payload: createRequest({
                requestId: 'fresh',
                grant: fresh.grant,
                proof: createProof({ ...fresh, nonceByte: 2 }),
            }),
        })).json()).toMatchObject({ v: 2, ok: true });
        expect(invoked).toBe(2);
        await app.close();
    });
});
