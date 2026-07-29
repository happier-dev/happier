import { describe, expect, it, vi } from 'vitest';
import {
    PluginConnectedAccountDescriptorContributionV2Schema,
    PluginHostAccessRequestV2Schema,
} from '@happier-dev/protocol';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk/runtime';

import { createUnavailablePluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';
import {
    bindConnectedAccountConfiguredOrigins,
    matchesConnectedAccountOriginTarget,
    resolveHostOwnedConnectedAccountConfiguredOrigins,
    resolveConnectedAccountConfiguredOrigins,
} from './configuredOrigins';

const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });
const configuration = Object.freeze({
    target: Object.freeze({ kind: 'service' as const, service, modeId: 'oauth' }),
    revision: 'configuration-7',
    values: Object.freeze({ endpoint: 'https://API.EXAMPLE.test/' }),
    getSecret: async () => null,
});

function networkRequest(input: Readonly<{
    id: string;
    pluginId?: string;
    service?: PluginContributionRef;
    fixedOrigin?: string;
    methods?: readonly ('GET' | 'POST')[];
    privateNetwork?: boolean;
}>) {
    const targetService = input.service ?? service;
    return {
        request: PluginHostAccessRequestV2Schema.parse({
            id: input.id,
            capability: 'network',
            reason: 'Connected Account provider access',
            scope: {
                targets: [
                    { kind: 'connectedAccountOrigin', service: targetService },
                    ...(input.fixedOrigin
                        ? [{ kind: 'fixedOrigin' as const, origin: input.fixedOrigin }]
                        : []),
                ],
                ...(input.methods ? { methods: input.methods } : {}),
                ...(input.privateNetwork ? { privateNetwork: true } : {}),
            },
        }),
        required: true,
        status: 'available' as const,
    };
}

