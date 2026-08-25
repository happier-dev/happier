import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
    PEER_MACHINE_RPC_DIRECT_PATH_V2,
    PeerMachineRpcDirectResponseV2Schema,
    createDirectRouteGrantSigningInputV2,
    createPeerMachineRpcRequestHashV1,
    createPeerRouteProofSigningInputV2,
    digestSignedDirectRouteGrantV2,
    type DirectRouteGrantPayloadV2,
    type PeerMachineRpcDirectRequestV2,
    type PeerRouteEphemeralProofV2,
    type SignedDirectRouteGrantV2,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { Machine } from '@/api/types';
import { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

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
    method?: string;
}> = {}): Readonly<{
    grant: SignedDirectRouteGrantV2;
    ephemeralSecretKey: Uint8Array;
}> {
    const method = input.method ?? RPC_METHODS.DAEMON_MEMORY_STATUS;
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
            rpcScopeId: `machine_1:${method}`,
            allowedMethods: [method],
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
    method?: string;
    params?: unknown;
}>): PeerMachineRpcDirectRequestV2 {
    return {
        v: 2,
        requestId: input.requestId,
        method: input.method ?? RPC_METHODS.DAEMON_MEMORY_STATUS,
        params: input.params ?? {},
        routeKind: 'loopback_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: 'endpoint_1',
        grant: input.grant,
        proof: input.proof,
    };
}

