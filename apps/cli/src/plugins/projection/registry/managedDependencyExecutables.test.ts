import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { GH_INSTALLABLE_DESCRIPTOR, PluginManagedDependencyContributionV2Schema } from '@happier-dev/protocol';

import type { ResolvedInstallableContribution } from './types';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from './sources/generatedBundledPluginManifests';
import { readBundledPluginManifest } from './builtIn/locators';
import {
    projectPinnedArchiveInstallableDescriptor,
    resolveExecutableManagedDependenciesRegistry,
    selectExecutableManagedDependencies,
} from './managedDependencyExecutables';

/**
 * The real bundled Antigravity declaration rather than a restatement of it: the
 * pinned ACP server's published platform matrix is the fact under test.
 */
function readBundledAntigravityAcpServerContribution(): ResolvedInstallableContribution {
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS
        .find((candidate) => candidate.pluginId === 'happier.agent.antigravity');
    if (!locator) throw new Error('Bundled Antigravity plugin locator is missing');
    const manifest = readBundledPluginManifest(locator) as Readonly<{
        contributes: Readonly<{ managedDependencies: readonly unknown[] }>;
    }>;
    const declaration = manifest.contributes.managedDependencies
        .map((candidate) => PluginManagedDependencyContributionV2Schema.parse(candidate))
        .find((candidate) => candidate.id === 'agy-acp-server');
    if (!declaration) throw new Error('Bundled Antigravity ACP server dependency is missing');
    return {
        provenance: 'first_party',
        source: { kind: 'bundled' },
        pluginId: locator.pluginId,
        manifestPath: locator.manifestPath,
        daemonEntryPath: locator.daemonEntryPath,
        sourceSpec: locator.sourceSpec,
        definition: declaration,
    };
}

