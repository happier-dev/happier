import { describe, expect, it } from 'vitest';

import type { PluginManifestV2, PluginSourceSpecV1 } from '@happier-dev/protocol';
import { buildPluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
    ResolvedActivationTarget,
    ResolvedScmHostingProviderContribution,
} from '@/plugins/projection/registry/types';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { activatePluginRuntimeRegistry } from '@/plugins/runtime/lifecycle/manager';
import { loadPluginModule } from '@/plugins/runtime/loadPluginModule';

import { createScmHostingProviderRegistry } from './registry';
import type { ScmHostingProviderDescriptor } from './types';

type BundledScmPluginSpec = Readonly<{
    pluginId: string;
    packageName: string;
    providerId: string;
    devSourceEntry: string;
}>;

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

const bundledScmPluginSpecs: readonly BundledScmPluginSpec[] = Object.freeze([
    {
        pluginId: 'scm-github',
        packageName: '@happier-dev/plugins-scm-github',
        providerId: 'scm.github',
        devSourceEntry: '../../../../../../../packages/plugins/scm-github/src/index.js',
    },
    {
        pluginId: 'scm-gitlab',
        packageName: '@happier-dev/plugins-scm-gitlab',
        providerId: 'scm.gitlab',
        devSourceEntry: '../../../../../../../packages/plugins/scm-gitlab/src/index.js',
    },
    {
        pluginId: 'scm-bitbucket',
        packageName: '@happier-dev/plugins-scm-bitbucket',
        providerId: 'scm.bitbucket',
        devSourceEntry: '../../../../../../../packages/plugins/scm-bitbucket/src/index.js',
    },
    {
        pluginId: 'scm-azure-devops',
        packageName: '@happier-dev/plugins-scm-azure-devops',
        providerId: 'scm.azure-devops',
        devSourceEntry: '../../../../../../../packages/plugins/scm-azure-devops/src/index.js',
    },
]);

const sourceSpecByPackageName = new Map<string, PluginSourceSpecV1>(
    bundledScmPluginSpecs.map((spec) => [
        spec.packageName,
        {
            kind: 'package',
            locator: spec.packageName,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedVersion: '0.0.0',
            resolvedDigest: `bundled:${spec.packageName}@0.0.0`,
        },
    ]),
);

async function importBundledPackageModule(spec: BundledScmPluginSpec): Promise<Readonly<Record<string, unknown>>> {
    try {
        return await import(spec.packageName) as Readonly<Record<string, unknown>>;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        const message = error instanceof Error ? error.message : '';
        const isMissingPackageEntry = code === 'ERR_MODULE_NOT_FOUND'
            || code === 'MODULE_NOT_FOUND'
            || message.includes(`Failed to resolve entry for package "${spec.packageName}"`);
        if (!isMissingPackageEntry) {
            throw error;
        }
        return await import(spec.devSourceEntry) as Readonly<Record<string, unknown>>;
    }
}

async function loadBundledPackageModule(spec: BundledScmPluginSpec): Promise<Readonly<Record<string, unknown>>> {
    return await loadPluginModule({
        source: {
            kind: 'bundled',
            moduleId: spec.packageName,
            load: async () => await importBundledPackageModule(spec),
        },
    });
}

function readPluginManifest(moduleNamespace: Readonly<Record<string, unknown>>): PluginManifestV2 {
    const manifest = moduleNamespace.PLUGIN_MANIFEST;
    expect(manifest).toEqual(expect.objectContaining({
        schemaVersion: 2,
        runtime: expect.objectContaining({
            capabilities: expect.arrayContaining(['scmHostingProviders']),
        }),
        contributes: expect.objectContaining({
            scmHostingProviders: expect.any(Array),
        }),
    }));
    return manifest as PluginManifestV2;
}

function toCanonicalManifest(manifest: PluginManifestV2): CanonicalPluginManifest {
    return {
        ...manifest,
        permissions: manifest.capabilities.permissions,
        contributes: {
            providers: [],
            backends: [],
            actions: [],
            tools: [],
            commands: [],
            resources: [],
            uiDescriptors: [],
            hooks: [],
            lifecycleHandlers: [],
            ...manifest.contributes,
        },
    };
}

