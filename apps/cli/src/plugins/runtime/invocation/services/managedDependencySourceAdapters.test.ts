import { describe, expect, it } from 'vitest';

import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { resolveExecutableManagedDependenciesRegistry } from '@/plugins/projection/registry/managedDependencyExecutables';

import { createProductionManagedDependencySourceAdapter } from './managedDependencySourceAdapters';
import { createV2ManagedDependencySourceModel } from './managedDependencySourceModel';

function antigravityContribution(
    sourceKind: 'bundled' | 'package' = 'bundled',
): ResolvedInstallableContribution {
    return {
        provenance: sourceKind === 'bundled' ? 'first_party' : 'external',
        source: { kind: sourceKind },
        pluginId: 'happier.agent.antigravity',
        manifestPath: `${sourceKind}:happier.agent.antigravity`,
        daemonEntryPath: null,
        sourceSpec: {
            kind: sourceKind,
            locator: sourceKind === 'bundled'
                ? '@happier-dev/plugins-antigravity'
                : '@acme/antigravity',
            trustPolicy: sourceKind === 'bundled' ? 'local_trusted' : 'prompt',
            installPolicy: sourceKind === 'bundled' ? 'copy' : 'managed_install',
            ...(sourceKind === 'package'
                ? {
                    resolvedVersion: '1.0.0',
                }
                : {}),
        },
        definition: {
            id: 'localharness',
            title: 'Antigravity localharness',
            executable: 'localharness',
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
    };
}

function sourceFrom(contribution: ResolvedInstallableContribution) {
    const model = createV2ManagedDependencySourceModel({
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        architecture: process.arch,
        contributions: [contribution],
    });
    const dependency = model.resolve({
        pluginId: 'happier.agent.antigravity',
        localId: 'localharness',
    });
    const sourceInstallable = resolveExecutableManagedDependenciesRegistry(
        [contribution],
        {
            platform: process.platform,
            architecture: process.arch,
        },
    ).descriptorsByKey['dep.antigravity.localharness']?.descriptor;
    if (!sourceInstallable) throw new Error('Expected canonical managed PyPI source installable');
    return { dependency, source: dependency.sources[0]!, sourceInstallable };
}

describe('createProductionManagedDependencySourceAdapter', () => {
    it('refuses a managed PyPI source without its canonical source-acquisition installable', async () => {
        const { sourceInstallable: _sourceInstallable, ...input } = sourceFrom(
            antigravityContribution(),
        );

        await expect(createProductionManagedDependencySourceAdapter(input))
            .rejects.toMatchObject({ code: 'plugin_managed_dependency_source_invalid' });
    });

    it('adapts a bundled managed PyPI wheel declaration through the canonical install owner', async () => {
        const adapter = await createProductionManagedDependencySourceAdapter(
            sourceFrom(antigravityContribution()),
        );

        expect(adapter).toMatchObject({
            key: 'dep.antigravity.localharness',
            capabilityId: 'dep.antigravity.localharness',
        });
        expect(adapter.resolveLaunchCommand).toEqual(expect.any(Function));
    });

    it.each([
        ['darwin', 'arm64'],
        ['linux', 'x64'],
        ['linux', 'arm64'],
        ['win32', 'x64'],
        ['win32', 'arm64'],
    ] as const)('accepts the declared %s/%s wheel asset', async (platform, architecture) => {
        await expect(createProductionManagedDependencySourceAdapter({
            ...sourceFrom(antigravityContribution()),
            platform,
            architecture,
        })).resolves.toMatchObject({
            key: 'dep.antigravity.localharness',
        });
    });

    it('rejects an undeclared macOS x64 asset instead of reporting a supported missing install', async () => {
        await expect(createProductionManagedDependencySourceAdapter({
            ...sourceFrom(antigravityContribution()),
            platform: 'darwin',
            architecture: 'x64',
        })).rejects.toMatchObject({
            code: 'plugin_managed_dependency_architecture_unsupported',
        });
    });

    it('adapts a trusted installed external package without a provenance capability gate', async () => {
        await expect(createProductionManagedDependencySourceAdapter(
            sourceFrom(antigravityContribution('package')),
        )).resolves.toMatchObject({
            key: 'dep.antigravity.localharness',
            capabilityId: 'dep.antigravity.localharness',
        });
    });
});
