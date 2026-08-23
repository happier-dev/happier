import { describe, expect, it, vi } from 'vitest';
import {
    PluginConnectedAccountDescriptorContributionV2Schema,
    PluginHostAccessRequestV2Schema,
} from '@happier-dev/protocol';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';

import { createUnavailablePluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';
import {
    bindConnectedAccountConfiguredOrigins,
    matchesConnectedAccountOriginTarget,
    resolveHostOwnedConnectedAccountConfiguredEndpoints,
    resolveHostOwnedConnectedAccountConfiguredOrigins,
    resolveConnectedAccountConfiguredOrigins,
} from './configuredOrigins';

const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });

// DNS is the only system boundary this owner reaches. Every fixture name below
// resolves through it, so the private-network decision is exercised by resolved
// addresses rather than by the hostname's spelling.
const RESOLVED_ADDRESSES_BY_HOSTNAME: Readonly<Record<string, readonly string[]>> = Object.freeze({
    'api.example.test': ['93.184.216.34'],
    'static.example.test': ['93.184.216.35'],
    'other.example.test': ['93.184.216.36'],
    'dev.azure.test': ['93.184.216.37'],
    'server.example.test': ['93.184.216.38'],
    'attacker.invalid': ['93.184.216.39'],
    'localhost': ['127.0.0.1'],
    // A self-hosted deployment whose public-looking name resolves inside RFC 1918.
    'git.internal.example': ['10.0.0.7'],
});
const resolveNetworkAddresses = async (hostname: string): Promise<readonly string[]> => {
    const addresses = RESOLVED_ADDRESSES_BY_HOSTNAME[hostname];
    if (!addresses) throw new Error(`unexpected DNS lookup for ${hostname}`);
    return addresses;
};
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