describe('bundled first-party SCM hosting providers', () => {
    it('are consumable through plugin projection and activation loader APIs using package locators', async () => {
        const modulesByPackageName = new Map<string, Readonly<Record<string, unknown>>>();
        const loadedPlugins: Array<Readonly<{
            pluginId: string;
            pluginRootPath: string;
            manifestPath: string;
            manifestDigest: string;
            daemonEntryPath: string;
            sourceSpec: PluginSourceSpecV1;
            manifest: CanonicalPluginManifest;
        }>> = [];

        for (const spec of bundledScmPluginSpecs) {
            const moduleNamespace = await loadBundledPackageModule(spec);
            modulesByPackageName.set(spec.packageName, moduleNamespace);
            const manifest = toCanonicalManifest(readPluginManifest(moduleNamespace));
            const sourceSpec = sourceSpecByPackageName.get(spec.packageName);
            expect(sourceSpec).toBeDefined();
            if (!sourceSpec) continue;

            loadedPlugins.push({
                pluginId: spec.pluginId,
                pluginRootPath: `bundled:${spec.pluginId}`,
                manifestPath: `bundled:${spec.pluginId}`,
                manifestDigest: `bundled:${spec.packageName}@0.0.0`,
                daemonEntryPath: spec.packageName,
                sourceSpec,
                manifest,
            });
        }

        const pluginContributions = buildPluginContributionRegistry({ loadedPlugins });
        const scmHostingProviders: readonly ResolvedScmHostingProviderContribution[] = pluginContributions.scmHostingProviders.map((contribution) => Object.freeze({
            id: contribution.definition.id,
            provenance: 'first_party' as const,
            source: { kind: 'bundled' as const },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        }));
        const activationTargets: readonly ResolvedActivationTarget[] = loadedPlugins.map((plugin) => Object.freeze({
            provenance: 'external' as const,
            source: { kind: 'bundled' as const },
            pluginId: plugin.pluginId,
            manifestPath: plugin.manifestPath,
            manifestDigest: plugin.manifestDigest,
            daemonEntryPath: plugin.daemonEntryPath,
            sourceSpec: plugin.sourceSpec,
        }));
        const contributionRegistry = createResolvedContributionRegistry({
            providers: [],
            backends: [],
            scmHostingProviders,
            activationTargets,
        });

        const resolvedScmHostingProviders = contributionRegistry.scmHostingProviders ?? [];
        expect(resolvedScmHostingProviders.map((provider) => provider.id).sort()).toEqual([
            'scm.azure-devops',
            'scm.bitbucket',
            'scm.github',
            'scm.gitlab',
        ]);
        for (const provider of resolvedScmHostingProviders) {
            expect(provider.definition.urlSafety).toEqual(expect.objectContaining({
                allowedSchemes: ['https:'],
                allowedBaseUrls: expect.any(Array),
                allowedOrigins: expect.any(Array),
            }));
            expect(provider.definition.remoteHostMatchers).toEqual(expect.objectContaining({
                exactHosts: expect.any(Array),
            }));
        }

        const activated = await activatePluginRuntimeRegistry({
            contributes: contributionRegistry,
            generation: 1,
            resolveActivationSource(target) {
                const moduleNamespace = modulesByPackageName.get(target.daemonEntryPath);
                if (!moduleNamespace) return null;
                return {
                    kind: 'bundled',
                    moduleId: target.daemonEntryPath,
                    load: async () => moduleNamespace,
                };
            },
        });

        const providerDescriptors: readonly ScmHostingProviderDescriptor[] = resolvedScmHostingProviders.map((provider) =>
            Object.freeze({
                ...provider.definition,
                pluginId: provider.pluginId,
                urlSafety: {
                    allowedSchemes: provider.definition.urlSafety?.allowedSchemes ?? ['https:'],
                    allowedBaseUrls: provider.definition.urlSafety?.allowedBaseUrls ?? [],
                    allowedOrigins: provider.definition.urlSafety?.allowedOrigins ?? [],
                },
            }),
        );

        const registry = createScmHostingProviderRegistry({
            providers: providerDescriptors,
            runtimeRegistrations: [...activated.scmHostingProvidersById.values()],
        });

        expect(registry).toEqual(expect.objectContaining({
            detectRemote: expect.any(Function),
            buildCompareUrl: expect.any(Function),
        }));
        const routingRegistry = registry as typeof registry & RoutingRegistryApi;

        const detected = routingRegistry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'ssh://git@ghe.internal.test/happier-dev/happier.git',
        });
        expect(detected).toEqual({
            kind: 'resolved',
            providerId: 'scm.github',
            provider: expect.objectContaining({
                id: 'scm.github',
                baseUrl: 'https://ghe.internal.test',
                nameWithOwner: 'happier-dev/happier',
            }),
        });
        if (detected.kind !== 'resolved') return;
        expect(routingRegistry.buildCompareUrl({
            provider: detected.provider,
            base: 'release/2026',
            head: 'feature/pr-support',
        })).toEqual({
            kind: 'resolved',
            url: 'https://ghe.internal.test/happier-dev/happier/compare/release%2F2026...feature%2Fpr-support',
        });

        const azureDetected = routingRegistry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'https://dev.azure.com/happier-dev/platform/_git/happier.git',
        });
        expect(azureDetected).toEqual({
            kind: 'resolved',
            providerId: 'scm.azure-devops',
            provider: expect.objectContaining({
                id: 'scm.azure-devops',
                kind: 'azure-devops',
                baseUrl: 'https://dev.azure.com/happier-dev',
                nameWithOwner: 'happier-dev/platform/happier',
                urlSafety: {
                    allowedSchemes: ['https:'],
                    allowedBaseUrls: ['https://dev.azure.com/happier-dev'],
                    allowedOrigins: ['https://dev.azure.com'],
                },
            }),
        });
        if (azureDetected.kind !== 'resolved') return;
        expect(routingRegistry.buildCompareUrl({
            provider: azureDetected.provider,
            base: 'release/2026',
            head: 'feature/pr-support',
        })).toEqual({
            kind: 'resolved',
            url: 'https://dev.azure.com/happier-dev/platform/_git/happier/branchCompare?baseVersion=GBrelease%2F2026&targetVersion=GBfeature%2Fpr-support',
        });

        const malformedAzureLike = routingRegistry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'https://dev.azure.com/happier-dev/_git/happier.git',
        });
        expect(malformedAzureLike).toEqual({
            kind: 'unknown',
            provider: {
                id: 'unknown',
                kind: 'unknown',
                displayName: 'Unknown SCM hosting provider',
                remoteName: 'origin',
                unsupportedReason: 'no_registered_provider_detected',
            },
        });

        const unknown = routingRegistry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'https://unknown.example.com/happier-dev/happier.git',
        });
        expect(unknown).toEqual({
            kind: 'unknown',
            provider: {
                id: 'unknown',
                kind: 'unknown',
                displayName: 'Unknown SCM hosting provider',
                remoteName: 'origin',
                unsupportedReason: 'no_registered_provider_detected',
            },
        });
    });
});
