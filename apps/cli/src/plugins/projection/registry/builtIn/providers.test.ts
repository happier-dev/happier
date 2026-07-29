import { createPluginContributionIdentity } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { ResolvedProviderContribution } from '../types';
import { projectBuiltInProviders } from './providers';

function provider(
    provenance: ResolvedProviderContribution['provenance'] = 'first_party',
): ResolvedProviderContribution {
    return {
        provenance,
        source: { kind: provenance === 'first_party' ? 'bundled' : 'path' },
        pluginId: 'happier.provider.example',
        identity: createPluginContributionIdentity({
            pluginId: 'happier.provider.example',
            localId: 'example',
        }),
        definition: {
            v: 1,
            id: 'example',
            name: 'Example',
            kind: 'cloud',
            endpointTemplates: [{
                id: 'api',
                protocol: 'openai-chat',
                baseUrl: 'https://example.test/v1',
                capabilities: {
                    streaming: 'unknown',
                    toolRoundTrips: 'unknown',
                    statefulResponses: 'unknown',
                    reasoningControls: 'unknown',
                },
            }],
            catalog: {
                source: 'static',
                manualModelPolicy: 'allowed',
                staticModels: [{ id: 'example', name: 'Example' }],
            },
        },
    };
}

const managedFacet = {
    managedEndpoint: {
        localService: {
            id: 'gateway',
            launch: {
                kind: 'packaged-runtime-binary' as const,
                directorySegments: ['tools', 'unpacked'],
                executableBaseName: 'gateway',
                privateConfigPathFlag: '--config',
            },
            launchMode: {
                kind: 'assignAndInject' as const,
                portPolicy: { kind: 'allocated' as const },
            },
            hostPolicy: { kind: 'loopback' as const },
            name: { strategy: 'fixed' as const, name: 'Gateway' },
            healthCheck: { kind: 'http' as const, path: '/healthz' },
            restart: { kind: 'never' as const },
            cleanup: { staleAfterMs: 60_000 },
        },
        protocols: ['openai-chat' as const],
    },
    connectedAccounts: [{
        purpose: 'upstream',
        service: {
            pluginId: 'happier.connected-account.example',
            localId: 'example',
        },
        required: true,
        materializationKinds: ['httpHeaders' as const],
    }],
    requestAuthUses: [{
        purpose: 'upstream',
        materialization: {
            kind: 'httpHeaders' as const,
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        },
    }],
} as const;
const managedRuntimeAdapter = Object.freeze({
    v: 1 as const,
    catalogSource: Object.freeze({
        kind: 'transientModelEndpoint' as const,
        contractVersion: 'happier.example-managed/v1',
        sdkVersion: 'v1.2.3',
    }),
    prepare: async () => {
        throw new Error('not used by projection test');
    },
    inspectRecovery: async () => null,
    verifyRecoveryHealth: () => true,
    resolveAgentEndpoint: () => 'http://127.0.0.1:45123/v1',
});

