import { describe, expect, it } from 'vitest';

import {
    ProviderConnectionIdSchema,
    type ProviderRuntimeBindingBasisV1,
} from '@happier-dev/protocol';

import { createManagedServiceEndpointProjectionV1 } from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';

import {
    ManagedServiceEndpointReadOpenRequestV1Schema,
    ManagedServiceEndpointReadOpenResultV1Schema,
    ManagedServiceEndpointReadNextRequestV1Schema,
    ManagedServiceEndpointReadNextResultV1Schema,
} from './managedServiceEndpointReadProtocol';
import type {
    RunnerManagedProviderCustodyClaimV1,
} from './runnerManagedServicesCustody';

function runtimeBindingBasis(): ProviderRuntimeBindingBasisV1 {
    return {
        v: 1,
        deployment: {
            kind: 'managedLocal',
            gatewayPlacement: { kind: 'sessionMachine' },
            implementationIdentity: {
                pluginId: 'acme.providers',
                localId: 'gateway',
            },
            managedRuntime: {
                kind: 'managed',
                dependencies: [],
                endpointTemplateIds: ['messages'],
                connectedAccounts: [],
                requestAuthUses: [],
            },
            purposeBindings: { v: 1, bindings: [] },
        },
        agentTargetKey: 'agent:happier.agent.claude/claude',
        connectionId: ProviderConnectionIdSchema.parse('connection-p'),
        contributionKey: 'acme.providers/gateway',
        endpoint: {
            endpointTemplateId: 'messages',
            protocol: 'anthropic',
            publicHeaders: {},
        },
        runtimeCredentialTransport: null,
        prepared: { v: 1, materialization: 'spawnEnv' },
        adapterVersion: 1,
        credentialAuthorization: {
            connectionSecurityFingerprint: 'connection-security',
            grantFingerprint: 'grant',
        },
        agentSupport: {
            acceptsProtocols: ['anthropic'],
            required: { streaming: true },
            credentialSupport: {
                supportsNoAuth: true,
                apiKeyTransports: [],
            },
            authIsolation: {
                suppressConnectedServiceIds: [],
                ownedEnvKeys: [],
            },
            materialization: 'spawnEnv',
            applyPolicy: 'restart_session',
            supportsFreeformModelIds: true,
        },
    };
}

function exactHandleRoute() {
    const claim: RunnerManagedProviderCustodyClaimV1 = {
        v: 1,
        sessionId: 'session-one',
        runtimeBindingBasis: runtimeBindingBasis(),
        pluginId: 'acme.providers',
        providerLocalId: 'gateway',
        occurrenceId: 'provider-occurrence-p',
        sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'provider-p',
            installSource: 'npm',
        },
        manifestAuthority: 'external',
        operationClaimId: 'session-demand:session-one:provider-p',
    };
    return Object.freeze({
        kind: 'exactHandle' as const,
        claim,
        serviceId: 'provider-wrapper',
    });
}

function endpointProjectionRoute() {
    return Object.freeze({
        kind: 'endpointProjection' as const,
        projection: createManagedServiceEndpointProjectionV1({
            sessionId: 'session-one',
            pluginId: 'opencode',
            contributionId: 'opencode/agent',
            serverId: 'opencode-server',
            instanceId: 'instance-one',
            sourceCustody: {
                kind: 'managed',
                immutableGenerationId: 'immutable-generation-one',
                installSource: 'npm',
            },
            custodyOwner: 'sessionRunner',
            mode: 'managedSpawn',
            endpoint: {
                baseUrl: 'http://127.0.0.1:4312',
                host: '127.0.0.1',
                port: 4312,
            },
            process: {
                pid: 42,
                startIdentity: 'runner-start-42',
            },
            createdAtMs: 1_000,
        }),
    });
}