describe('selectExecutableManagedDependencies', () => {
    it.each(['linux', 'darwin', 'win32'] as const)('projects an external SDK-authored JavaScript server into the ordinary install flow on %s', platform => {
        const plugin = definePlugin({ id: 'acme.language', version: '1.0.0', displayName: 'External language',
            runtime: { apiVersion: 1 },
            managedDependencies: { server: { title: 'Language server', executable: 'language-server', sources: [{
                kind: 'managedJavaScriptPackage', installId: 'dep.acme.language', packageName: '@acme/language', version: '1.2.3',
            }] } },
            languageServers: { language: { title: 'Language', languageIds: { fixture: 'fixture' },
                executable: { kind: 'managedDependency', id: 'server' }, args: ['--stdio'] } },
        });
        const declaration = plugin.manifest.contributes?.managedDependencies?.[0];
        if (!declaration) throw new Error('SDK must project the managed dependency declaration');
        const contribution: ResolvedInstallableContribution = { provenance: 'external', source: { kind: 'path' },
            pluginId: plugin.manifest.id, manifestPath: '/installed/acme.language/plugin.json',
            definition: PluginManagedDependencyContributionV2Schema.parse(declaration) };
        const registry = resolveExecutableManagedDependenciesRegistry([contribution], { platform, architecture: 'x64' });
        expect(registry.descriptorsByKey['dep.acme.language']).toMatchObject({
            owner: { provenance: 'external_plugin', pluginId: 'acme.language' },
            descriptor: { source: { kind: 'managed_package', packageManager: 'managed_js_runtime', packageName: '@acme/language', version: '1.2.3' },
                binary: { commands: ['language-server'], systemFirst: false }, defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'off' } },
        });
    });
    it('projects declared GitHub release and launch facts through the executable dependency registry', () => {
        const declared = {
            provenance: 'first_party',
            source: { kind: 'bundled' },
            pluginId: 'happier.agent.codex',
            manifestPath: 'bundled:happier.agent.codex',
            definition: {
                id: 'codex-acp', title: 'Codex ACP', executable: 'codex-acp',
                sources: [{
                    kind: 'githubReleaseBinary', installId: 'dep.codex-acp',
                    repo: 'zed-industries/codex-acp', archiveLayout: 'single_executable',
                    assetNamePrefix: 'codex-acp',
                    targetByPlatform: { 'linux-x64-gnu': 'x86_64-unknown-linux-gnu' },
                    launch: {
                        kind: 'codexAcp',
                        overrideEnvironmentKey: 'HAPPIER_CODEX_ACP_BIN',
                        configOverridesEnvironmentKey: 'HAPPIER_CODEX_ACP_CONFIG_OVERRIDES',
                        configOverrideArgument: '-c',
                    },
                }],
            },
        } satisfies ResolvedInstallableContribution;
        const registry = resolveExecutableManagedDependenciesRegistry(
            [declared], { platform: 'linux', architecture: 'x64' },
        );
        expect(registry.descriptors).toMatchObject([{
            owner: { pluginId: 'happier.agent.codex' },
            descriptor: {
                key: 'codex-acp', capabilityId: 'dep.codex-acp',
                source: {
                    kind: 'github_release_binary', archiveLayout: 'single_executable',
                    targetByPlatform: { 'linux-x64-gnu': 'x86_64-unknown-linux-gnu' },
                    launch: { overrideEnvironmentKey: 'HAPPIER_CODEX_ACP_BIN' },
                },
            },
        }]);
    });
    it('projects a retained structural generation without a copied manifest digest', () => {
        const retained = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.retained',
            manifestPath: '/immutable/acme.retained/.happier-plugin/plugin.json',
            sourceSpec: {
                kind: 'path',
                locator: '/immutable/acme.retained',
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
            definition: {
                id: 'tool',
                title: 'Retained tool',
                executable: 'retained-tool',
                sources: [{
                    kind: 'managedPypiWheelAsset',
                    installId: 'dep.retained.tool',
                    distribution: 'retained-tool',
                    versionSpecifier: '>=1,<2',
                    assetPathByPlatform: {
                        'linux-x64': 'retained/bin/tool',
                    },
                    executable: true,
                    installConsent: 'host_managed_required',
                    autoUpdateMode: 'notify',
                }],
            },
        } satisfies ResolvedInstallableContribution;

        expect(resolveExecutableManagedDependenciesRegistry(
            [retained],
            { platform: 'linux', architecture: 'x64' },
        ).descriptors).toMatchObject([{
            owner: {
                provenance: 'external_plugin',
                pluginId: 'acme.retained',
                manifestPath: retained.manifestPath,
            },
            descriptor: { key: 'dep.retained.tool' },
        }]);
    });

    it('admits complete executable descriptors and excludes unsupported declarative V2 dependency requests', () => {
        const executable = {
            provenance: 'first_party',
            source: { kind: 'bundled' },
            pluginId: 'happier.core',
            definition: GH_INSTALLABLE_DESCRIPTOR,
        } satisfies ResolvedInstallableContribution;
        const declarative = {
            provenance: 'first_party',
            source: { kind: 'bundled' },
            pluginId: 'happier.agent.codex',
            definition: {
                id: 'codex-acp',
                title: 'Codex ACP adapter',
                sources: [{ kind: 'vendorRecipe', recipeId: 'codex-acp' }],
                executable: 'codex-acp',
            },
        } satisfies ResolvedInstallableContribution;

        expect(selectExecutableManagedDependencies([declarative, executable])).toEqual([executable]);
    });

    it('projects complete bundled and installed external managed PyPI sources through the same canonical descriptor', () => {
        const managedPypi = {
            provenance: 'first_party',
            source: { kind: 'bundled' },
            pluginId: 'happier.agent.antigravity',
            manifestPath: 'bundled:happier.agent.antigravity',
            daemonEntryPath: '@happier-dev/plugins-antigravity',
            sourceSpec: {
                kind: 'bundled',
                locator: '@happier-dev/plugins-antigravity',
                trustPolicy: 'local_trusted',
                installPolicy: 'copy',
            },
            definition: {
                id: 'localharness',
                title: 'Antigravity localharness',
                description: 'Managed Antigravity localharness runtime',
                executable: 'localharness',
                platforms: ['macos', 'linux', 'windows'],
                sources: [{
                    kind: 'managedPypiWheelAsset',
                    installId: 'dep.antigravity.localharness',
                    distribution: 'google-antigravity',
                    versionSpecifier: '>=0.1.4,<0.2.0',
                    assetPathByPlatform: {
                        'darwin-arm64': 'google/antigravity/bin/localharness',
                        'linux-x64': 'google/antigravity/bin/localharness',
                        'linux-arm64': 'google/antigravity/bin/localharness',
                        'win32-x64': 'google/antigravity/bin/localharness.exe',
                        'win32-arm64': 'google/antigravity/bin/localharness.exe',
                    },
                    executable: true,
                    compatibilityProbe: 'antigravity-localharness-v1',
                    installConsent: 'host_managed_required',
                    autoUpdateMode: 'notify',
                    trustedPublisher: 'Google',
                }],
            },
        } satisfies ResolvedInstallableContribution;
        const installedExternal = {
            ...managedPypi,
            provenance: 'external',
            source: { kind: 'package' },
            pluginId: 'com.acme.antigravity',
            manifestPath: '/immutable/generations/com.acme.antigravity/.happier-plugin/plugin.json',
            sourceSpec: {
                kind: 'package',
                locator: '@acme/antigravity',
                trustPolicy: 'prompt',
                installPolicy: 'managed_install',
                resolvedVersion: '1.0.0',
            },
        } satisfies ResolvedInstallableContribution;

        const bundledRegistry = resolveExecutableManagedDependenciesRegistry(
            [managedPypi],
            { platform: 'linux', architecture: 'x64' },
        );
        const externalRegistry = resolveExecutableManagedDependenciesRegistry(
            [installedExternal],
            { platform: 'linux', architecture: 'x64' },
        );

        expect(bundledRegistry).toMatchObject({
            descriptors: [{
                owner: {
                    provenance: 'bundled_first_party_plugin',
                    pluginId: 'happier.agent.antigravity',
                },
                descriptor: {
                    key: 'dep.antigravity.localharness',
                    capabilityId: 'dep.antigravity.localharness',
                    source: {
                        kind: 'managed_pypi_wheel_asset',
                        installConsent: 'host_managed_required',
                    },
                    binary: {
                        commands: ['localharness'],
                        systemFirst: false,
                        managedFallback: true,
                    },
                    consent: {
                        install: 'required',
                        update: 'required',
                        commandsPreviewRequired: true,
                    },
                },
            }],
            diagnostics: [],
        });
        expect(externalRegistry).toMatchObject({
            descriptors: [{
                owner: {
                    provenance: 'external_plugin',
                    pluginId: 'com.acme.antigravity',
                    manifestPath: '/immutable/generations/com.acme.antigravity/.happier-plugin/plugin.json',
                },
            }],
            diagnostics: [],
        });
        expect(externalRegistry.descriptors[0]?.owner).not.toHaveProperty('manifestDigest');
        expect(externalRegistry.descriptors[0]?.descriptor).toEqual(
            bundledRegistry.descriptors[0]?.descriptor,
        );
    });

    it('preserves executable contribution ownership in the installables registry', () => {
        const executable = {
            provenance: 'first_party',
            source: { kind: 'bundled' },
            pluginId: 'happier.agent.fixture',
            manifestPath: 'bundled:happier.agent.fixture',
            definition: GH_INSTALLABLE_DESCRIPTOR,
        } satisfies ResolvedInstallableContribution;

        expect(resolveExecutableManagedDependenciesRegistry([executable])).toMatchObject({
            descriptors: [{
                owner: {
                    provenance: 'bundled_first_party_plugin',
                    ownerId: 'happier.agent.fixture',
                    pluginId: 'happier.agent.fixture',
                    manifestPath: 'bundled:happier.agent.fixture',
                },
                descriptor: GH_INSTALLABLE_DESCRIPTOR,
            }],
            diagnostics: [],
        });
    });

    it('fails closed for incomplete and unsupported-platform V2 sources without coercing other source kinds', () => {
        const complete = {
            provenance: 'first_party',
            source: { kind: 'bundled' },
            pluginId: 'happier.agent.fixture',
            manifestPath: 'bundled:happier.agent.fixture',
            daemonEntryPath: '@happier-dev/plugins-fixture',
            sourceSpec: {
                kind: 'bundled',
                locator: '@happier-dev/plugins-fixture',
                trustPolicy: 'local_trusted',
                installPolicy: 'copy',
            },
            definition: {
                id: 'tool',
                title: 'Fixture tool',
                executable: 'fixture-tool',
                sources: [{
                    kind: 'managedPypiWheelAsset',
                    installId: 'dep.fixture.tool',
                    distribution: 'fixture-tool',
                    versionSpecifier: '>=1,<2',
                    assetPathByPlatform: {
                        'linux-x64': 'fixture/bin/tool',
                    },
                    executable: true,
                    installConsent: 'host_managed_required',
                    autoUpdateMode: 'notify',
                }],
            },
        } satisfies ResolvedInstallableContribution;
        const unsupportedPlatform = resolveExecutableManagedDependenciesRegistry(
            [complete],
            { platform: 'darwin', architecture: 'arm64' },
        );
        const otherSourceKinds = resolveExecutableManagedDependenciesRegistry([{
            ...complete,
            definition: {
                id: 'tool',
                title: 'Fixture tool',
                executable: 'fixture-tool',
                sources: [
                    { kind: 'system', executableNames: ['fixture-tool'] },
                    { kind: 'vendorRecipe', recipeId: 'fixture-tool' },
                    { kind: 'manual', instructions: 'Install Fixture Tool' },
                ],
            },
        }], { platform: 'linux', architecture: 'x64' });
        const incomplete = resolveExecutableManagedDependenciesRegistry([{
            ...complete,
            definition: {
                ...complete.definition,
                executable: undefined,
            },
        } as unknown as ResolvedInstallableContribution], { platform: 'linux', architecture: 'x64' });

        expect(unsupportedPlatform.descriptors).toEqual([]);
        expect(otherSourceKinds.descriptors).toEqual([]);
        expect(incomplete.descriptors).toEqual([]);
    });
});

