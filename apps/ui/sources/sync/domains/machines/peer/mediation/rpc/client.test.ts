import { describe, expect, it, vi } from 'vitest';

import {
    RPC_METHODS,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from '@happier-dev/protocol/rpc';

async function importClient() {
    return await import('./client').catch((error: unknown) => ({ importError: error }));
}

describe('machineRpcWithPeerMediationRoute', () => {
    it('uses server fallback without attempting direct transport for server-required methods', async () => {
        const module = await importClient();
        expect(module).toHaveProperty('machineRpcWithPeerMediationRoute');
        if ('importError' in module) throw module.importError;

        const postDirect = vi.fn();
        const serverFallback = vi.fn(async () => ({ routed: 'server' }));

        const result = await module.machineRpcWithPeerMediationRoute({
            serverId: 'server_1',
            machineId: 'machine_1',
            method: RPC_METHODS.SPAWN_HAPPY_SESSION,
            payload: { prompt: 'hello' },
            resolveDirectRoute: async () => {
                throw new Error('direct route should not be resolved');
            },
            postDirect,
            serverFallback,
            recordReceipt: vi.fn(),
        });

        expect(result).toEqual({ routed: 'server' });
        expect(postDirect).not.toHaveBeenCalled();
        expect(serverFallback).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'server_required',
        }));
    });

    it('preserves server fallback authorization for server-required session-write methods', async () => {
        const module = await importClient();
        expect(module).toHaveProperty('machineRpcWithPeerMediationRoute');
        if ('importError' in module) throw module.importError;

        const authorization = {
            kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
            sessionId: 'session_1',
        } as const;
        const serverFallback = vi.fn(async () => ({ routed: 'server' }));

        const result = await module.machineRpcWithPeerMediationRoute({
            serverId: 'server_1',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
            payload: { sessionId: 'session_1' },
            authorization,
            resolveDirectRoute: async () => {
                throw new Error('direct route should not be resolved');
            },
            postDirect: vi.fn(),
            serverFallback,
            recordReceipt: vi.fn(),
        });

        expect(result).toEqual({ routed: 'server' });
        expect(serverFallback).toHaveBeenCalledWith(expect.objectContaining({
            authorization,
            reasonCode: 'server_required',
        }));
    });

    it('falls back to the encrypted server route when direct route prerequisites fail', async () => {
        const module = await importClient();
        expect(module).toHaveProperty('machineRpcWithPeerMediationRoute');
        if ('importError' in module) throw module.importError;

        const recordReceipt = vi.fn();
        const result = await module.machineRpcWithPeerMediationRoute({
            serverId: 'server_1',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true },
            resolveDirectRoute: async () => ({
                kind: 'fallback',
                receipt: 'peer.route.fallback',
                reasonCode: 'grant_missing',
            }),
            postDirect: vi.fn(),
            serverFallback: async () => ({ routed: 'server' }),
            recordReceipt,
        });

        expect(result).toEqual({ routed: 'server' });
        expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({
            receipt: 'peer.route.fallback',
            reasonCode: 'grant_missing',
        }));
    });

    it('preserves peer-route signing capability details through server fallback', async () => {
        const module = await importClient();
        if ('importError' in module) throw module.importError;
        const serverFallback = vi.fn(async () => ({ routed: 'server' }));

        await module.machineRpcWithPeerMediationRoute({
            serverId: 'server_1',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true },
            resolveDirectRoute: async () => ({
                kind: 'fallback',
                receipt: 'peer.route.fallback',
                reasonCode: 'peer_route_signing_identity_unavailable',
                requiredCapability: 'peer_route_signing_identity_v1',
            }),
            postDirect: vi.fn(),
            serverFallback,
        });

        expect(serverFallback).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'peer_route_signing_identity_unavailable',
            requiredCapability: 'peer_route_signing_identity_v1',
        }));
    });

    it('does not use server fallback for daemon voice audio when relay fallback is disabled by policy', async () => {
        const module = await importClient();
        expect(module).toHaveProperty('machineRpcWithPeerMediationRoute');
        if ('importError' in module) throw module.importError;

        const serverFallback = vi.fn(async () => ({ routed: 'server' }));
        const recordReceipt = vi.fn();

        await expect(module.machineRpcWithPeerMediationRoute({
            serverId: 'server_1',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK,
            payload: {
                v: 1,
                streamId: 'stream_1',
                generation: 1,
                seq: 1,
                pcm16Base64: 'AA==',
            },
            resolveDirectRoute: async () => ({
                kind: 'fallback',
                receipt: 'peer.route.fallback',
                reasonCode: 'grant_missing',
            }),
            postDirect: vi.fn(),
            serverFallback,
            recordReceipt,
        })).rejects.toMatchObject({
            code: 'MACHINE_RPC_RELAY_FALLBACK_DISABLED',
            reasonCode: 'relay_disabled_by_policy',
        });

        expect(serverFallback).not.toHaveBeenCalled();
        expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({
            receipt: 'peer.route.fallback',
            reasonCode: 'grant_missing',
        }));
        expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({
            receipt: 'peer.rpc.fell_back_to_server',
            reasonCode: 'relay_disabled_by_policy',
        }));
    });

    it('uses server fallback for daemon voice audio only when relay fallback is explicitly allowed with caps', async () => {
        const module = await importClient();
        expect(module).toHaveProperty('machineRpcWithPeerMediationRoute');
        if ('importError' in module) throw module.importError;

        const serverFallback = vi.fn(async () => ({ routed: 'server' }));

        const result = await module.machineRpcWithPeerMediationRoute({
            serverId: 'server_1',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK,
            payload: {
                v: 1,
                streamId: 'stream_1',
                generation: 1,
                seq: 1,
                pcm16Base64: 'AA==',
            },
            resolveDirectRoute: async () => ({
                kind: 'fallback',
                receipt: 'peer.route.fallback',
                reasonCode: 'grant_missing',
            }),
            postDirect: vi.fn(),
            serverFallback,
            resolveRelayFallback: () => ({
                ok: true,
                routeKind: 'server_relay',
                caps: {
                    maxBitrateBps: 128_000,
                    maxFramesPerSecond: 50,
                    maxFrameBytes: 8_192,
                    maxDurationMs: 60_000,
                    maxTotalBytes: 960_000,
                    maxConcurrentStreamsPerAccount: 2,
                    maxConcurrentStreamsPerSocket: 1,
                    maxConcurrentStreamsPerMachine: 2,
                },
                policy: {
                    flowKind: 'daemon_voice_audio',
                    defaultSharedServerMode: 'disabled',
                    authorizationRequired: true,
                    relayCapsRequired: true,
                    meteringRequired: true,
                    lifecycleReceiptRequired: true,
                    capProfile: 'machine_live_stream_relay_caps_v1',
                },
            }),
        });

        expect(result).toEqual({ routed: 'server' });
        expect(serverFallback).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'grant_missing',
        }));
    });

    it('returns direct results and records route and RPC success receipts', async () => {
        const module = await importClient();
        expect(module).toHaveProperty('machineRpcWithPeerMediationRoute');
        if ('importError' in module) throw module.importError;

        const recordReceipt = vi.fn();
        const result = await module.machineRpcWithPeerMediationRoute({
            serverId: 'server_1',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true },
            resolveDirectRoute: async () => ({
                kind: 'selected',
                receipt: 'peer.route.selected',
                endpoint: {
                    url: 'http://127.0.0.1:3000/peer-mediation/v1/probe',
                    endpointFingerprint: 'endpoint_1',
                },
                grant: {
                    payload: {
                        v: 1,
                        grantId: 'grant_1',
                        grantFamilyId: 'family_1',
                        accountId: 'account_1',
                        machineId: 'machine_1',
                        flowKind: 'machine_rpc',
                        routeKind: 'loopback_direct',
                        scope: {
                            kind: 'machine_rpc',
                            rpcScopeId: 'rpc_scope_1',
                            allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
                            maxCalls: 1,
                            maxIdleMs: 10_000,
                        },
                        iat: 1_000,
                        exp: 601_000,
                        aud: 'happier-daemon-route-grant',
                        endpointFingerprint: 'endpoint_1',
                    },
                    signature: {
                        keyId: 'key_1',
                        alg: 'Ed25519',
                        valueBase64Url: 'AbCdEf012_-',
                    },
                },
                nonceProof: {
                    v: 1,
                    grantId: 'grant_1',
                    routeKind: 'loopback_direct',
                    flowKind: 'machine_rpc',
                    endpointFingerprint: 'endpoint_1',
                    nonceBase64Url: 'nonce_1',
                    signatureBase64Url: 'AbCdEf012_-',
                },
            }),
            postDirect: async () => ({
                v: 1,
                ok: true,
                receipt: 'peer.rpc.direct_call_succeeded',
                requestId: 'request_1',
                method: RPC_METHODS.DAEMON_MEMORY_STATUS,
                routeKind: 'loopback_direct',
                result: { routed: 'direct' },
            }),
            serverFallback: async () => {
                throw new Error('server route should not be used');
            },
            recordReceipt,
            createRequestId: () => 'request_1',
        });

        expect(result).toEqual({ routed: 'direct' });
        expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({
            receipt: 'peer.route.selected',
        }));
        expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({
            receipt: 'peer.rpc.direct_call_succeeded',
        }));
    });

    it('posts an ephemeral V2 route to the strict V2 RPC path', async () => {
        const module = await importClient();
        if ('importError' in module) throw module.importError;
        const postDirect = vi.fn(async (input: { request: { requestId: string; method: string } }) => ({
            v: 2 as const,
            ok: true as const,
            receipt: 'peer.rpc.direct_call_succeeded' as const,
            requestId: input.request.requestId,
            method: input.request.method,
            routeKind: 'loopback_direct' as const,
            result: { routed: 'direct-v2' },
        }));
        const publicKey = Buffer.from(new Uint8Array(32).fill(1)).toString('base64url');
        const signature = Buffer.from(new Uint8Array(64).fill(2)).toString('base64url');

        const result = await module.machineRpcWithPeerMediationRoute({
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true },
            resolveDirectRoute: async () => ({
                kind: 'selected',
                receipt: 'peer.route.selected',
                endpoint: { url: 'http://127.0.0.1:3000/peer-mediation/v1/probe', endpointFingerprint: 'endpoint_1' },
                grant: {
                    payload: {
                        v: 2, grantId: 'grant_v2', accountId: 'account_1', machineId: 'machine_1',
                        flowKind: 'machine_rpc', routeKind: 'loopback_direct',
                        scope: { kind: 'machine_rpc', rpcScopeId: 'rpc_1', allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS], maxCalls: 1, maxIdleMs: 10_000 },
                        iat: 1_000, exp: 601_000, aud: 'happier-daemon-route-grant', endpointFingerprint: 'endpoint_1',
                        proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: publicKey,
                    },
                    signature: { keyId: 'key_1', alg: 'Ed25519', valueBase64Url: signature },
                },
                proof: {
                    v: 2, kind: 'ephemeral_ed25519', signedGrantDigestBase64Url: publicKey,
                    nonceBase64Url: Buffer.from(new Uint8Array(16).fill(3)).toString('base64url'), signatureBase64Url: signature,
                },
            }),
            postDirect,
            serverFallback: async () => { throw new Error('server route should not be used'); },
            createRequestId: () => 'request_v2',
        });

        expect(result).toEqual({ routed: 'direct-v2' });
        expect(postDirect).toHaveBeenCalledWith(expect.objectContaining({
            url: 'http://127.0.0.1:3000/peer-mediation/v2/rpc',
            request: expect.objectContaining({ v: 2, proof: expect.objectContaining({ v: 2 }) }),
        }));
    });

    it('falls back when a direct success response is bound to another method', async () => {
        const module = await importClient();
        expect(module).toHaveProperty('machineRpcWithPeerMediationRoute');
        if ('importError' in module) throw module.importError;

        const recordReceipt = vi.fn();
        const serverFallback = vi.fn(async () => ({ routed: 'server' }));

        const result = await module.machineRpcWithPeerMediationRoute({
            serverId: 'server_1',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true },
            resolveDirectRoute: async () => ({
                kind: 'selected',
                receipt: 'peer.route.selected',
                endpoint: {
                    url: 'http://127.0.0.1:3000/peer-mediation/v1/probe',
                    endpointFingerprint: 'endpoint_1',
                },
                grant: {
                    payload: {
                        v: 1,
                        grantId: 'grant_1',
                        grantFamilyId: 'family_1',
                        accountId: 'account_1',
                        machineId: 'machine_1',
                        flowKind: 'machine_rpc',
                        routeKind: 'loopback_direct',
                        scope: {
                            kind: 'machine_rpc',
                            rpcScopeId: 'rpc_scope_1',
                            allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
                            maxCalls: 1,
                            maxIdleMs: 10_000,
                        },
                        iat: 1_000,
                        exp: 601_000,
                        aud: 'happier-daemon-route-grant',
                        endpointFingerprint: 'endpoint_1',
                    },
                    signature: {
                        keyId: 'key_1',
                        alg: 'Ed25519',
                        valueBase64Url: 'AbCdEf012_-',
                    },
                },
                nonceProof: {
                    v: 1,
                    grantId: 'grant_1',
                    routeKind: 'loopback_direct',
                    flowKind: 'machine_rpc',
                    endpointFingerprint: 'endpoint_1',
                    nonceBase64Url: 'nonce_1',
                    signatureBase64Url: 'AbCdEf012_-',
                },
            }),
            postDirect: async () => ({
                v: 1,
                ok: true,
                receipt: 'peer.rpc.direct_call_succeeded',
                requestId: 'request_1',
                method: RPC_METHODS.CAPABILITIES_DESCRIBE,
                routeKind: 'loopback_direct',
                result: { routed: 'direct' },
            }),
            serverFallback,
            recordReceipt,
            createRequestId: () => 'request_1',
        });

        expect(result).toEqual({ routed: 'server' });
        expect(serverFallback).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'invalid_request',
        }));
        expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({
            receipt: 'peer.rpc.fell_back_to_server',
            reasonCode: 'invalid_request',
        }));
    });

    it('falls back with invalid_request when a direct failure response is bound to another request', async () => {
        const module = await importClient();
        expect(module).toHaveProperty('machineRpcWithPeerMediationRoute');
        if ('importError' in module) throw module.importError;

        const recordReceipt = vi.fn();
        const serverFallback = vi.fn(async () => ({ routed: 'server' }));

        const result = await module.machineRpcWithPeerMediationRoute({
            serverId: 'server_1',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true },
            resolveDirectRoute: async () => ({
                kind: 'selected',
                receipt: 'peer.route.selected',
                endpoint: {
                    url: 'http://127.0.0.1:3000/peer-mediation/v1/probe',
                    endpointFingerprint: 'endpoint_1',
                },
                grant: {
                    payload: {
                        v: 1,
                        grantId: 'grant_1',
                        grantFamilyId: 'family_1',
                        accountId: 'account_1',
                        machineId: 'machine_1',
                        flowKind: 'machine_rpc',
                        routeKind: 'loopback_direct',
                        scope: {
                            kind: 'machine_rpc',
                            rpcScopeId: 'rpc_scope_1',
                            allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
                            maxCalls: 1,
                            maxIdleMs: 10_000,
                        },
                        iat: 1_000,
                        exp: 601_000,
                        aud: 'happier-daemon-route-grant',
                        endpointFingerprint: 'endpoint_1',
                    },
                    signature: {
                        keyId: 'key_1',
                        alg: 'Ed25519',
                        valueBase64Url: 'AbCdEf012_-',
                    },
                },
                nonceProof: {
                    v: 1,
                    grantId: 'grant_1',
                    routeKind: 'loopback_direct',
                    flowKind: 'machine_rpc',
                    endpointFingerprint: 'endpoint_1',
                    nonceBase64Url: 'nonce_1',
                    signatureBase64Url: 'AbCdEf012_-',
                },
            }),
            postDirect: async () => ({
                v: 1,
                ok: false,
                receipt: 'peer.rpc.fell_back_to_server',
                requestId: 'other_request',
                method: RPC_METHODS.DAEMON_MEMORY_STATUS,
                reasonCode: 'grant_revoked',
            }),
            serverFallback,
            recordReceipt,
            createRequestId: () => 'request_1',
        });

        expect(result).toEqual({ routed: 'server' });
        expect(serverFallback).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'invalid_request',
        }));
        expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({
            receipt: 'peer.rpc.fell_back_to_server',
            reasonCode: 'invalid_request',
        }));
    });
});
