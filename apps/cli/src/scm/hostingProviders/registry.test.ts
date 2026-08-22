import { describe, expect, it } from 'vitest';

import { ScmHostingProviderRefSchema } from '@happier-dev/protocol';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createPluginRegistrationScope } from '@happier-dev/plugin-sdk/host/registration';
import type { HostingProviderRuntimeRegistration as ScmHostingProviderRuntimeRegistration } from '@happier-dev/plugin-sdk/scm/hosting';

import type { ActivationTarget } from '../../plugins/runtime/lifecycle/activation/targets';
import { createTargetScmRuntimeEntries } from '../../plugins/runtime/lifecycle/contributions/targetScm';
import { readHostingProviderExecutionAuthority } from './executionAuthority';
import { createScmHostingProviderRegistry } from './registry';

type DetectedProviderFixture = NonNullable<
    ReturnType<NonNullable<ScmHostingProviderRuntimeRegistration['adapter']['detectRemote']>>
>;

function createRegistryWithDetectedProvider(
    detectedProvider: DetectedProviderFixture,
) {
    const registration: ScmHostingProviderRuntimeRegistration = {
        id: detectedProvider.id,
        adapter: {
            detectRemote: () => detectedProvider,
            buildCompareUrl: () => null,
        },
    };

    return createScmHostingProviderRegistry({
        providers: [{
            id: detectedProvider.id,
            pluginId: `happier.scm.${detectedProvider.id}`,
            kind: detectedProvider.kind,
            displayName: detectedProvider.displayName,
            capabilities: [],
        }],
        runtimeRegistrations: [{
            pluginId: `happier.scm.${detectedProvider.id}`,
            generation: 'test-generation',
            registration,
        }],
    });
}

