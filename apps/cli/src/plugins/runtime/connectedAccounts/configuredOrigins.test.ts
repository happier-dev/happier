import { describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
import {
    PluginConnectedAccountDescriptorContributionV2Schema,
} from '@happier-dev/protocol';

import { resolveHostOwnedConnectedAccountConfiguredEndpoints, resolveHostOwnedConnectedAccountConfiguredOrigins } from './configuredOrigins';

const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });

const configuration = Object.freeze({
    target: Object.freeze({ kind: 'service' as const, service, modeId: 'oauth' }),
    revision: 'configuration-7',
    values: Object.freeze({ endpoint: 'https://API.EXAMPLE.test/' }),
    getSecret: async () => null,
});

function baseDescriptor() {
    return PluginConnectedAccountDescriptorContributionV2Schema.parse({
        id: service.localId,
        title: 'Acme Work',
        authentication: {
            defaultModeId: 'oauth',
            modes: [{
                id: 'oauth',
                kind: 'oauthAuthorizationCode',
                callbackUrl: 'https://provider.example/oauth/callback',
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

    it('derives only descriptor-typed origins from the exact current mode snapshot', () => {
        const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
            id: service.localId,
            title: 'Acme Work',
            authentication: {
                defaultModeId: 'oauth',
                modes: [{
                    id: 'oauth',
                    kind: 'oauthAuthorizationCode',
                    callbackUrl: 'https://provider.example/oauth/callback',
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
            grantTargetKind: 'connectedAccountOrigin',
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
            grantTargetKind: 'connectedAccountOrigin',
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
            grantTargetKind: 'connectedAccountOrigin',
        }]);
        // The path is routing, never a network-policy input.
        expect(resolveHostOwnedConnectedAccountConfiguredEndpoints({
            service,
            descriptor: baseDescriptor(),
            configuration: configured('https://dev.azure.test/127.0.0.1'),
        })).toEqual([{
            origin: 'https://dev.azure.test',
            base: 'https://dev.azure.test/127.0.0.1',
            grantTargetKind: 'connectedAccountOrigin',
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
});