describe('managed-service endpoint read protocol', () => {
    it('retains the same sanitized failure on unavailable open and body reads', () => {
        const failureCause = { phase: 'managed_service.endpoint', errorClass: 'TypeError', errorCode: 'ECONNRESET', httpStatus: 503 };
        const unavailable = { v: 1, requestId: '00000000-0000-4000-8000-000000000001', status: 'unavailable' };
        for (const schema of [ManagedServiceEndpointReadOpenResultV1Schema, ManagedServiceEndpointReadNextResultV1Schema]) {
            expect(schema.parse(JSON.parse(JSON.stringify({ ...unavailable, failureCause })))).toEqual({ ...unavailable, failureCause });
            expect(schema.parse(unavailable)).toEqual(unavailable);
            expect(schema.safeParse({ ...unavailable, failureCause: { ...failureCause, message: 'PRIVATE_ENDPOINT_OUTPUT' } }).success).toBe(false);
        }
    });

    it('discriminates exact-handle requests from current-global endpoint projections', () => {
        const common = {
            v: 1 as const,
            requestId: '00000000-0000-4000-8000-000000000001',
            pathAndQuery: '/session/message?stream=true',
            headers: { 'content-type': 'application/json' },
        };
        expect(ManagedServiceEndpointReadOpenRequestV1Schema.safeParse({
            ...common,
            route: exactHandleRoute(),
            interactive: true,
            method: 'POST',
            bodyBase64: Buffer.from('{"hello":true}').toString('base64'),
            timeoutMs: 10_000,
        }).success).toBe(true);
        expect(ManagedServiceEndpointReadOpenRequestV1Schema.safeParse({
            ...common,
            route: endpointProjectionRoute(),
            interactive: true,
        }).success).toBe(true);
        expect(ManagedServiceEndpointReadOpenRequestV1Schema.safeParse({
            ...common, route: exactHandleRoute(), interactive: false,
        }).success).toBe(false);

        for (const mixedRoute of [
            {
                ...exactHandleRoute(),
                projection: endpointProjectionRoute().projection,
            },
            {
                ...endpointProjectionRoute(),
                claim: exactHandleRoute().claim,
                serviceId: exactHandleRoute().serviceId,
            },
        ]) {
            expect(ManagedServiceEndpointReadOpenRequestV1Schema.safeParse({
                ...common,
                route: mixedRoute,
            }).success).toBe(false);
        }
        expect(ManagedServiceEndpointReadOpenRequestV1Schema.safeParse({
            ...common,
            route: endpointProjectionRoute(),
            method: 'POST',
            bodyBase64: Buffer.from('not-a-projection-read').toString('base64'),
        }).success).toBe(false);
    });

    it('accepts large canonical bodies through the existing 16 MiB boundary', () => {
        const request = (bodyBase64: string) => ManagedServiceEndpointReadOpenRequestV1Schema.safeParse({
            v: 1, requestId: '00000000-0000-4000-8000-000000000001',
            route: exactHandleRoute(), interactive: true, method: 'POST', pathAndQuery: '/', headers: {}, bodyBase64,
        }).success;
        for (const size of [4, 16]) expect(request(Buffer.alloc(size * 1024 * 1024, 97).toString('base64'))).toBe(true);
        expect(request(Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64'))).toBe(false);
        expect(request('AB==')).toBe(false);
        expect(request('AA==')).toBe(true);
    });

    it('requires continuation routes to retain the same ownership discriminator', () => {
        expect(ManagedServiceEndpointReadNextRequestV1Schema.safeParse({
            v: 1,
            requestId: '00000000-0000-4000-8000-000000000001',
            route: exactHandleRoute(),
        }).success).toBe(true);
        expect(ManagedServiceEndpointReadNextRequestV1Schema.safeParse({
            v: 1,
            requestId: '00000000-0000-4000-8000-000000000001',
            route: {
                kind: 'endpointProjection',
                projectionToken: endpointProjectionRoute()
                    .projection.projectionToken,
            },
        }).success).toBe(true);
        expect(ManagedServiceEndpointReadNextRequestV1Schema.safeParse({
            v: 1,
            requestId: '00000000-0000-4000-8000-000000000001',
            route: {
                kind: 'endpointProjection',
                projectionToken: endpointProjectionRoute()
                    .projection.projectionToken,
                claim: exactHandleRoute().claim,
            },
        }).success).toBe(false);
    });

    it('accepts only canonical response chunks within the 64 KiB transport bound', () => {
        const common = {
            v: 1 as const,
            requestId: '00000000-0000-4000-8000-000000000001',
            status: 'chunk' as const,
        };
        expect(ManagedServiceEndpointReadNextResultV1Schema.safeParse({
            ...common,
            dataBase64: Buffer.alloc(64 * 1024).toString('base64'),
        }).success).toBe(true);
        expect(ManagedServiceEndpointReadNextResultV1Schema.safeParse({
            ...common,
            dataBase64: Buffer.alloc(64 * 1024 + 1).toString('base64'),
        }).success).toBe(false);
        expect(ManagedServiceEndpointReadNextResultV1Schema.safeParse({
            ...common,
            dataBase64: 'not canonical base64',
        }).success).toBe(false);
    });
});
