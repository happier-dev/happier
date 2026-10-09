import { basename, dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveInstallablesRegistry } from '@happier-dev/protocol/installables';

import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { resolveExecutableManagedDependenciesRegistry } from '@/plugins/projection/registry/managedDependencyExecutables';

import { createProductionManagedDependencySourceAdapter } from './managedDependencySourceAdapters';
import { createV2ManagedDependencySourceModel } from './managedDependencySourceModel';
import { createStablePluginManagedDependenciesHost } from './managedDependencies';

const processBoundary = vi.hoisted(() => ({ execFile: vi.fn() }));
// The operating-system process is the boundary; parsing, source resolution,
// dependency status and executable qualification remain real.
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
    execFileWithDeadline: processBoundary.execFile,
}));

const systemEnvironment = { PATH: dirname(process.execPath), PATHEXT: '.EXE;.CMD;.BAT', C55_SELECTED: 'selected' };
function systemHost(versionArguments?: string[]) {
    const sourceModel = createV2ManagedDependencySourceModel({
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        architecture: process.arch,
        contributions: [{
            ...antigravityContribution(),
            definition: { id: 'system-tool', title: 'System tool', executable: basename(process.execPath),
                sources: [{ kind: 'system', executableNames: [basename(process.execPath)],
                    ...(versionArguments === undefined ? {} : { versionArguments }) }],
            },
        }],
    });
    return createStablePluginManagedDependenciesHost({
        installablesRegistry: resolveInstallablesRegistry({}), sourceModel,
        getSettings: () => ({}), env: systemEnvironment,
        resolveAdapter: async () => { throw new Error('Legacy adapter must not be used'); },
        resolveSourceAdapter: async (input) => createProductionManagedDependencySourceAdapter({ ...input,
            env: { PATH: '' },
        }),
        removeManagedInstall: async () => {}, removeManagedSource: async () => {},
    }).bind('happier.agent.antigravity');
}

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

function antigravityPinnedContribution(
    facts: Readonly<{ version: string; sha256: string }> = { version: '1.1.1', sha256: 'a'.repeat(64) },
): ResolvedInstallableContribution {
    const asset = Object.freeze({
        archiveUrl: `https://dl.google.com/agy-acp-server-${facts.version}.zip`,
        sha256: facts.sha256,
        executableSubpath: 'agy_acp_server.par',
    });
    return {
        ...antigravityContribution(),
        definition: {
            id: 'agy-acp-server',
            title: 'Antigravity ACP server',
            executable: 'agy_acp_server',
            sources: [{
                kind: 'pinnedArchive',
                installId: 'dep.antigravity.agy-acp-server',
                version: facts.version,
                archiveExtractionLimits: {
                    maxArchiveBytes: 1024 * 1024 * 1024,
                    maxFileBytes: 2 * 1024 * 1024 * 1024,
                    maxExpandedBytes: 2 * 1024 * 1024 * 1024,
                    timeoutMs: 10 * 60_000,
                },
                assetsByPlatform: {
                    'darwin-arm64': asset,
                    'linux-x64': asset,
                    'linux-arm64': asset,
                    'win32-x64': asset,
                    'win32-arm64': asset,
                },
            }],
        },
    };
}

function sourceFrom(
    contribution: ResolvedInstallableContribution,
    identity: Readonly<{ localId: string; installId: string }> = {
        localId: 'localharness',
        installId: 'dep.antigravity.localharness',
    },
) {
    const model = createV2ManagedDependencySourceModel({
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        architecture: process.arch,
        contributions: [contribution],
    });
    const dependency = model.resolve({
        pluginId: 'happier.agent.antigravity',
        localId: identity.localId,
    });
    const sourceInstallable = resolveExecutableManagedDependenciesRegistry(
        [contribution],
        {
            platform: process.platform,
            architecture: process.arch,
        },
    ).descriptorsByKey[identity.installId]?.descriptor;
    if (!sourceInstallable) throw new Error('Expected canonical managed source installable');
    return { dependency, source: dependency.sources[0]!, sourceInstallable };
}

const PINNED_IDENTITY = Object.freeze({
    localId: 'agy-acp-server',
    installId: 'dep.antigravity.agy-acp-server',
});

describe('createProductionManagedDependencySourceAdapter', () => {
    it('publishes the qualified system version from declared native version arguments', async () => {
        processBoundary.execFile.mockReset().mockResolvedValue({ stdout: 'Version: v0.46.0\nCommit: 991967\n', stderr: '' });
        expect(await systemHost(['version']).status('system-tool')).toMatchObject({ state: 'ready', version: '0.46.0' });
        expect(processBoundary.execFile).toHaveBeenCalledWith(process.execPath, ['version'], expect.objectContaining({ env: systemEnvironment }));
    });

    it('keeps system versions unknown when the declared probe fails or is absent', async () => {
        processBoundary.execFile.mockReset().mockRejectedValue(Object.assign(new Error('Native probe failed'),
            { exitCode: 1, stdout: 'Version: v0.46.0\n', stderr: '' }));
        expect(await systemHost(['version']).status('system-tool')).toMatchObject({ state: 'ready', version: 'unknown' });
        processBoundary.execFile.mockClear();
        expect(await systemHost().status('system-tool')).toMatchObject({ state: 'ready', version: 'unknown' });
        expect(processBoundary.execFile).not.toHaveBeenCalled();
    });

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

    it('refuses a pinned archive source without its canonical source-acquisition installable', async () => {
        const { sourceInstallable: _sourceInstallable, ...input } = sourceFrom(
            antigravityPinnedContribution(),
            PINNED_IDENTITY,
        );

        await expect(createProductionManagedDependencySourceAdapter(input))
            .rejects.toMatchObject({ code: 'plugin_managed_dependency_source_invalid' });
    });

    it('refuses a pinned archive source whose canonical installable pins different immutable artifact facts', async () => {
        const losing = sourceFrom(antigravityPinnedContribution({
            version: '9.9.9',
            sha256: 'b'.repeat(64),
        }), PINNED_IDENTITY);
        const { sourceInstallable } = sourceFrom(
            antigravityPinnedContribution(),
            PINNED_IDENTITY,
        );

        await expect(createProductionManagedDependencySourceAdapter({
            ...losing,
            sourceInstallable,
        })).rejects.toMatchObject({ code: 'plugin_managed_dependency_source_invalid' });
    });

    it('adapts a pinned archive declaration through the canonical descriptor install owner', async () => {
        await expect(createProductionManagedDependencySourceAdapter(
            sourceFrom(antigravityPinnedContribution(), PINNED_IDENTITY),
        )).resolves.toMatchObject({
            key: 'dep.antigravity.agy-acp-server',
            capabilityId: 'dep.antigravity.agy-acp-server',
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