describe('built-in Provider projection overlays', () => {
    it('attaches a validated host-private managed facet only through an exact Provider binding', () => {
        const manifestProvider = provider();
        const projected = projectBuiltInProviders({
            manifestProviders: [manifestProvider],
            implementationBindings: [{
                identity: manifestProvider.identity,
                implementationOwnerId: 'happier.provider.example/example',
                registrationFamily: 'providers',
                implementation: managedFacet,
                runtimeAdapter: managedRuntimeAdapter,
            }],
        });

        expect(projected).toEqual([{
            ...manifestProvider,
            managed: managedFacet,
            managedRuntimeAdapter,
        }]);
    });

    it('qualifies managed connected-account service references once at the Provider projection owner', () => {
        const manifestProvider = provider();
        const projected = projectBuiltInProviders({
            manifestProviders: [manifestProvider],
            implementationBindings: [{
                identity: manifestProvider.identity,
                implementationOwnerId: 'happier.provider.example/example',
                registrationFamily: 'providers',
                implementation: {
                    ...managedFacet,
                    connectedAccounts: [{
                        purpose: 'upstream',
                        service: 'local-account',
                        required: true,
                        materializationKinds: ['httpHeaders'],
                    }],
                },
                runtimeAdapter: managedRuntimeAdapter,
            }],
        });

        expect(projected[0]?.managed?.connectedAccounts).toEqual([{
            purpose: 'upstream',
            service: {
                pluginId: 'happier.provider.example',
                localId: 'local-account',
            },
            required: true,
            materializationKinds: ['httpHeaders'],
        }]);
    });

    it('accepts only the exact paired managed runtime recovery capability', () => {
        const manifestProvider = provider();
        const projectRuntimeAdapter = (runtimeAdapter: unknown) => projectBuiltInProviders({
            manifestProviders: [manifestProvider],
            implementationBindings: [{
                identity: manifestProvider.identity,
                implementationOwnerId: 'happier.provider.example/example',
                registrationFamily: 'providers',
                implementation: managedFacet,
                runtimeAdapter,
            }],
        });

        const withoutRecovery = projectRuntimeAdapter({
            v: managedRuntimeAdapter.v,
            catalogSource: managedRuntimeAdapter.catalogSource,
            prepare: managedRuntimeAdapter.prepare,
            resolveAgentEndpoint: managedRuntimeAdapter.resolveAgentEndpoint,
        })[0]?.managedRuntimeAdapter;
        expect(withoutRecovery).not.toHaveProperty('inspectRecovery');
        expect(withoutRecovery).not.toHaveProperty('verifyRecoveryHealth');

        expect(() => projectRuntimeAdapter({
            ...managedRuntimeAdapter,
            inspectRecovery: 'not-a-function',
        })).toThrow(/runtime adapter/i);
        expect(() => projectRuntimeAdapter({
            ...managedRuntimeAdapter,
            verifyRecoveryHealth: 'not-a-function',
        })).toThrow(/runtime adapter/i);
        expect(() => projectRuntimeAdapter({
            v: managedRuntimeAdapter.v,
            catalogSource: managedRuntimeAdapter.catalogSource,
            prepare: managedRuntimeAdapter.prepare,
            inspectRecovery: managedRuntimeAdapter.inspectRecovery,
            resolveAgentEndpoint: managedRuntimeAdapter.resolveAgentEndpoint,
        })).toThrow(/runtime adapter/i);
        expect(() => projectRuntimeAdapter({
            ...managedRuntimeAdapter,
            unexpected: true,
        })).toThrow(/runtime adapter/i);
    });

    it('fails closed for external provenance, malformed facets, and orphan bindings', () => {
        const external = provider('external');
        expect(() => projectBuiltInProviders({
            manifestProviders: [external],
            implementationBindings: [{
                identity: external.identity,
                implementationOwnerId: 'happier.provider.example/example',
                registrationFamily: 'providers',
                implementation: managedFacet,
                runtimeAdapter: managedRuntimeAdapter,
            }],
        })).toThrow(/first-party bundled Provider/);

        const manifestProvider = provider();
        expect(() => projectBuiltInProviders({
            manifestProviders: [manifestProvider],
            implementationBindings: [{
                identity: manifestProvider.identity,
                implementationOwnerId: 'happier.provider.example/example',
                registrationFamily: 'providers',
                implementation: {
                    ...managedFacet,
                    managedEndpoint: {
                        ...managedFacet.managedEndpoint,
                        protocols: [],
                    },
                },
                runtimeAdapter: managedRuntimeAdapter,
            }],
        })).toThrow(/Invalid bundled managed Provider implementation/);

        expect(() => projectBuiltInProviders({
            manifestProviders: [manifestProvider],
            implementationBindings: [{
                identity: manifestProvider.identity,
                implementationOwnerId: 'happier.provider.example/example',
                registrationFamily: 'providers',
                implementation: {
                    ...managedFacet,
                    requestAuthUses: [{
                        purpose: 'different-purpose',
                        materialization:
                            managedFacet.requestAuthUses[0].materialization,
                    }],
                },
                runtimeAdapter: managedRuntimeAdapter,
            }],
        })).toThrow(/Invalid bundled managed Provider implementation/);

        expect(() => projectBuiltInProviders({
            manifestProviders: [],
            implementationBindings: [{
                identity: manifestProvider.identity,
                implementationOwnerId: 'happier.provider.example/example',
                registrationFamily: 'providers',
                implementation: managedFacet,
                runtimeAdapter: managedRuntimeAdapter,
            }],
        })).toThrow(/Missing bundled manifest Provider/);

        expect(() => projectBuiltInProviders({
            manifestProviders: [manifestProvider],
            implementationBindings: [{
                identity: manifestProvider.identity,
                implementationOwnerId: 'happier.provider.example/example',
                registrationFamily: 'providers',
                implementation: managedFacet,
                runtimeAdapter: {
                    v: 1,
                    prepare: managedRuntimeAdapter.prepare,
                },
            }],
        })).toThrow(/runtime adapter/i);
    });
});
