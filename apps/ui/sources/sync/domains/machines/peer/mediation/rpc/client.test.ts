import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

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
