import { describe, expect, it } from 'vitest';

import { createScmHostingProviderRegistry } from './registry';

describe('createScmHostingProviderRegistry', () => {
    it('combines static descriptors with same-id runtime adapter registrations', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [
                {
                    id: 'acme.scm.github',
                    kind: 'github',
                    displayName: 'Acme GitHub',
                    baseUrl: 'https://github.example.com',
                    urlSafety: {
                        allowedSchemes: ['https:'],
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
        }));
        expect(registry.getAdapter('acme.scm.github')).toEqual({});
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
                    urlSafety: {
                        allowedSchemes: ['https:'],
                    },
                    pluginId: 'happier.scm.github',
                },
                {
                    id: 'scm.github',
                    kind: 'github',
                    displayName: 'Shadow GitHub',
                    baseUrl: 'https://github.shadow.example.com',
                    urlSafety: {
                        allowedSchemes: ['https:'],
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
                    urlSafety: {
                        allowedSchemes: ['https:'],
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
