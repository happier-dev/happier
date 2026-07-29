import { describe, expect, it } from 'vitest';

import { GH_INSTALLABLE_DESCRIPTOR } from '@happier-dev/protocol';

import type { ResolvedInstallableContribution } from './types';
import {
    resolveExecutableManagedDependenciesRegistry,
    selectExecutableManagedDependencies,
} from './managedDependencyExecutables';

describe('selectExecutableManagedDependencies', () => {
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

    it('projects a complete bundled V2 managed PyPI source into the canonical installables registry', () => {
        const managedPypi = {
            provenance: 'first_party',
            source: { kind: 'bundled' },
            pluginId: 'happier.agent.antigravity',
            manifestPath: 'bundled:happier.agent.antigravity',
            manifestDigest: 'sha256:antigravity',
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

        expect(resolveExecutableManagedDependenciesRegistry(
            [managedPypi],
            { platform: 'linux', architecture: 'x64' },
        )).toMatchObject({
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
    });

    it('preserves executable contribution ownership in the installables registry', () => {
        const executable = {
            provenance: 'first_party',
            source: { kind: 'bundled' },
            pluginId: 'happier.agent.fixture',
            manifestPath: 'bundled:happier.agent.fixture',
            manifestDigest: 'sha256:fixture',
            definition: GH_INSTALLABLE_DESCRIPTOR,
        } satisfies ResolvedInstallableContribution;

        expect(resolveExecutableManagedDependenciesRegistry([executable])).toMatchObject({
            descriptors: [{
                owner: {
                    provenance: 'bundled_first_party_plugin',
                    ownerId: 'happier.agent.fixture',
                    pluginId: 'happier.agent.fixture',
                    manifestPath: 'bundled:happier.agent.fixture',
                    manifestDigest: 'sha256:fixture',
                },
                descriptor: GH_INSTALLABLE_DESCRIPTOR,
            }],
            diagnostics: [],
        });
    });

    it('fails closed for incomplete, unsupported-platform, and non-bundled V2 sources without coercing other source kinds', () => {
        const complete = {
            provenance: 'first_party',
            source: { kind: 'bundled' },
            pluginId: 'happier.agent.fixture',
            manifestPath: 'bundled:happier.agent.fixture',
            manifestDigest: 'sha256:fixture',
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
        const nonBundled = resolveExecutableManagedDependenciesRegistry([{
            ...complete,
            provenance: 'external',
            source: { kind: 'path' },
            sourceSpec: {
                kind: 'path',
                locator: '/plugins/fixture',
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
        }], { platform: 'linux', architecture: 'x64' });
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
        expect(nonBundled.descriptors).toEqual([]);
        expect(otherSourceKinds.descriptors).toEqual([]);
        expect(incomplete.descriptors).toEqual([]);
    });
});