describe('connected-account configured origins', () => {
    it('matches local and explicitly self-qualified connected-account origin targets identically', () => {
        const target = (
            targetService: string | PluginContributionRef,
        ) => {
            const request = PluginHostAccessRequestV2Schema.parse({
                id: 'connected-account-network',
                capability: 'network',
                reason: 'Connected Account provider access',
                scope: {
                    targets: [{
                        kind: 'connectedAccountOrigin',
                        service: targetService,
                    }],
                },
            });
            if (request.capability !== 'network') {
                throw new Error('Expected a network HostAccess request');
            }
            const candidate = request.scope.targets[0];
            if (candidate?.kind !== 'connectedAccountOrigin') {
                throw new Error('Expected a connected-account origin target');
            }
            return candidate;
        };

        expect(matchesConnectedAccountOriginTarget(
            service.pluginId,
            service,
            target(service.localId),
        )).toBe(true);
        expect(matchesConnectedAccountOriginTarget(
            service.pluginId,
            service,
            target(service),
        )).toBe(true);
        expect(matchesConnectedAccountOriginTarget(
            service.pluginId,
            service,
            target({ ...service, localId: 'other' }),
        )).toBe(false);
    });

    it('derives only descriptor-typed origins from the exact current mode snapshot', () => {
        const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
            id: service.localId,
            title: 'Acme Work',
            authentication: {
                defaultModeId: 'oauth',
                modes: [{
                    id: 'oauth',
                    kind: 'oauthAuthorizationCode',
                    pkce: 'required',
                    outcomeReconciliation: 'none',
                    configuration: {
                        scope: 'service',
                        changeBehavior: 'refresh',
                        fields: [{
                            id: 'api-origin',
                            title: 'API origin',
                            schema: { type: 'string', minLength: 1 },
                            required: true,
                            semantic: 'connectedAccountOrigin',
                        }, {
                            id: 'unrelated-url',
                            title: 'Unrelated URL',
                            schema: { type: 'string' },
                        }],
                    },
                }],
            },
        });
        const configured = Object.freeze({
            ...configuration,
            values: Object.freeze({
                'api-origin': 'https://api.example.test',
                'unrelated-url': 'https://attacker.invalid',
            }),
        });

        expect(resolveHostOwnedConnectedAccountConfiguredOrigins({
            service,
            descriptor,
            configuration: configured,
        })).toEqual(['https://api.example.test']);
    });

    it('deterministically unions every exact same-plugin network request and binds one currentness fence', async () => {
        let configurationCurrent = true;
        let generationCurrent = true;
        const resolution = await resolveConnectedAccountConfiguredOrigins({
            pluginId: 'acme.accounts',
            service,
            generation: 'process-4',
            configuration,
            hostAccessRequests: [
                networkRequest({
                    id: 'write',
                    fixedOrigin: 'https://static.example.test',
                    methods: ['POST'],
                }),
                networkRequest({ id: 'read', methods: ['GET'] }),
                {
                    ...networkRequest({
                        id: 'other',
                        service: { pluginId: 'acme.accounts', localId: 'other' },
                    }),
                },
            ],
            resolveHostOwnedConfiguredOrigins: () => [
                'https://api.example.test',
                'https://api.example.test',
            ],
            isConfigurationCurrent: () => configurationCurrent,
            isGenerationCurrent: () => generationCurrent,
        });
        const binding = bindConnectedAccountConfiguredOrigins(
            createUnavailablePluginInvocationServiceBinding('process-4', 'producer'),
            resolution,
        );

        expect(binding.networkOrigins).toEqual([
            'https://api.example.test',
            'https://static.example.test',
        ]);
        expect(binding.networkScopes).toEqual([
            {
                accessId: 'write',
                required: true,
                origins: ['https://api.example.test', 'https://static.example.test'],
                methods: ['POST'],
                privateNetwork: false,
                connectedAccountService: service,
            },
            {
                accessId: 'read',
                required: true,
                origins: ['https://api.example.test'],
                methods: ['GET'],
                privateNetwork: false,
                connectedAccountService: service,
            },
        ]);
        expect(await binding.networkCurrentness?.()).toBe(true);
        configurationCurrent = false;
        expect(await binding.networkCurrentness?.()).toBe(false);
        configurationCurrent = true;
        generationCurrent = false;
        expect(await binding.networkCurrentness?.()).toBe(false);
    });

    it.each([
        'https://user:secret@api.example.test',
        'http://api.example.test',
        'https://api.example.test/v1',
    ])('rejects a configured value that is not an exact credential-free HTTPS origin (%s)', async (origin) => {
        await expect(resolveConnectedAccountConfiguredOrigins({
            pluginId: 'acme.accounts',
            service,
            generation: 'process-4',
            configuration,
            hostAccessRequests: [networkRequest({ id: 'read' })],
            resolveHostOwnedConfiguredOrigins: () => [origin],
            isConfigurationCurrent: () => true,
            isGenerationCurrent: () => true,
        })).rejects.toThrow(/configured origin/i);
    });

    it('fails closed when only consumer or cross-service authority exists', async () => {
        const resolveHostOwnedConfiguredOrigins = vi.fn(() => ['https://api.example.test']);
        await expect(resolveConnectedAccountConfiguredOrigins({
            pluginId: 'acme.accounts',
            service,
            generation: 'process-4',
            configuration,
            hostAccessRequests: [{
                request: PluginHostAccessRequestV2Schema.parse({
                    id: 'client',
                    capability: 'network.client',
                    reason: 'Client-only access',
                    scope: {
                        targets: [{ kind: 'connectedAccountOrigin', service }],
                        transports: ['websocket'],
                    },
                }),
                required: true,
                status: 'available',
            }],
            resolveHostOwnedConfiguredOrigins,
            isConfigurationCurrent: () => true,
            isGenerationCurrent: () => true,
        })).rejects.toThrow(/unavailable/i);
        expect(resolveHostOwnedConfiguredOrigins).not.toHaveBeenCalled();
    });
});
