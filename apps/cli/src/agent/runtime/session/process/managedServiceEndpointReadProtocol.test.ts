import { describe, expect, it } from 'vitest';

import {
    ProviderConnectionIdSchema,
    type ProviderRuntimeBindingBasisV1,
} from '@happier-dev/protocol';

import { createManagedServiceEndpointProjectionV1 } from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';

import {
    ManagedServiceEndpointReadOpenRequestV1Schema,
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
        agentTargetKey: 'backend:claude',
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
        activationGeneration: 'provider-p',
        immutableGenerationId: 'provider-p',
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
            immutableGenerationId: 'immutable-generation-one',
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
            method: 'POST',
            bodyBase64: Buffer.from('{"hello":true}').toString('base64'),
            timeoutMs: 10_000,
        }).success).toBe(true);
        expect(ManagedServiceEndpointReadOpenRequestV1Schema.safeParse({
            ...common,
            route: endpointProjectionRoute(),
        }).success).toBe(true);

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
