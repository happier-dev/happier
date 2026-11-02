import { readProviderBrokerResponseBody } from '@/providers/broker/providerBroker.testkit';
import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ManagedProviderEndpointHttpAccess } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import {
    createProviderBrokerRouteGrantSigningInputV1,
    type PeerTcpTunnelRelayAuthorizationV2,
    type ProviderBrokerResourceTestRelayBindingV1,
    type ProviderBrokerRouteGrantPayloadV1,
    type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';
import { createProviderBrokerRequestHandler } from './providerBrokerRequestHandler';
import { mapProviderBrokerApplicationFailure } from '../../../../server/sources/app/api/routes/providers/externalProviderBrokerDispatcher';

const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
const payload: ProviderBrokerRouteGrantPayloadV1 = {
    v: 1, grantId: 'grant', aud: 'happier-provider-broker-route-v1', issuedAt: 100, expiresAt: 200,
    teamId: 'team', resourceId: 'resource',
    sourceRevision: 'source-revision-7',
    brokerPlacementFingerprint: 'c'.repeat(64),
    initiatorTokenEpoch: 0,
    initiator: { accountId: 'requester', machineId: 'worker', endpointId: 'a'.repeat(64) },
    target: { custodianAccountId: 'custodian', machineId: 'broker', endpointId: 'b'.repeat(64) },
    consumer: { kind: 'session', sessionId: 'session' },
    application: {
        agentTargetKey: 'codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses',
        protocol: 'openai-chat',
    },
};
const providerSource = TeamCredentialSourceBindingV1Schema.parse({
    v: 1,
    kind: 'provider_connection',
    connectionId: 'pc_source',
    connectionSecurityFingerprint: 'connection-security:v1:source',
    credentialSlotId: 'apiKey',
});
function authority(value = payload): SignedProviderBrokerRouteGrantV1 {
    return { payload: value, signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createProviderBrokerRouteGrantSigningInputV1(value)), key.secretKey)).toString('base64url') } };
}
function resourceTestRelayAuthorization(
    binding: ProviderBrokerResourceTestRelayBindingV1,
): PeerTcpTunnelRelayAuthorizationV2 {
    return {
        payload: {
            v: 2,
            grantId: 'resource-test-relay-grant',
            accountId: 'custodian',
            targetMachineId: 'broker',
            flowKind: 'provider_broker',
            routeKind: 'server_relay',
            tunnelId: 'resource-test-tunnel',
            relaySocketId: 'relay-socket',
            providerBroker: binding,
            capProfileId: 'server-relay-v1',
            maxFrameBytes: 65_536,
            maxIdleMs: 10_000,
            maxDurationMs: 30_000,
            iat: 100,
            exp: 200,
            aud: 'happier-tcp-tunnel-relay-authorization',
        },
        signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'AA' },
    };
}
const expected = { teamId: payload.teamId, resourceId: payload.resourceId, sourceRevision: payload.sourceRevision, brokerPlacementFingerprint: payload.brokerPlacementFingerprint, initiator: payload.initiator, target: payload.target, consumer: payload.consumer, application: payload.application };
const context = { authenticatedRemoteEndpointId: payload.initiator.endpointId, authority: authority(), expected };
const modelCatalog = (
    resolveCanonicalModelId: (modelId: string) => string | null = (modelId) => modelId,
    models: readonly string[] = ['gpt-5'],
) => ({ models: models.map((id) => ({ id })), resolveCanonicalModelId });
const handlerSecurity = {
    resolveTrustRoots: () => [{ keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') }],
    nowMs: () => 150,
    resolveRequestPolicy: async () => ({
        resourceRevision: 7,
        sourceRevision: 'source-revision-7',
        application: payload.application,
        source: providerSource,
        policy: null,
        modelCatalog: modelCatalog(),
    }),
    createRequestId: () => 'request-1',
};
const request = { pathAndQuery: '/v1/chat/completions', method: 'POST' as const, headers: { authorization: 'Bearer upstream-secret', 'x-happier-machine-local-capability': 'local-secret', 'x-provider-header': 'preserved' }, body: new TextEncoder().encode(JSON.stringify({ model: 'gpt-5' })), timeoutMs: 5_000 };
function access(): ManagedProviderEndpointHttpAccess { return { endpointUrl: () => 'http://127.0.0.1:1234', request: vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: null })) }; }

