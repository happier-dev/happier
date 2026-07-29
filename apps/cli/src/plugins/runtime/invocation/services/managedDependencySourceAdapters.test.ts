import { describe, expect, it } from 'vitest';

import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';

import { createProductionManagedDependencySourceAdapter } from './managedDependencySourceAdapters';
import { createV2ManagedDependencySourceModel } from './managedDependencySourceModel';

function antigravityContribution(
    sourceKind: 'bundled' | 'path' = 'bundled',
): ResolvedInstallableContribution {
    return {
        provenance: sourceKind === 'bundled' ? 'first_party' : 'external',
        source: { kind: sourceKind },
        pluginId: 'happier.agent.antigravity',
        manifestPath: `${sourceKind}:happier.agent.antigravity`,
        manifestDigest: 'sha256:antigravity',
        daemonEntryPath: null,
        sourceSpec: {
            kind: sourceKind,
            locator: sourceKind === 'bundled'
                ? '@happier-dev/plugins-antigravity'
                : '/plugins/antigravity',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
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
        generationId: 'generation:managed-pypi',
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        architecture: process.arch,
        contributions: [contribution],
    });
    const dependency = model.resolve({
        pluginId: 'happier.agent.antigravity',
        localId: 'localharness',
    });
    return { dependency, source: dependency.sources[0]! };
}

describe('createProductionManagedDependencySourceAdapter', () => {
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

    it('rejects the trusted-code source for non-bundled plugins', async () => {
        await expect(createProductionManagedDependencySourceAdapter(
            sourceFrom(antigravityContribution('path')),
        )).rejects.toMatchObject({
            code: 'plugin_managed_dependency_source_disallowed',
        });
    });
});