function createApp(input: Readonly<{
    nowMs: () => number;
    invokeLocal: (
        method: string,
        params: unknown,
        options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<unknown>;
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

function createMachine(): Machine {
    return {
        id: 'machine_1',
        encryptionKey: new Uint8Array(32).fill(7),
        encryptionVariant: 'legacy',
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

function createDeferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve: (value: T) => void;
}> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function listenOnLoopback(app: ReturnType<typeof createApp>): Promise<string> {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected direct peer RPC test server TCP address');
    }
    return `http://127.0.0.1:${address.port}`;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
    return await new Promise<T | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), timeoutMs);
        void promise.then((value) => {
            clearTimeout(timeout);
            resolve(value);
        });
    });
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

    it('propagates a cancelled direct peer request to the canonical contributed Action handler', async () => {
        const actionId = 'acme.direct/run';
        const client = new ApiMachineClient('token', createMachine());
        const actionStarted = createDeferred<void>();
        const actionAborted = createDeferred<boolean>();
        let releaseAction = () => {};

        const targetActionInvocations = createTargetActionInvocationRegistry({
            actions: [{
                pluginId: 'acme.direct',
                pluginVersion: '1.0.0',
                generation: '7',
                localId: 'run',
                definition: {
                    id: 'run',
                    dangerLevel: 'safe',
                    scopes: ['global'],
                    surfaces: ['ui'],
                },
                handler: async (_input, context) => {
                    const signal = context.signal;
                    actionStarted.resolve(undefined);
                    await new Promise<void>((resolve) => {
                        let settled = false;
                        const finish = () => {
                            if (settled) return;
                            settled = true;
                            signal.removeEventListener('abort', onAbort);
                            resolve();
                        };
                        const onAbort = () => {
                            actionAborted.resolve(signal.aborted);
                            finish();
                        };
                        releaseAction = finish;
                        if (signal.aborted) {
                            onAbort();
                        } else {
                            signal.addEventListener('abort', onAbort, { once: true });
                        }
                    });
                    return { cancelled: signal.aborted };
                },
            }],
            resolveAuthorizationFacts: (action) => ({
                generation: {
                    targetGeneration: action.generation,
                    desiredGeneration: action.generation,
                    appliedGeneration: action.generation,
                },
                resourceSelections: [],
                scopedGrants: [],
                operatingSystemAuthorization: [],
            }),
            createServices: createUnavailablePluginServicesFactory(),
            resolveHostBinding: createTargetActionHostBindingResolver(),
        });
        // Fixture boundary: this production adapter reads only the canonical
        // contribution lookup and target Action registry below.
        const runtimeRegistry = {
            contributes: {
                actionsById: new Map([[
                    actionId,
                    {
                        pluginId: 'acme.direct',
                        definition: {
                            id: 'run',
                            surfaces: { ui: true },
                        },
                    },
                ]]),
            },
            targetActionInvocations,
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        const handlerManager = (client as unknown as Readonly<{
            rpcHandlerManager: RpcHandlerRegistrar;
        }>).rpcHandlerManager;
        registerDaemonContributionRegistryProjectionHandler(handlerManager, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
        });
        const peerHandlerManager = client.getPeerMediationMachineRpcHandlerManager();
        const app = createApp({
            nowMs: () => 2_000,
            invokeLocal: async (method, params, options) => await peerHandlerManager.invokeLocal(
                method,
                params,
                options,
            ),
        });

        try {
            const baseUrl = await listenOnLoopback(app);
            const signed = createGrant({
                grantId: 'grant_direct_action_cancel',
                method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            });
            const params = {
                machineId: 'machine_1',
                expectedGeneration: '7',
                qualifiedActionId: actionId,
                input: { title: 'Cancel me' },
                executionSurface: 'ui',
            };
            const replayKey = 'direct_action_cancel_replay';
            const request = {
                ...createRequest({
                    requestId: 'request_direct_action_cancel',
                    grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte: 1 }),
                    method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
                    params,
                }),
                commandReceipt: {
                    v: 1 as const,
                    issuer: 'ui' as const,
                    issuedAtMs: 2_000,
                    requestHash: createPeerMachineRpcRequestHashV1({
                        method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
                        params,
                        grantId: signed.grant.payload.grantId,
                        endpointFingerprint: 'endpoint_1',
                        replayKey,
                    }),
                    replayKey,
                },
            };
            const controller = new AbortController();
            const requestPromise = fetch(`${baseUrl}${PEER_MACHINE_RPC_DIRECT_PATH_V2}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(request),
                signal: controller.signal,
            });

            const started = await settleWithin(actionStarted.promise, 1_000);
            if (started === null) {
                const response = await settleWithin(requestPromise, 100);
                const responseBody = response ? await response.text() : null;
                controller.abort();
                throw new Error(
                    responseBody !== null
                        ? `Canonical contributed Action did not start: ${responseBody}`
                        : 'Canonical contributed Action did not start or settle',
                );
            }
            controller.abort();

            await expect(requestPromise).rejects.toMatchObject({ name: 'AbortError' });
            expect(await settleWithin(actionAborted.promise, 500)).toBe(true);
            await expect(settleWithin(client.awaitPendingRpcRequests(), 500)).resolves.toBeUndefined();
        } finally {
            releaseAction();
            await settleWithin(client.awaitPendingRpcRequests(), 500);
            await app.close().catch(() => undefined);
            await client.shutdown().catch(() => undefined);
        }
    });

    it('isolates concurrent direct request lifetimes so a cancelled peer does not abort a normal peer', async () => {
        const firstStarted = createDeferred<void>();
        const secondStarted = createDeferred<void>();
        const firstAborted = createDeferred<boolean>();
        const releaseFirst = createDeferred<void>();
        const releaseSecond = createDeferred<void>();
        let firstSignal: AbortSignal | undefined;
        let secondSignal: AbortSignal | undefined;
        const app = createApp({
            nowMs: () => 2_000,
            invokeLocal: async (_method, params, options) => {
                const invocation = (params as Readonly<{ invocation: string }>).invocation;
                if (invocation === 'cancelled') {
                    firstSignal = options?.signal;
                    firstStarted.resolve(undefined);
                    await new Promise<void>((resolve) => {
                        const finish = () => {
                            firstSignal?.removeEventListener('abort', onAbort);
                            resolve();
                        };
                        const onAbort = () => {
                            firstAborted.resolve(firstSignal?.aborted === true);
                            finish();
                        };
                        void releaseFirst.promise.then(finish);
                        if (firstSignal?.aborted) {
                            onAbort();
                        } else {
                            firstSignal?.addEventListener('abort', onAbort, { once: true });
                        }
                    });
                    return { invocation };
                }

                secondSignal = options?.signal;
                secondStarted.resolve(undefined);
                await releaseSecond.promise;
                return { invocation };
            },
        });

        try {
            const baseUrl = await listenOnLoopback(app);
            const firstSigned = createGrant({
                grantId: 'grant_direct_cancelled_peer',
                ephemeralSeed: 9,
            });
            const secondSigned = createGrant({
                grantId: 'grant_direct_normal_peer',
                ephemeralSeed: 10,
            });
            const firstRequest = createRequest({
                requestId: 'request_direct_cancelled_peer',
                grant: firstSigned.grant,
                proof: createProof({ ...firstSigned, nonceByte: 1 }),
                params: { invocation: 'cancelled' },
            });
            const secondRequest = createRequest({
                requestId: 'request_direct_normal_peer',
                grant: secondSigned.grant,
                proof: createProof({ ...secondSigned, nonceByte: 2 }),
                params: { invocation: 'normal' },
            });
            const controller = new AbortController();
            const firstResponse = fetch(`${baseUrl}${PEER_MACHINE_RPC_DIRECT_PATH_V2}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(firstRequest),
                signal: controller.signal,
            });
            const secondResponse = fetch(`${baseUrl}${PEER_MACHINE_RPC_DIRECT_PATH_V2}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(secondRequest),
            });

            expect(await Promise.all([
                settleWithin(firstStarted.promise, 1_000),
                settleWithin(secondStarted.promise, 1_000),
            ])).toEqual([undefined, undefined]);
            controller.abort();

            await expect(firstResponse).rejects.toMatchObject({ name: 'AbortError' });
            expect(await settleWithin(firstAborted.promise, 500)).toBe(true);
            expect(secondSignal?.aborted).toBe(false);

            releaseSecond.resolve(undefined);
            expect((await secondResponse).status).toBe(200);
            expect(secondSignal?.aborted).toBe(false);
        } finally {
            releaseFirst.resolve(undefined);
            releaseSecond.resolve(undefined);
            await app.close().catch(() => undefined);
        }
    });
});