describe('SCM hosting provider registry', () => {
    it('uses a committed hosting callback without reconstructing its runtime topology', () => {
        class Adapter {
            calls = 0;

            detectRemote() {
                this.calls += 1;
                return {
                    id: 'forge',
                    kind: 'forge',
                    displayName: 'Captured Forge',
                    baseUrl: 'https://forge.example.test',
                    authority: readHostingProviderExecutionAuthority(),
                };
            }
        }

        const adapter = new Adapter();
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.forge',
            target: { realm: 'daemon' },
            rights: [{
                family: 'scmHostingProviders',
                localId: 'forge',
                target: { realm: 'daemon' },
            }],
        });
        scope.api.scm.registerHostingProvider('forge', {
            adapter,
        } as unknown as Parameters<PluginApi['scm']['registerHostingProvider']>[1]);
        const [registration] = scope.commit();
        if (registration?.family !== 'scmHostingProviders') {
            throw new Error('Expected committed SCM hosting registration');
        }
        adapter.detectRemote = () => {
            throw new Error('The post-commit adapter method must not run');
        };
        const target = {
            pluginId: 'acme.forge',
            manifest: {
                contributes: {
                    scmBackends: [],
                    scmHostingProviders: [{ id: 'forge' }],
                },
            },
        } as unknown as ActivationTarget;
        let active = true;
        const runtimeEntries = createTargetScmRuntimeEntries({
            generation: 7,
            activationTargets: [target],
            targetRegistrations: [{
                pluginId: 'acme.forge',
                generation: '7',
                registration,
            }],
            isGenerationActive: () => active,
        });
        const registry = createScmHostingProviderRegistry({
            providers: [{
                id: 'forge',
                pluginId: 'acme.forge',
                kind: 'forge',
                displayName: 'Captured Forge',
                capabilities: [],
            }],
            runtimeRegistrations: runtimeEntries.hostingProviders,
        });

        const exposed = registry.getAdapter('acme.forge/forge');
        expect(exposed?.detectRemote?.({
            remoteName: 'origin',
            remoteUrl: 'https://forge.example.test/acme/repo',
        })).toMatchObject({
            id: 'forge',
            authority: {
                pluginId: 'acme.forge',
                generation: '7',
                contributionId: 'forge',
            },
        });
        expect(adapter.calls).toBe(1);

        active = false;
        expect(() => exposed?.detectRemote?.({
            remoteName: 'origin',
            remoteUrl: 'https://forge.example.test/acme/repo',
        })).toThrow(/no longer active/i);
        expect(adapter.calls).toBe(1);
    });

    it('reports the bound adapter structure to enumeration exactly as property access resolves it', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'forge',
            kind: 'forge',
            displayName: 'Forge',
            baseUrl: 'https://forge.example.test',
        });

        const exposed = registry.getAdapter('happier.scm.forge/forge');
        if (!exposed) throw new Error('Expected bound hosting adapter');

        expect(Object.keys(exposed)).toEqual(['detectRemote', 'buildCompareUrl']);
        expect(Object.keys({ ...exposed })).toEqual(['detectRemote', 'buildCompareUrl']);

        // Enumeration must hand back the authority-bound callable, not the raw one.
        const [enumeratedDetectRemote] = Object.values(exposed);
        expect(enumeratedDetectRemote).toBe(exposed.detectRemote);
        expect(enumeratedDetectRemote).toBeTypeOf('function');
    });

    it('keeps same-local-id providers from distinct plugins independently addressable', () => {
        const providers = ['one', 'two'].map((suffix) => ({
            id: 'shared',
            pluginId: `acme.scm.${suffix}`,
            kind: 'custom',
            displayName: `Forge ${suffix}`,
            capabilities: [],
        }));
        const runtimeRegistrations = ['one', 'two'].map((suffix) => ({
            pluginId: `acme.scm.${suffix}`,
            generation: '7',
            registration: {
                id: 'shared',
                adapter: {
                    detectRemote: () => null,
                },
            },
        }));
        const registry = createScmHostingProviderRegistry({ providers, runtimeRegistrations });

        expect(registry.providers.map((provider) => provider.id)).toEqual([
            'acme.scm.one/shared',
            'acme.scm.two/shared',
        ]);
        expect(registry.getAdapter('acme.scm.one/shared')).not.toBe(runtimeRegistrations[0]?.registration.adapter);
        expect(registry.getAdapter('acme.scm.two/shared')).not.toBe(runtimeRegistrations[1]?.registration.adapter);
        expect(registry.diagnostics).toEqual([]);
    });

    it('isolates a failing detection adapter and continues to the next provider', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [{
                id: 'broken',
                pluginId: 'acme.broken',
                kind: 'broken',
                displayName: 'Broken forge',
                capabilities: [],
            }, {
                id: 'working',
                pluginId: 'acme.working',
                kind: 'working',
                displayName: 'Working forge',
                capabilities: [],
            }],
            runtimeRegistrations: [{
                pluginId: 'acme.broken',
                generation: 'test-generation',
                registration: {
                    id: 'broken',
                    adapter: {
                        detectRemote() {
                            throw new Error('private adapter failure');
                        },
                    },
                },
            }, {
                pluginId: 'acme.working',
                generation: 'test-generation',
                registration: {
                    id: 'working',
                    adapter: {
                        detectRemote() {
                            return {
                                id: 'working',
                                kind: 'working',
                                displayName: 'Working forge',
                                baseUrl: 'https://working.example.test',
                            };
                        },
                    },
                },
            }],
        });

        expect(registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'https://working.example.test/acme/repo',
        })).toEqual(expect.objectContaining({
            kind: 'resolved',
            providerId: 'acme.working/working',
        }));
    });

    it('keeps the declared provider identity authoritative over runtime detection output', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [{
                id: 'declared',
                pluginId: 'acme.declared',
                kind: 'declared-kind',
                displayName: 'Declared forge',
                capabilities: [],
            }],
            runtimeRegistrations: [{
                pluginId: 'acme.declared',
                generation: 'test-generation',
                registration: {
                    id: 'declared',
                    adapter: {
                        detectRemote() {
                            return {
                                id: 'other-provider',
                                kind: 'other-kind',
                                displayName: 'Impersonated forge',
                                baseUrl: 'https://declared.example.test',
                            };
                        },
                    },
                },
            }],
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'https://declared.example.test/acme/repo',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider).toEqual(expect.objectContaining({
            id: 'acme.declared/declared',
            kind: 'unknown',
            providerKind: 'custom',
            displayName: 'Declared forge',
            urlSafety: {
                allowedSchemes: ['https:'],
                allowedBaseUrls: ['https://declared.example.test'],
                allowedOrigins: ['https://declared.example.test'],
            },
        }));
        expect(ScmHostingProviderRefSchema.safeParse(detected.provider).success).toBe(true);
    });

    it('rejects detected provider bases outside statically allowed base URLs', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [{
                id: 'bounded',
                pluginId: 'acme.bounded',
                kind: 'custom',
                displayName: 'Bounded forge',
                capabilities: [],
                urlSafety: {
                    allowedSchemes: ['https:'],
                    allowedBaseUrls: ['https://allowed.example.test/scm'],
                    allowedOrigins: ['https://allowed.example.test'],
                },
            }],
            runtimeRegistrations: [{
                pluginId: 'acme.bounded',
                generation: 'test-generation',
                registration: {
                    id: 'bounded',
                    adapter: {
                        detectRemote: () => ({
                            id: 'bounded',
                            kind: 'custom',
                            displayName: 'Bounded forge',
                            baseUrl: 'https://attacker.example.test',
                        }),
                    },
                },
            }],
        });

        expect(registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'https://attacker.example.test/acme/repo',
        }).kind).toBe('unknown');
    });

    it('rejects compare URLs outside the detected provider base', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [{
                id: 'forge',
                pluginId: 'acme.forge',
                kind: 'forge',
                displayName: 'Forge',
                capabilities: [],
            }],
            runtimeRegistrations: [{
                pluginId: 'acme.forge',
                generation: 'test-generation',
                registration: {
                    id: 'forge',
                    adapter: {
                        buildCompareUrl: () => 'javascript:alert(document.domain)',
                    },
                },
            }],
        });

        expect(registry.buildCompareUrl({
            provider: {
                id: 'acme.forge/forge',
                kind: 'forge',
                displayName: 'Forge',
                baseUrl: 'https://forge.example.test',
            },
            base: 'main',
            head: 'feature',
        })).toEqual(expect.objectContaining({
            kind: 'unsupported',
            reason: 'unsupported_by_provider',
        }));
    });

    it('emits a predecessor-readable envelope for custom providers without losing exact identity', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [{
                id: 'forge',
                pluginId: 'acme.forge',
                kind: 'forge',
                displayName: 'Acme Forge',
                capabilities: [],
            }],
            runtimeRegistrations: [{
                pluginId: 'acme.forge',
                generation: 'revision-7',
                registration: {
                    id: 'forge',
                    adapter: {
                        detectRemote: () => ({
                            id: 'ignored',
                            kind: 'ignored',
                            displayName: 'Ignored',
                            baseUrl: 'https://forge.example.test',
                        }),
                    },
                },
            }],
        });

        expect(registry.detectRemote({ remoteName: 'origin', remoteUrl: 'ssh://forge/repo' })).toEqual({
            kind: 'resolved',
            providerId: 'acme.forge/forge',
            provider: expect.objectContaining({
                id: 'acme.forge/forge',
                kind: 'unknown',
                providerKind: 'custom',
                name: 'Acme Forge',
                displayName: 'Acme Forge',
            }),
        });
    });

    it('routes compare-only adapters without requiring remote detection support', () => {
        const registry = createScmHostingProviderRegistry({
            providers: [{
                id: 'compare-only',
                pluginId: 'acme.compare-only',
                kind: 'custom',
                displayName: 'Compare-only forge',
                capabilities: [],
            }],
            runtimeRegistrations: [{
                pluginId: 'acme.compare-only',
                generation: 'test-generation',
                registration: {
                    id: 'compare-only',
                    adapter: {
                        buildCompareUrl: () => 'https://forge.example.test/acme/repo/compare/main...feature',
                    },
                },
            }],
        });

        expect(registry.buildCompareUrl({
            provider: {
                id: 'acme.compare-only/compare-only',
                kind: 'custom',
                displayName: 'Compare-only forge',
                baseUrl: 'https://forge.example.test',
            },
            base: 'main',
            head: 'feature',
        })).toEqual({
            kind: 'resolved',
            url: 'https://forge.example.test/acme/repo/compare/main...feature',
        });
    });

    it('preserves provider-owned repository web URLs on detected remotes', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'https://github.example.com/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBe('https://github.example.com/happier-dev/happier');
    });

    it('preserves repository web URLs below a path-scoped provider base', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'gitlab',
            kind: 'gitlab',
            displayName: 'GitLab',
            baseUrl: 'https://git.example.com/gitlab',
            repositoryWebUrl: 'https://git.example.com/gitlab/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@git.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBe('https://git.example.com/gitlab/happier-dev/happier');
    });

    it('drops repository web URLs outside the provider base path', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'gitlab',
            kind: 'gitlab',
            displayName: 'GitLab',
            baseUrl: 'https://git.example.com/gitlab',
            repositoryWebUrl: 'https://git.example.com/other/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@git.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });

    it('drops repository web URLs with unsupported schemes', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'http://github.example.com/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });

    it('rejects detected providers when runtime safety widens descriptor schemes', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'http://github.example.com',
            repositoryWebUrl: 'http://github.example.com/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
            urlSafety: {
                allowedSchemes: ['http:'],
            },
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('unknown');
    });

    it('drops malformed repository web URLs', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'not a url',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });

    it('drops repository web URLs with credentials', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'https://token@github.example.com/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });

    it('drops repository web URLs with query strings', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'https://github.example.com/happier-dev/happier?tab=readme',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });

    it('drops repository web URLs with fragments', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'https://github.example.com/happier-dev/happier#readme',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });
});
