import { describe, expect, it } from 'vitest';

import { ScmHostingProviderRefSchema } from '@happier-dev/protocol';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createPluginRegistrationScope } from '@/plugins/runtime/api/registrationScope';
import type { HostingProviderRuntimeRegistration as ScmHostingProviderRuntimeRegistration } from '@happier-dev/plugin-sdk/scm/hosting';

import type { ActivationTarget } from '../../plugins/runtime/lifecycle/activation/targets';
import { createTargetScmRuntimeEntries } from '../../plugins/runtime/lifecycle/contributions/targetScm';
import { readHostingProviderExecutionAuthority } from './executionAuthority';
import { createScmHostingProviderRegistry } from './registry';

type DetectedProviderFixture = NonNullable<
    ReturnType<NonNullable<ScmHostingProviderRuntimeRegistration['adapter']['routing']>['detectRemote']>
>;

function createRegistryWithDetectedProvider(
    detectedProvider: DetectedProviderFixture,
) {
    const registration: ScmHostingProviderRuntimeRegistration = {
        id: detectedProvider.id,
        adapter: {
            routing: {
                detectRemote: () => detectedProvider,
                buildCompareUrl: () => null,
            },
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
            occurrenceId: 'test-generation',
            registration,
        }],
    });
}

describe('SCM hosting provider registry', () => {
    it('hands each provider only its own configured connected-account deployment bases', () => {
        const detections: Array<Readonly<Record<string, unknown>>> = [];
        const compares: Array<Readonly<Record<string, unknown>>> = [];
        const createRegistration = (
            id: string,
            baseUrl: string,
            recognizes: boolean,
        ): ScmHostingProviderRuntimeRegistration => ({
            id,
            adapter: {
                routing: {
                    detectRemote: (input) => {
                        detections.push({ id, ...input });
                        return recognizes ? {
                            id,
                            kind: 'gitlab',
                            displayName: id,
                            baseUrl,
                            nameWithOwner: 'team/repository',
                        } : null;
                    },
                    buildCompareUrl: (input) => {
                        compares.push({ id, ...input });
                        return `${baseUrl}/team/repository/-/compare/main...topic`;
                    },
                },
            },
        });

        const registry = createScmHostingProviderRegistry({
            providers: [{
                id: 'gitlab',
                pluginId: 'happier.scm.forge.gitlab',
                kind: 'gitlab',
                displayName: 'GitLab',
                capabilities: [],
            }, {
                id: 'github',
                pluginId: 'happier.scm.forge.github',
                kind: 'github',
                displayName: 'GitHub',
                capabilities: [],
            }],
            runtimeRegistrations: [{
                pluginId: 'happier.scm.forge.gitlab',
                occurrenceId: 'test-generation',
                registration: createRegistration('gitlab', 'https://gitlab.example.test:8443', true),
            }, {
                pluginId: 'happier.scm.forge.github',
                occurrenceId: 'test-generation',
                registration: createRegistration('github', 'https://github.com', false),
            }],
            configuredDeploymentsByProviderId: new Map([
                ['happier.scm.forge.gitlab/gitlab', {
                    bases: ['https://gitlab.example.test:8443'],
                    status: 'complete' as const,
                }],
            ]),
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'https://gitlab.example.test:8443/team/repository.git',
        });
        expect(detected).toMatchObject({ kind: 'resolved' });
        if (detected.kind !== 'resolved') return;
        registry.buildCompareUrl({ provider: detected.provider, base: 'main', head: 'topic' });

        // The provider that declares the configured accounts sees their bases; a provider that
        // declares none must not inherit another provider's deployments.
        expect(detections.find((entry) => entry.id === 'github'))
            .not.toHaveProperty('connectedAccountBases');
        expect(detections).toContainEqual(expect.objectContaining({
            id: 'gitlab',
            connectedAccountBases: ['https://gitlab.example.test:8443'],
        }));
        expect(compares).toEqual([expect.objectContaining({
            id: 'gitlab',
            connectedAccountBases: ['https://gitlab.example.test:8443'],
        })]);
    });


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

            buildCompareUrl() {
                return null;
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
            adapter: { routing: adapter },
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
            activationTargets: [target],
            targetRegistrations: [{
                pluginId: 'acme.forge',
                occurrenceId: '7',
                registration,
            }],
            isOccurrenceCurrent: () => active,
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

        const exposed = registry.getRouting('acme.forge/forge');
        expect(exposed?.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'https://forge.example.test/acme/repo',
        })).toMatchObject({
            id: 'forge',
            authority: {
                pluginId: 'acme.forge',
                occurrenceId: '7',
                contributionId: 'forge',
            },
        });
        expect(adapter.calls).toBe(1);

        active = false;
        expect(() => exposed?.detectRemote({
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

        const exposed = registry.getRouting('happier.scm.forge/forge');
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
            occurrenceId: '7',
            registration: {
                id: 'shared',
                adapter: {
                    routing: {
                        detectRemote: () => null,
                        buildCompareUrl: () => null,
                    },
                },
            },
        }));
        const registry = createScmHostingProviderRegistry({ providers, runtimeRegistrations });

        expect(registry.providers.map((provider) => provider.id)).toEqual([
            'acme.scm.one/shared',
            'acme.scm.two/shared',
        ]);
        expect(registry.getRouting('acme.scm.one/shared')).not.toBe(runtimeRegistrations[0]?.registration.adapter.routing);
        expect(registry.getRouting('acme.scm.two/shared')).not.toBe(runtimeRegistrations[1]?.registration.adapter.routing);
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
                occurrenceId: 'test-generation',
                registration: {
                    id: 'broken',
                    adapter: {
                        routing: {
                            detectRemote() {
                                throw new Error('private adapter failure');
                            },
                            buildCompareUrl: () => null,
                        },
                    },
                },
            }, {
                pluginId: 'acme.working',
                occurrenceId: 'test-generation',
                registration: {
                    id: 'working',
                    adapter: {
                        routing: {
                            detectRemote() {
                                return {
                                    id: 'working',
                                    kind: 'working',
                                    displayName: 'Working forge',
                                    baseUrl: 'https://working.example.test',
                                };
                            },
                            buildCompareUrl: () => null,
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
                occurrenceId: 'test-generation',
                registration: {
                    id: 'declared',
                    adapter: {
                        routing: {
                            detectRemote() {
                                return {
                                    id: 'other-provider',
                                    kind: 'other-kind',
                                    displayName: 'Impersonated forge',
                                    baseUrl: 'https://declared.example.test',
                                };
                            },
                            buildCompareUrl: () => null,
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
        expect(detected.providerId).toBe('acme.declared/declared');
        expect(detected.provider).toEqual(expect.objectContaining({
            id: 'acme.declared/declared',
            kind: 'unknown',
            providerKind: 'custom',
            displayName: 'Declared forge',
            name: 'Declared forge',
            urlSafety: {
                allowedSchemes: ['https:'],
                allowedBaseUrls: ['https://declared.example.test'],
                allowedOrigins: ['https://declared.example.test'],
            },
        }));
        expect(ScmHostingProviderRefSchema.safeParse(detected.provider).success).toBe(true);
    });

    it.each([
        ['https://attacker.example.test', 'unknown'],
        ['https://allowed.example.test/other', 'unknown'],
        ['https://allowed.example.test/scmx', 'unknown'],
        ['https://allowed.example.test/scm/team', 'resolved'],
    ] as const)('bounds a detected provider base %s by the statically allowed base URLs', (baseUrl, expected) => {
        // allowed.example.test passes the origin guard, so only the base-URL path guard rejects /other and /scmx.
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
                occurrenceId: 'test-generation',
                registration: {
                    id: 'bounded',
                    adapter: {
                        routing: {
                            detectRemote: () => ({
                                id: 'bounded',
                                kind: 'custom',
                                displayName: 'Bounded forge',
                                baseUrl,
                            }),
                            buildCompareUrl: () => null,
                        },
                    },
                },
            }],
        });

        expect(registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: `${baseUrl}/acme/repo`,
        }).kind).toBe(expected);
    });

    it.each([
        ['javascript:alert(document.domain)', 'unsupported'],
        ['https://other.example.test/scm/acme/repo/compare/main...feature', 'unsupported'],
        ['https://forge.example.test.evil/scm/acme/repo/compare/main...feature', 'unsupported'],
        ['https://forge.example.test/scmx/acme/repo/compare/main...feature', 'unsupported'],
        ['https://forge.example.test/scm/acme/repo/compare/main...feature', 'resolved'],
    ] as const)('keeps compare URL %s inside the detected provider base', (compareUrl, expected) => {
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
                occurrenceId: 'test-generation',
                registration: {
                    id: 'forge',
                    adapter: {
                        routing: {
                            detectRemote: () => null,
                            buildCompareUrl: () => compareUrl,
                        },
                    },
                },
            }],
        });

        const result = registry.buildCompareUrl({
            provider: {
                id: 'acme.forge/forge',
                kind: 'forge',
                displayName: 'Forge',
                baseUrl: 'https://forge.example.test/scm',
            },
            base: 'main',
            head: 'feature',
        });
        expect(result).toEqual(expected === 'resolved'
            ? { kind: 'resolved', url: compareUrl }
            : expect.objectContaining({ kind: 'unsupported', reason: 'unsupported_by_provider' }));
    });

    it('routes compare URLs when the grouped detector reports no match', () => {
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
                occurrenceId: 'test-generation',
                registration: {
                    id: 'compare-only',
                    adapter: {
                        routing: {
                            detectRemote: () => null,
                            buildCompareUrl: () => 'https://forge.example.test/acme/repo/compare/main...feature',
                        },
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

    it.each([
        ['outside the provider base path', { id: 'gitlab', kind: 'gitlab', displayName: 'GitLab', baseUrl: 'https://git.example.com/gitlab', repositoryWebUrl: 'https://git.example.com/other/happier-dev/happier' }],
        ['with an unsupported scheme', { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.example.com', repositoryWebUrl: 'http://github.example.com/happier-dev/happier' }],
        ['that is malformed', { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.example.com', repositoryWebUrl: 'not a url' }],
        ['with credentials', { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.example.com', repositoryWebUrl: 'https://token@github.example.com/happier-dev/happier' }],
        ['with a query string', { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.example.com', repositoryWebUrl: 'https://github.example.com/happier-dev/happier?tab=readme' }],
        ['with a fragment', { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.example.com', repositoryWebUrl: 'https://github.example.com/happier-dev/happier#readme' }],
    ] as const)('drops a repository web URL %s', (_case, provider) => {
        const registry = createRegistryWithDetectedProvider({
            ...provider,
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
});


describe('SCM hosting Action response boundary', () => {
    it('rejects a null PR list with a readable typed failure while preserving empty lists', async () => {
        let result: unknown = null;
        const registry = createScmHostingProviderRegistry({
            providers: [{ id: 'github', pluginId: 'test.forge', kind: 'github', displayName: 'GitHub', capabilities: [] }],
            runtimeRegistrations: [{ pluginId: 'test.forge', occurrenceId: 'test-generation', registration: {
                id: 'github', adapter: { pullRequests: {
                    getPullRequestAuthProfileKey: () => null,
                    listPullRequests: async () => [], getPullRequest: async () => null,
                    createPullRequest: async () => { throw new Error('Unexpected pull request creation'); },
                } },
            } }],
            prepareHostingProviderOperation: async () => async () => ({ ok: true, result }),
        });
        const adapter = registry.getPullRequests('test.forge/github')!;
        const input = { provider: { id: 'test.forge/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com',
            urlSafety: { allowedSchemes: ['https:'] } }, head: 'feature' } satisfies Parameters<typeof adapter.listPullRequests>[0];
        await expect(adapter.listPullRequests(input)).rejects.toMatchObject({
            errorCode: 'COMMAND_FAILED', message: 'SCM hosting listPullRequests returned an invalid response',
        });
        result = [];
        await expect(adapter.listPullRequests(input)).resolves.toEqual([]);
    });
});
