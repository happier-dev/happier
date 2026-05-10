import { describe, expect, it } from 'vitest';

import { createScmHostingProviderRegistry } from './registry.js';

type RoutingRegistryApi = Readonly<{
    detectRemote(input: Readonly<{ remoteName: string | null; remoteUrl: string }>): Readonly<{
        kind: 'resolved';
        providerId: string;
        provider: Readonly<Record<string, unknown>>;
    }> | Readonly<{
        kind: 'unknown';
        provider: Readonly<Record<string, unknown>>;
    }>;
    buildCompareUrl(input: Readonly<{
        provider: Readonly<Record<string, unknown>>;
        base: string;
        head: string;
    }>): Readonly<Record<string, unknown>>;
}>;

describe('createScmHostingProviderRegistry', () => {
    it('combines static descriptors with same-id runtime adapter registrations', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [
                {
                    id: 'acme.scm.github',
                    kind: 'github',
                    displayName: 'Acme GitHub',
                    baseUrl: 'https://github.example.com',
                    remoteHostMatchers: {
                        exactHosts: ['github.example.com'],
                    },
                    urlSafety: {
                        allowedSchemes: ['https:'],
                        allowedBaseUrls: ['https://github.example.com'],
                        allowedOrigins: ['https://github.example.com'],
                    },
                    pluginId: 'acme.scm',
                },
            ],
            runtimeRegistrations: [
                {
                    pluginId: 'acme.scm',
                    registration: {
                        id: 'acme.scm.github',
                        adapter: {},
                    },
                },
            ],
        });

        expect(registry.getProvider('acme.scm.github')).toEqual(expect.objectContaining({
            id: 'acme.scm.github',
            runtime: expect.objectContaining({
                pluginId: 'acme.scm',
            }),
            remoteHostMatchers: {
                exactHosts: ['github.example.com'],
            },
            urlSafety: {
                allowedSchemes: ['https:'],
                allowedBaseUrls: ['https://github.example.com'],
                allowedOrigins: ['https://github.example.com'],
            },
        }));
        expect(registry.getAdapter('acme.scm.github')).toEqual({});
    });

    it('returns structured unknown routing diagnostics without falling back to a provider adapter', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [
                {
                    id: 'acme.scm',
                    kind: 'custom',
                    displayName: 'Acme SCM',
                    baseUrl: 'https://scm.example.com',
                    remoteHostMatchers: {
                        exactHosts: ['scm.example.com'],
                    },
                    urlSafety: {
                        allowedSchemes: ['https:'],
                        allowedBaseUrls: ['https://scm.example.com'],
                        allowedOrigins: ['https://scm.example.com'],
                    },
                    pluginId: 'acme.scm',
                },
            ],
            runtimeRegistrations: [
                {
                    pluginId: 'acme.scm',
                    registration: {
                        id: 'acme.scm',
                        adapter: {
                            detectRemote(input: Readonly<{ remoteUrl: string }>) {
                                if (input.remoteUrl.includes('scm.example.com')) {
                                    return {
                                        id: 'acme.scm',
                                        kind: 'custom',
                                        displayName: 'Acme SCM',
                                        baseUrl: 'https://scm.example.com',
                                        nameWithOwner: 'team/repo',
                                    };
                                }
                                return null;
                            },
                            buildCompareUrl() {
                                return 'https://scm.example.com/team/repo/compare/main...feature';
                            },
                        },
                    },
                },
            ],
        });

        const routingRegistry = registry as typeof registry & Readonly<{
            detectRemote?: unknown;
            buildCompareUrl?: unknown;
        }>;

        expect(typeof routingRegistry.detectRemote).toBe('function');
        expect(typeof routingRegistry.buildCompareUrl).toBe('function');
        if (
            typeof routingRegistry.detectRemote !== 'function'
            || typeof routingRegistry.buildCompareUrl !== 'function'
        ) {
            return;
        }
        const resolvedRoutingRegistry = routingRegistry as typeof registry & RoutingRegistryApi;

        const detected = resolvedRoutingRegistry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'https://unknown.example.com/team/repo.git',
        });

        expect(detected).toEqual({
            kind: 'unknown',
            provider: {
                id: 'unknown',
                kind: 'unknown',
                displayName: 'Unknown SCM hosting provider',
                remoteName: 'origin',
                unsupportedReason: 'no_registered_provider_detected',
            },
        });
        expect(resolvedRoutingRegistry.buildCompareUrl({
            provider: detected.provider,
            base: 'main',
            head: 'feature',
        })).toEqual({
            kind: 'unsupported',
            reason: 'unknown_provider',
            provider: detected.provider,
        });
    });

    it('emits diagnostics and ignores runtime registrations without a static descriptor', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [],
            runtimeRegistrations: [
                {
                    pluginId: 'acme.scm',
                    registration: {
                        id: 'acme.scm.missing',
                        adapter: {},
                    },
                },
            ],
        });

        expect(registry.getProvider('acme.scm.missing')).toBeUndefined();
        expect(registry.diagnostics).toEqual([
            expect.objectContaining({
                code: 'scm_hosting_provider_registration_missing_descriptor',
                pluginId: 'acme.scm',
                providerId: 'acme.scm.missing',
            }),
        ]);
    });

    it('keeps the first static descriptor active when provider ids conflict', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [
                {
                    id: 'scm.github',
                    kind: 'github',
                    displayName: 'GitHub',
                    baseUrl: 'https://github.com',
                    remoteHostMatchers: {
                        exactHosts: ['github.com'],
                    },
                    urlSafety: {
                        allowedSchemes: ['https:'],
                        allowedBaseUrls: ['https://github.com'],
                        allowedOrigins: ['https://github.com'],
                    },
                    pluginId: 'happier.scm.github',
                },
                {
                    id: 'scm.github',
                    kind: 'github',
                    displayName: 'Shadow GitHub',
                    baseUrl: 'https://github.shadow.example.com',
                    remoteHostMatchers: {
                        exactHosts: ['github.shadow.example.com'],
                    },
                    urlSafety: {
                        allowedSchemes: ['https:'],
                        allowedBaseUrls: ['https://github.shadow.example.com'],
                        allowedOrigins: ['https://github.shadow.example.com'],
                    },
                    pluginId: 'acme.shadow',
                },
            ],
        });

        expect(registry.getProvider('scm.github')).toEqual(expect.objectContaining({
            pluginId: 'happier.scm.github',
            displayName: 'GitHub',
        }));
        expect(registry.providers).toHaveLength(1);
        expect(registry.diagnostics).toEqual([
            expect.objectContaining({
                code: 'scm_hosting_provider_duplicate',
                pluginId: 'acme.shadow',
                providerId: 'scm.github',
            }),
        ]);
    });

    it('keeps the first runtime registration active when runtime provider ids conflict', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [
                {
                    id: 'acme.scm.github',
                    kind: 'github',
                    displayName: 'Acme GitHub',
                    baseUrl: 'https://github.example.com',
                    remoteHostMatchers: {
                        exactHosts: ['github.example.com'],
                    },
                    urlSafety: {
                        allowedSchemes: ['https:'],
                        allowedBaseUrls: ['https://github.example.com'],
                        allowedOrigins: ['https://github.example.com'],
                    },
                    pluginId: 'acme.scm',
                },
            ],
            runtimeRegistrations: [
                {
                    pluginId: 'acme.scm',
                    registration: {
                        id: 'acme.scm.github',
                        adapter: { selected: 'first' },
                    },
                },
                {
                    pluginId: 'acme.scm',
                    registration: {
                        id: 'acme.scm.github',
                        adapter: { selected: 'second' },
                    },
                },
            ],
        });

        expect(registry.getAdapter('acme.scm.github')).toEqual({ selected: 'first' });
        expect(registry.diagnostics).toEqual([
            expect.objectContaining({
                code: 'scm_hosting_provider_duplicate',
                pluginId: 'acme.scm',
                providerId: 'acme.scm.github',
            }),
        ]);
    });
});