describe('pinned archive managed dependencies', () => {
    const PUBLISHED_HOSTS = [
        { targetKey: 'darwin-arm64', platform: 'darwin', architecture: 'arm64', executableSubpath: 'agy_acp_server.par' },
        { targetKey: 'darwin-x64', platform: 'darwin', architecture: 'x64', executableSubpath: 'agy_acp_server.par' },
        { targetKey: 'linux-x64', platform: 'linux', architecture: 'x64', executableSubpath: 'agy_acp_server.par' },
        { targetKey: 'linux-arm64', platform: 'linux', architecture: 'arm64', executableSubpath: 'agy_acp_server.par' },
        { targetKey: 'win32-x64', platform: 'win32', architecture: 'x64', executableSubpath: 'agy_acp_server.exe' },
        { targetKey: 'win32-arm64', platform: 'win32', architecture: 'arm64', executableSubpath: 'agy_acp_server.exe' },
    ] as const;

    it('publishes the bundled Antigravity pinned ACP server through the canonical installables descriptor on every host it ships', () => {
        const contribution = readBundledAntigravityAcpServerContribution();
        const declaration = PluginManagedDependencyContributionV2Schema.parse(contribution.definition);
        const pinnedSource = declaration.sources.find(source => source.kind === 'pinnedArchive');
        if (!pinnedSource || pinnedSource.kind !== 'pinnedArchive') throw new Error('Expected the bundled pinned ACP source');

        for (const host of PUBLISHED_HOSTS) {
            const registry = resolveExecutableManagedDependenciesRegistry([contribution], {
                platform: host.platform,
                architecture: host.architecture,
            });

            expect(registry.diagnostics).toEqual([]);
            expect(registry.descriptors).toMatchObject([{
                owner: {
                    provenance: 'bundled_first_party_plugin',
                    pluginId: 'happier.agent.antigravity',
                },
                descriptor: {
                    id: 'dep.antigravity.agy-acp-server',
                    key: 'dep.antigravity.agy-acp-server',
                    capabilityId: 'dep.antigravity.agy-acp-server',
                    display: { name: 'Antigravity ACP server' },
                    source: { kind: 'pinned_archive', version: pinnedSource.version },
                    binary: {
                        commands: ['agy_acp_server'],
                        systemFirst: false,
                        managedFallback: true,
                    },
                    defaultPolicy: {
                        autoInstallWhenNeeded: true,
                        autoUpdateMode: 'off',
                    },
                },
            }]);
            const source = registry.descriptors[0]?.descriptor.source;
            expect(source?.kind === 'pinned_archive'
                ? source.archiveExtractionLimits
                : null).toEqual({
                maxArchiveBytes: 1024 * 1024 * 1024,
                maxFileBytes: 2 * 1024 * 1024 * 1024,
                maxExpandedBytes: 2 * 1024 * 1024 * 1024,
                timeoutMs: 10 * 60_000,
            });
            expect(source?.kind === 'pinned_archive'
                ? source.assetsByPlatform[host.targetKey]?.executableSubpath
                : null).toBe(host.executableSubpath);
        }
    });

    it('does not advertise a host the pinned source does not publish', () => {
        const contribution = readBundledAntigravityAcpServerContribution();

        expect(resolveExecutableManagedDependenciesRegistry([contribution], {
            platform: 'darwin',
            architecture: 'ia32',
        }).descriptors).toEqual([]);
        expect(resolveExecutableManagedDependenciesRegistry([contribution], {
            platform: 'freebsd',
            architecture: 'x64',
        }).descriptors).toEqual([]);
    });

    it('keeps an incomplete generic pinned archive out of the installables registry', () => {
        const contribution = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.pinned',
            manifestPath: '/immutable/acme.pinned/.happier-plugin/plugin.json',
            sourceSpec: {
                kind: 'path',
                locator: '/immutable/acme.pinned',
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
            definition: {
                id: 'tool',
                title: 'Acme pinned tool',
                executable: 'acme-tool',
                sources: [{
                    kind: 'pinnedArchive',
                    installId: 'dep.acme.tool',
                    version: '3.2.1',
                    archiveExtractionLimits: {
                        maxArchiveBytes: 1024,
                        maxFileBytes: 2048,
                        maxExpandedBytes: 4096,
                        timeoutMs: 10_000,
                    },
                    assetsByPlatform: {
                        'linux-x64': {
                            archiveUrl: 'https://downloads.acme.test/acme-tool-3.2.1-linux-x64.zip',
                            sha256: 'a'.repeat(64),
                            executableSubpath: 'bin/acme-tool',
                        },
                    },
                }],
            },
        } satisfies ResolvedInstallableContribution;

        expect(resolveExecutableManagedDependenciesRegistry(
            [contribution],
            { platform: 'linux', architecture: 'x64' },
        ).descriptors).toMatchObject([{
            owner: { provenance: 'external_plugin', pluginId: 'acme.pinned' },
            descriptor: {
                key: 'dep.acme.tool',
                capabilityId: 'dep.acme.tool',
                source: {
                    kind: 'pinned_archive',
                    archiveExtractionLimits: {
                        maxArchiveBytes: 1024,
                        maxFileBytes: 2048,
                        maxExpandedBytes: 4096,
                        timeoutMs: 10_000,
                    },
                },
            },
        }]);
        // The declaration publishes no Windows artifact, so no Windows host may claim one.
        expect(resolveExecutableManagedDependenciesRegistry(
            [contribution],
            { platform: 'win32', architecture: 'x64' },
        ).descriptors).toEqual([]);
        // Provenance is incomplete without a manifest path, exactly as for every other managed source.
        expect(resolveExecutableManagedDependenciesRegistry(
            [{ ...contribution, manifestPath: undefined }],
            { platform: 'linux', architecture: 'x64' },
        ).descriptors).toEqual([]);
    });
});

describe('managed dependency descriptions (Tools copy)', () => {
    it('never fills a missing description with plugin and dependency ids', () => {
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(candidate => candidate.pluginId === 'happier.language.markdown');
        if (!locator) throw new Error('Bundled Markdown language plugin locator is missing');
        const manifest = readBundledPluginManifest(locator) as Readonly<{ contributes: Readonly<{ managedDependencies: readonly unknown[] }> }>;
        const definition = manifest.contributes.managedDependencies
            .map(candidate => PluginManagedDependencyContributionV2Schema.parse(candidate))
            .find(candidate => candidate.id === 'marksman');
        const source = definition?.sources.find(candidate => candidate.kind === 'pinnedArchive');
        if (!definition || !source || source.kind !== 'pinnedArchive') throw new Error('Bundled Marksman archive source is missing');
        const descriptor = projectPinnedArchiveInstallableDescriptor({ definition, source, pluginId: locator.pluginId,
            manifestPath: locator.manifestPath, host: { platform: 'linux', architecture: 'x64' } });
        expect(descriptor?.display.name).toBe('Marksman');
        expect(descriptor?.description).not.toContain(locator.pluginId);
        expect(descriptor?.description).not.toContain('/marksman');
    });
});