describe('createProviderBrokerRequestHandler', () => {
    it('reports the managed carrier size refusal as an observable HTTP 413', async () => {
        const handle = createProviderBrokerRequestHandler({ ...handlerSecurity,
            admit: async () => ({ ok: true, access: { endpointUrl: () => 'http://127.0.0.1:1234',
                request: async () => { throw new PluginError({ code: 'plugin_managed_service_request_too_large',
                    details: { resource: 'body_bytes', limit: 16 * 1024 * 1024, actual: 16 * 1024 * 1024 + 1 } }); } } }),
        });
        const result = await handle({ context, request });
        expect(result).toMatchObject({ ok: true, response: { status: 413,
            headers: { 'x-happier-provider-broker-error-code': 'request_too_large' } } });
        if (!result.ok) throw new Error('expected transport size response');
        expect(mapProviderBrokerApplicationFailure(result.response.status, result.response.headers))
            .toEqual({ error: 'invalid_request' });
        expect(await new Response(await readProviderBrokerResponseBody(result.response.body)).json()).toMatchObject({ error: {
            code: 'request_too_large', type: 'invalid_request_error',
        } });
    });

    it('authorizes model-list metadata against current Home facts without request admission or provider access', async () => {
        const admit = vi.fn();
        const authorizeModelCatalog = vi.fn(async () => ({ ok: true as const }));
        const handle = createProviderBrokerRequestHandler({
            ...handlerSecurity,
            admit,
            authorizeModelCatalog,
            resolveRequestPolicy: async () => ({
                resourceRevision: 7,
                sourceRevision: 'source-revision-7',
                application: payload.application,
                source: providerSource,
                policy: {
                    allowedProtocolKinds: ['openai_chat_completions'],
                    allowedModelIds: ['allowed-model'],
                    reasoningEffort: null,
                },
                modelCatalog: modelCatalog((modelId) => modelId, ['gpt-5', 'allowed-model', 'denied-model']),
            }),
        });

        const result = await handle({
            context,
            request: { method: 'GET', pathAndQuery: '/v1/models' },
        });

        expect(result).toMatchObject({ ok: true, response: { status: 200 } });
        if (!result.ok || !result.response.body) throw new Error('expected model-list response body');
        expect(JSON.parse(new TextDecoder().decode(await new Response(await readProviderBrokerResponseBody(result.response.body)).arrayBuffer()))).toEqual({
            object: 'list',
            data: [{ id: 'allowed-model', object: 'model', created: 0, owned_by: 'happier' }],
        });
        expect(authorizeModelCatalog).toHaveBeenCalledWith({
            authorization: { kind: 'private', authority: authority() },
            expectedResourceRevision: 7,
            request: { method: 'GET', pathAndQuery: '/v1/models' },
        });
        expect(admit).not.toHaveBeenCalled();
    });

    it('fails closed when current Home facts no longer authorize model-list metadata', async () => {
        const handle = createProviderBrokerRequestHandler({
            ...handlerSecurity,
            admit: vi.fn(),
            authorizeModelCatalog: async () => ({ ok: false as const, reasonCode: 'session_not_active' as const }),
        });
        await expect(handle({
            context,
            request: { method: 'GET', pathAndQuery: '/v1/models' },
        })).resolves.toEqual({ ok: false, reasonCode: 'session_not_active' });
    });

    it('authenticates a resource-test carrier binding before current Home admission and dispatch', async () => {
        const endpoint = access();
        const resourceTestBinding = {
            v: 1 as const,
            kind: 'resource_test' as const,
            teamId: 'team',
            resourceId: 'resource',
            requestId: 'resource-test-request',
            actorAccountId: 'actor-account',
            expectedResourceRevision: 7,
            application: payload.application,
            source: providerSource,
            verifiedCredentialEvidence: {
                v: 1 as const,
                evidence: [{ kind: 'home_method' as const, methodId: 'email_password' }],
            },
        };
        const admitResourceTest = vi.fn(async () => ({ ok: true as const, access: endpoint }));
        const relayAuthorization = resourceTestRelayAuthorization(resourceTestBinding);
        const handle = createProviderBrokerRequestHandler({
            ...handlerSecurity,
            admit: vi.fn(),
            resolveResourceTestRequestPolicy: async () => ({
                resourceRevision: 7,
                policy: null,
                application: payload.application,
                modelCatalog: modelCatalog(),
            }),
            admitResourceTest,
        });
        await expect(handle({
            context: { kind: 'external', binding: resourceTestBinding, relayAuthorization },
            carrierRequest: {
                v: 1,
                kind: 'resource_test',
                requestId: resourceTestBinding.requestId,
                teamId: resourceTestBinding.teamId,
                resourceId: resourceTestBinding.resourceId,
                route: 'chat_completions',
                method: 'POST',
                pathAndQuery: '/v1/chat/completions',
                bodyBase64: Buffer.from(JSON.stringify({ model: 'gpt-5' })).toString('base64'),
            },
            request,
        })).resolves.toEqual({ ok: true, response: expect.any(Object) });
        expect(admitResourceTest).toHaveBeenCalledWith(expect.objectContaining({
            binding: resourceTestBinding,
            relayAuthorization,
            expectedResourceRevision: 7,
            application: payload.application,
            requestFacts: expect.objectContaining({
                routeKind: 'openai_chat_completions',
                modelId: 'gpt-5',
            }),
        }));
        expect(endpoint.request).toHaveBeenCalledWith(expect.objectContaining({
            headers: { 'x-provider-header': 'preserved' },
        }));
    });

    it('rejects a resource test when the current application differs from its signed binding', async () => {
        const binding = {
            v: 1 as const,
            kind: 'resource_test' as const,
            teamId: 'team', resourceId: 'resource', requestId: 'request-test',
            actorAccountId: 'actor', expectedResourceRevision: 7,
            application: payload.application,
            source: providerSource,
        };
        const admitResourceTest = vi.fn();
        const relayAuthorization = resourceTestRelayAuthorization(binding);
        const handle = createProviderBrokerRequestHandler({
            ...handlerSecurity,
            admit: vi.fn(),
            resolveResourceTestRequestPolicy: async () => ({
                resourceRevision: 7,
                policy: null,
                application: { ...payload.application, endpointTemplateId: 'different-endpoint' },
                modelCatalog: modelCatalog(),
            }),
            admitResourceTest,
        });
        await expect(handle({
            context: { kind: 'external', binding, relayAuthorization },
            carrierRequest: {
                v: 1, kind: 'resource_test', requestId: binding.requestId,
                teamId: binding.teamId, resourceId: binding.resourceId,
                route: 'chat_completions', method: 'POST',
                pathAndQuery: '/v1/chat/completions',
                bodyBase64: Buffer.from('{}').toString('base64'),
            },
            request,
        })).resolves.toEqual({ ok: false, reasonCode: 'resource_unavailable' });
        expect(admitResourceTest).not.toHaveBeenCalled();
    });

    it('re-verifies transport authority, performs current Home admission, strips auth, and delegates', async () => {
        const endpoint = access();
        const admit = vi.fn(async () => ({ ok: true as const, access: endpoint }));
        const handle = createProviderBrokerRequestHandler({ ...handlerSecurity, admit });
        await expect(handle({ context, request })).resolves.toEqual({ ok: true, response: expect.any(Object) });
        expect(admit).toHaveBeenCalledTimes(1);
        expect(admit).toHaveBeenCalledWith(expect.objectContaining({
            authority: authority(),
            expectedResourceRevision: 7,
            requestId: 'request-1',
            request: expect.objectContaining({ headers: { 'x-provider-header': 'preserved' } }),
            requestFacts: expect.objectContaining({
                generation: true,
                routeKind: 'openai_chat_completions',
                modelId: 'gpt-5',
            }),
        }));
        expect(endpoint.request).toHaveBeenCalledWith(expect.objectContaining({ pathAndQuery: request.pathAndQuery, headers: { 'x-provider-header': 'preserved' } }));
        const sent = vi.mocked(endpoint.request).mock.calls[0]![0];
        expect(sent.headers).not.toHaveProperty('authorization');
        expect(sent.headers).not.toHaveProperty('x-happier-machine-local-capability');
    });

    it('strips authentication headers case-insensitively while retaining ordinary provider headers', async () => {
        const endpoint = access();
        const handle = createProviderBrokerRequestHandler({ ...handlerSecurity, admit: async () => ({ ok: true as const, access: endpoint }) });
        await handle({ context, request: { ...request, headers: { Authorization: 'Bearer secret', 'X-API-KEY': 'secret', 'Content-Length': '999', 'X-Provider-Header': 'kept' } } });
        expect(vi.mocked(endpoint.request).mock.calls[0]![0].headers).toEqual({ 'x-provider-header': 'kept' });
    });
    it('fails closed before Home admission when transport identity or authority is wrong', async () => {
        const endpoint = access();
        const admit = vi.fn(async () => ({ ok: true as const, access: endpoint }));
        const handle = createProviderBrokerRequestHandler({ ...handlerSecurity, admit });
        await expect(handle({ context: { ...context, authenticatedRemoteEndpointId: 'c'.repeat(64) }, request })).resolves.toEqual({ ok: false, reasonCode: 'transport_identity_mismatch' });
        expect(admit).not.toHaveBeenCalled();
        expect(endpoint.request).not.toHaveBeenCalled();
    });
    it('does not call the managed provider when current Home admission denies the request', async () => {
        const endpoint = access();
        const handle = createProviderBrokerRequestHandler({ ...handlerSecurity, admit: async () => ({ ok: false as const, reasonCode: 'resource_forbidden' as const }) });
        await expect(handle({ context, request })).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        expect(endpoint.request).not.toHaveBeenCalled();
    });

    it('rejects a request route that does not match the signed application protocol', async () => {
        const endpoint = access();
        const admit = vi.fn(async () => ({ ok: true as const, access: endpoint }));
        const handle = createProviderBrokerRequestHandler({ ...handlerSecurity, admit });
        await expect(handle({
            context,
            request: {
                ...request,
                pathAndQuery: '/v1/responses',
                body: new TextEncoder().encode(JSON.stringify({ model: 'gpt-5' })),
            },
        })).resolves.toEqual({ ok: false, reasonCode: 'route_not_allowed' });
        expect(admit).not.toHaveBeenCalled();
        expect(endpoint.request).not.toHaveBeenCalled();
    });

    it('fails closed when the current resource policy projection is unavailable', async () => {
        const endpoint = access();
        const admit = vi.fn(async () => ({ ok: true as const, access: endpoint }));
        const handle = createProviderBrokerRequestHandler({
            ...handlerSecurity,
            resolveRequestPolicy: async () => null,
            admit,
        });
        await expect(handle({ context, request })).resolves.toEqual({
            ok: false,
            reasonCode: 'resource_unavailable',
        });
        expect(admit).not.toHaveBeenCalled();
        expect(endpoint.request).not.toHaveBeenCalled();
    });

    it('rejects a stream when its signed exact selection is stale at the current catalog owner', async () => {
        const endpoint = access();
        const admit = vi.fn(async () => ({ ok: true as const, access: endpoint }));
        const handle = createProviderBrokerRequestHandler({
            ...handlerSecurity,
            resolveRequestPolicy: async () => ({
                resourceRevision: 7,
                sourceRevision: 'replacement-source-revision',
                application: payload.application,
                source: providerSource,
                policy: null,
                modelCatalog: modelCatalog(),
            }),
            admit,
        });

        await expect(handle({ context, request })).resolves.toEqual({
            ok: false,
            reasonCode: 'resource_changed',
        });
        expect(admit).not.toHaveBeenCalled();
        expect(endpoint.request).not.toHaveBeenCalled();
    });

    it('does not consume admission or forward when strict body policy rejects', async () => {
        const endpoint = access();
        const admit = vi.fn(async () => ({ ok: true as const, access: endpoint }));
        const handle = createProviderBrokerRequestHandler({
            ...handlerSecurity,
            resolveRequestPolicy: async () => ({
                resourceRevision: 7,
                sourceRevision: 'source-revision-7',
                application: payload.application,
                source: providerSource,
                policy: {
                    allowedProtocolKinds: ['openai_chat_completions'],
                    allowedModelIds: ['allowed-model'],
                    reasoningEffort: null,
                },
                modelCatalog: modelCatalog(),
            }),
            admit,
        });
        await expect(handle({ context, request })).resolves.toEqual({
            ok: false,
            reasonCode: 'model_not_allowed',
        });
        expect(admit).not.toHaveBeenCalled();
        expect(endpoint.request).not.toHaveBeenCalled();
    });

    it('consumes the current catalog resolver before Home admission and provider dispatch', async () => {
        const endpoint = access();
        const admit = vi.fn(async () => ({ ok: true as const, access: endpoint }));
        const handle = createProviderBrokerRequestHandler({
            ...handlerSecurity,
            resolveRequestPolicy: async () => ({
                resourceRevision: 7,
                sourceRevision: 'source-revision-7',
                application: payload.application,
                source: providerSource,
                policy: {
                    allowedProtocolKinds: ['openai_chat_completions'],
                    allowedModelIds: ['gpt-5'],
                    reasoningEffort: null,
                },
                modelCatalog: modelCatalog(
                    (modelId: string) => modelId === 'model-alias' || modelId === 'gpt-5' ? 'gpt-5' : null,
                    ['gpt-5'],
                ),
            }),
            admit,
        });
        await expect(handle({
            context,
            request: {
                ...request,
                body: new TextEncoder().encode(JSON.stringify({ model: 'model-alias' })),
            },
        })).resolves.toEqual({ ok: true, response: expect.any(Object) });
        expect(admit).toHaveBeenCalledWith(expect.objectContaining({
            requestFacts: expect.objectContaining({ modelId: 'gpt-5' }),
        }));
        expect(endpoint.request).toHaveBeenCalledTimes(1);
    });

    it('keeps concurrent stream authority, target access, and headers isolated', async () => {
        const secondPayload: ProviderBrokerRouteGrantPayloadV1 = {
            ...payload,
            grantId: 'grant-2',
            resourceId: 'resource-2',
            initiator: { accountId: 'requester-2', machineId: 'worker-2', endpointId: 'c'.repeat(64) },
            consumer: { kind: 'execution_run', executionRunId: 'run-2' },
            executionRunOccurrenceId: 'occurrence-2',
        };
        const firstAccess = access();
        const secondAccess = access();
        const admit = vi.fn(async ({ authority: admitted }: Parameters<Parameters<typeof createProviderBrokerRequestHandler>[0]['admit']>[0]) => ({
            ok: true as const,
            access: admitted.payload.resourceId === payload.resourceId ? firstAccess : secondAccess,
        }));
        const handle = createProviderBrokerRequestHandler({ ...handlerSecurity, admit });
        const secondExpected = {
            teamId: secondPayload.teamId,
            resourceId: secondPayload.resourceId,
            sourceRevision: secondPayload.sourceRevision,
            brokerPlacementFingerprint: secondPayload.brokerPlacementFingerprint,
            initiator: secondPayload.initiator,
            target: secondPayload.target,
            consumer: secondPayload.consumer,
            application: secondPayload.application,
        };
        await Promise.all([
            handle({ context, request: { ...request, headers: { authorization: 'Bearer first', 'x-request': 'first' } } }),
            handle({ context: { authenticatedRemoteEndpointId: secondPayload.initiator.endpointId, authority: authority(secondPayload), expected: secondExpected }, request: { ...request, headers: { authorization: 'Bearer second', 'x-request': 'second' } } }),
        ]);
        expect(firstAccess.request).toHaveBeenCalledWith(expect.objectContaining({ headers: { 'x-request': 'first' } }));
        expect(secondAccess.request).toHaveBeenCalledWith(expect.objectContaining({ headers: { 'x-request': 'second' } }));
        expect(admit.mock.calls.map(([value]) => [value.authority.payload.resourceId, value.authority.payload.initiator.accountId])).toEqual([
            ['resource', 'requester'],
            ['resource-2', 'requester-2'],
        ]);
    });
});