function baseDescriptor() {
    return PluginConnectedAccountDescriptorContributionV2Schema.parse({
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
                        id: 'service-base',
                        title: 'Service base',
                        schema: { type: 'string', minLength: 1 },
                        required: true,
                        semantic: 'connectedAccountBase',
                    }],
                },
            }],
        },
    });
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

    it('derives one declared fixed origin from a closed configuration choice', () => {
        const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
            id: service.localId,
            title: 'Acme Work',
            authentication: {
                defaultModeId: 'manual',
                modes: [{
                    id: 'manual',
                    kind: 'manual',
                    outcomeReconciliation: 'none',
                    fields: [{
                        id: 'token',
                        title: 'Token',
                        secret: true,
                        schema: { type: 'string', minLength: 1 },
                    }],
                    configuration: {
                        scope: 'account',
                        changeBehavior: 'reconnect',
                        fields: [{
                            id: 'region',
                            title: 'Region',
                            semantic: 'connectedAccountFixedOrigin',
                            required: true,
                            schema: { type: 'string', enum: ['us', 'de'] },
                            originByValue: {
                                us: 'https://us.example.test',
                                de: 'https://de.example.test',
                            },
                        }],
                    },
                }],
            },
        });
        const account = Object.freeze({
            kind: 'account' as const,
            account: Object.freeze({ service, accountId: 'account-1' }),
            modeId: 'manual',
        });
        const configured = (region: string) => Object.freeze({
            ...configuration,
            target: account,
            values: Object.freeze({ region }),
        });

        expect(resolveHostOwnedConnectedAccountConfiguredOrigins({
            service,
            descriptor,
            configuration: configured('de'),
        })).toEqual(['https://de.example.test']);
        expect(resolveHostOwnedConnectedAccountConfiguredOrigins({
            service,
            descriptor,
            configuration: configured('us'),
        })).toEqual(['https://us.example.test']);
        // The choice is never the route: an unpublished choice resolves to no
        // origin at all rather than to a value a caller could reach.
        expect(() => resolveHostOwnedConnectedAccountConfiguredOrigins({
            service,
            descriptor,
            configuration: configured('jp'),
        })).toThrow(/region/u);
        expect(() => resolveHostOwnedConnectedAccountConfiguredOrigins({
            service,
            descriptor,
            configuration: configured('https://attacker.invalid'),
        })).toThrow(/region/u);
    });

    it('projects both the network origin and the configured service base from a path-prefixed base field', () => {
        const configured = (value: string) => Object.freeze({
            ...configuration,
            values: Object.freeze({ 'service-base': value }),
        });

        expect(resolveHostOwnedConnectedAccountConfiguredEndpoints({
            service,
            descriptor: baseDescriptor(),
            configuration: configured('https://dev.azure.test/acme'),
        })).toEqual([{
            origin: 'https://dev.azure.test',
            base: 'https://dev.azure.test/acme',
        }]);
        // A trailing slash is normalization, not a different deployment, and the
        // path case is preserved because a collection segment is case-bearing.
        expect(resolveHostOwnedConnectedAccountConfiguredEndpoints({
            service,
            descriptor: baseDescriptor(),
            configuration: configured('https://server.example.test/tfs/DefaultCollection/'),
        })).toEqual([{
            origin: 'https://server.example.test',
            base: 'https://server.example.test/tfs/DefaultCollection',
        }]);
        // HostAccess keeps governing by the origin alone: the base never widens
        // or narrows the admitted network target.
        expect(resolveHostOwnedConnectedAccountConfiguredOrigins({
            service,
            descriptor: baseDescriptor(),
            configuration: configured('https://dev.azure.test/acme'),
        })).toEqual(['https://dev.azure.test']);
    });

    it('projects a configured base as routing facts only, with no network-policy decision', () => {
        const configured = (value: string) => Object.freeze({
            ...configuration,
            values: Object.freeze({ 'service-base': value }),
        });

        expect(resolveHostOwnedConnectedAccountConfiguredEndpoints({
            service,
            descriptor: baseDescriptor(),
            configuration: configured('https://192.168.4.7/tfs/DefaultCollection'),
        })).toEqual([{
            origin: 'https://192.168.4.7',
            base: 'https://192.168.4.7/tfs/DefaultCollection',
        }]);
        // The path is routing, never a network-policy input.
        expect(resolveHostOwnedConnectedAccountConfiguredEndpoints({
            service,
            descriptor: baseDescriptor(),
            configuration: configured('https://dev.azure.test/127.0.0.1'),
        })).toEqual([{
            origin: 'https://dev.azure.test',
            base: 'https://dev.azure.test/127.0.0.1',
        }]);
    });

    it.each([
        'https://user:secret@dev.azure.test/acme',
        'http://dev.azure.test/acme',
        'https://dev.azure.test/acme?project=secret',
        'https://dev.azure.test/acme#fragment',
        'https://dev.azure.test/acme/../elsewhere',
        'https://DEV.azure.test/acme',
        'dev.azure.test/acme',
    ])('rejects a configured base that is not an exact credential-free HTTPS service base (%s)', (value) => {
        expect(() => resolveHostOwnedConnectedAccountConfiguredEndpoints({
            service,
            descriptor: baseDescriptor(),
            configuration: Object.freeze({
                ...configuration,
                values: Object.freeze({ 'service-base': value }),
            }),
        })).toThrow(/configured base/iu);
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
            resolveNetworkAddresses,
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
                authority: 'selectedResource',
                accessId: 'write',
                required: true,
                origins: ['https://api.example.test', 'https://static.example.test'],
                methods: ['POST'],
                privateNetwork: false,
                connectedAccountService: service,
            },
            {
                authority: 'selectedResource',
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
            resolveNetworkAddresses,
        })).rejects.toThrow(/configured origin/i);
    });

    it('projects a current same-plugin network.client origin only into the exact websocket binding', async () => {
        const resolveHostOwnedConfiguredOrigins = vi.fn(() => ['https://api.example.test']);
        const configurationRevocation = new AbortController();
        const resolution = await resolveConnectedAccountConfiguredOrigins({
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
            resolveNetworkAddresses,
            configurationRevocationSignal: configurationRevocation.signal,
        });
        const binding = bindConnectedAccountConfiguredOrigins(
            createUnavailablePluginInvocationServiceBinding('process-4', 'producer'),
            resolution,
        );

        expect(resolveHostOwnedConfiguredOrigins).toHaveBeenCalledOnce();
        expect(binding.networkScopes).toBeUndefined();
        expect(binding.networkClientScopes).toEqual([{
            authority: 'selectedResource',
            accessId: 'client',
            required: true,
            origins: ['https://api.example.test'],
            transports: ['websocket'],
            privateNetwork: false,
            connectedAccountService: service,
        }]);
        expect(await binding.networkCurrentness?.()).toBe(true);
        expect((binding as typeof binding & Readonly<{
            networkRevocationSignal?: AbortSignal;
        }>).networkRevocationSignal).toBe(configurationRevocation.signal);
    });

    it('projects a private configured WebSocket origin only with explicit network.client private-network intent', async () => {
        const request = (privateNetwork: boolean) => PluginHostAccessRequestV2Schema.parse({
            id: privateNetwork ? 'private-client-allowed' : 'private-client-denied',
            capability: 'network.client',
            reason: 'Maintain a configured private gateway connection',
            scope: {
                targets: [{ kind: 'connectedAccountOrigin', service }],
                transports: ['websocket'],
                ...(privateNetwork ? { privateNetwork: true } : {}),
            },
        });
        const resolve = async (privateNetwork: boolean) => await resolveConnectedAccountConfiguredOrigins({
            pluginId: 'acme.accounts',
            service,
            generation: 'process-private-client',
            configuration,
            hostAccessRequests: [{
                request: request(privateNetwork),
                required: true,
                status: 'available' as const,
            }],
            resolveHostOwnedConfiguredOrigins: () => ['https://localhost:4311'],
            isConfigurationCurrent: () => true,
            isGenerationCurrent: () => true,
            resolveNetworkAddresses,
        });

        await expect(resolve(true)).resolves.toMatchObject({
            networkClientScopes: [{
                accessId: 'private-client-allowed',
                origins: ['https://localhost:4311'],
                transports: ['websocket'],
                privateNetwork: true,
            }],
        });
        await expect(resolve(false)).rejects.toThrow(/no allowed origin/i);
    });
    it('refuses a configured origin that RESOLVES private unless the grant declares private-network access', async () => {
        // `git.internal.example` is a public-looking name; only its A record says
        // 10.0.0.7. The literal hostname carries no evidence of that, so a
        // spelling-based decision admits the origin and routes the account
        // credential into the private network under a grant that never asked.
        const resolve = async (privateNetwork: boolean) => await resolveConnectedAccountConfiguredOrigins({
            pluginId: 'acme.accounts',
            service,
            generation: 'process-resolved-private',
            configuration,
            hostAccessRequests: [networkRequest({
                id: privateNetwork ? 'resolved-private-allowed' : 'resolved-private-denied',
                ...(privateNetwork ? { privateNetwork: true } : {}),
            })],
            resolveHostOwnedConfiguredOrigins: () => ['https://git.internal.example'],
            isConfigurationCurrent: () => true,
            isGenerationCurrent: () => true,
            resolveNetworkAddresses,
        });

        await expect(resolve(false)).rejects.toThrow(/no allowed origin/i);
        await expect(resolve(true)).resolves.toMatchObject({
            networkScopes: [{
                accessId: 'resolved-private-allowed',
                origins: ['https://git.internal.example'],
                privateNetwork: true,
            }],
        });
    });

    it('refuses a manifest fixedOrigin that resolves private unless the grant declares private-network access', async () => {
        const resolve = async (privateNetwork: boolean) => await resolveConnectedAccountConfiguredOrigins({
            pluginId: 'acme.accounts',
            service,
            generation: 'process-resolved-private-fixed',
            configuration,
            hostAccessRequests: [networkRequest({
                id: privateNetwork ? 'fixed-private-allowed' : 'fixed-private-denied',
                fixedOrigin: 'https://git.internal.example',
                ...(privateNetwork ? { privateNetwork: true } : {}),
            })],
            resolveHostOwnedConfiguredOrigins: () => [],
            isConfigurationCurrent: () => true,
            isGenerationCurrent: () => true,
            resolveNetworkAddresses,
        });

        await expect(resolve(false)).rejects.toThrow(/no allowed origin/i);
        await expect(resolve(true)).resolves.toMatchObject({
            networkScopes: [{
                origins: ['https://git.internal.example'],
                privateNetwork: true,
            }],
        });
    });
});
