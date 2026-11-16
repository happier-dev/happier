import { isDeepStrictEqual } from 'node:util';

import { resolveExecutableCommand } from '@happier-dev/cli-common/process';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { RuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import type { InstallableDependencyDescriptor } from '@happier-dev/protocol/installables';
import { getManagedPypiWheelAssetRuntimeInstallableAdapter } from '@/packagedRuntime/installables/sourceAdapters/pypiWheelAsset';
import { getPinnedArchiveRuntimeInstallableAdapter } from '@/packagedRuntime/installables/sourceAdapters/pinnedArchive';
import { getManagedJavaScriptPackageRuntimeInstallableAdapter } from '@/packagedRuntime/installables/sourceAdapters/managedJavaScriptPackage';
import { getGitHubReleaseBinaryRuntimeInstallableAdapter } from '@/packagedRuntime/installables/sourceAdapters/githubReleaseBinary';
import { parseInstalledVersionFromOutput } from '@/packagedRuntime/installables/installedVersion';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import type {
    ManagedDependencySourceModelDependency,
    ManagedDependencySourceModelEntry,
} from './managedDependencySourceModel';

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function managedPypiWheelAssetPlatformKey(
    platform: NodeJS.Platform,
    architecture: string,
): string {
    const platformName = platform === 'darwin'
        ? 'darwin'
        : platform === 'linux'
            ? 'linux'
            : platform === 'win32'
                ? 'win32'
                : fail(
                    'plugin_managed_dependency_platform_unsupported',
                    'Managed PyPI wheel asset platform is unsupported',
                );
    if (architecture !== 'arm64' && architecture !== 'x64') {
        return fail(
            'plugin_managed_dependency_architecture_unsupported',
            'Managed PyPI wheel asset architecture is unsupported',
        );
    }
    return `${platformName}-${architecture}`;
}

function pinnedArchivePlatformKey(platform: NodeJS.Platform, architecture: string): string {
    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
        return fail('plugin_managed_dependency_platform_unsupported', 'Pinned archive platform is unsupported');
    }
    if (architecture !== 'arm64' && architecture !== 'x64') {
        return fail('plugin_managed_dependency_architecture_unsupported', 'Pinned archive architecture is unsupported');
    }
    return `${platform}-${architecture}`;
}

export async function createProductionManagedDependencySourceAdapter(input: Readonly<{
    dependency: ManagedDependencySourceModelDependency;
    source: ManagedDependencySourceModelEntry;
    sourceInstallable?: InstallableDependencyDescriptor;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    platform?: NodeJS.Platform;
    architecture?: string;
}>): Promise<RuntimeInstallableAdapter> {
    if (input.source.kind === 'managedJavaScriptPackage' && input.source.declaration.kind === 'managedJavaScriptPackage') {
        const source = input.source.declaration;
        const descriptor = input.sourceInstallable;
        if (!descriptor || descriptor.key !== source.installId || descriptor.id !== source.installId
            || descriptor.capabilityId !== source.installId || descriptor.binary.commands.length !== 1
            || descriptor.binary.commands[0] !== input.dependency.definition.executable
            || !isDeepStrictEqual(descriptor.source, { kind: 'managed_package', packageManager: 'managed_js_runtime',
                packageName: source.packageName, version: source.version })) {
            return fail('plugin_managed_dependency_source_invalid', 'Managed JavaScript package acquisition is unavailable');
        }
        return getManagedJavaScriptPackageRuntimeInstallableAdapter(descriptor)
            ?? fail('plugin_managed_dependency_source_invalid', 'Managed JavaScript package descriptor could not be adapted');
    }
    if (input.source.kind === 'githubReleaseBinary' && input.source.declaration.kind === 'githubReleaseBinary') {
        const { kind: _kind, installId, ...source } = input.source.declaration;
        const descriptor = input.sourceInstallable;
        if (!descriptor
            || descriptor.key !== installId.slice('dep.'.length)
            || descriptor.id !== descriptor.key
            || descriptor.capabilityId !== installId
            || descriptor.binary.commands.length !== 1
            || descriptor.binary.commands[0] !== input.dependency.definition.executable
            || !isDeepStrictEqual(descriptor.source, { ...source, kind: 'github_release_binary' })) {
            return fail('plugin_managed_dependency_source_invalid', 'GitHub release source acquisition is unavailable');
        }
        return await getGitHubReleaseBinaryRuntimeInstallableAdapter(descriptor)
            ?? fail('plugin_managed_dependency_source_invalid', 'GitHub release descriptor could not be adapted');
    }
    if (input.source.kind === 'pinnedArchive' && input.source.declaration.kind === 'pinnedArchive') {
        const source = input.source.declaration;
        const platform = input.platform ?? process.platform;
        const architecture = input.architecture ?? process.arch;
        const platformKey = pinnedArchivePlatformKey(platform, architecture);
        const asset = source.assetsByPlatform[platformKey as keyof typeof source.assetsByPlatform];
        if (!asset) {
            return fail(
                'plugin_managed_dependency_architecture_unsupported',
                'Pinned archive does not declare this platform and architecture',
            );
        }
        const descriptor = input.sourceInstallable;
        const expectedSource = Object.freeze({
            kind: 'pinned_archive' as const,
            version: source.version,
            ...(source.archiveExtractionLimits
                ? { archiveExtractionLimits: source.archiveExtractionLimits }
                : {}),
            assetsByPlatform: source.assetsByPlatform,
        });
        if (
            !descriptor
            || descriptor.id !== source.installId
            || descriptor.key !== source.installId
            || descriptor.capabilityId !== source.installId
            || descriptor.binary.commands.length !== 1
            || descriptor.binary.commands[0] !== input.dependency.definition.executable
            || !isDeepStrictEqual(descriptor.source, expectedSource)
        ) {
            return fail(
                'plugin_managed_dependency_source_invalid',
                'Pinned archive source acquisition is unavailable',
            );
        }
        return getPinnedArchiveRuntimeInstallableAdapter(descriptor, { platform, architecture })
            ?? fail(
                'plugin_managed_dependency_source_invalid',
                'Pinned archive descriptor could not be adapted',
            );
    }
    if (
        input.source.kind === 'managedPypiWheelAsset'
        && input.source.declaration.kind === 'managedPypiWheelAsset'
    ) {
        const source = input.source.declaration;
        const platformKey = managedPypiWheelAssetPlatformKey(
            input.platform ?? process.platform,
            input.architecture ?? process.arch,
        );
        if (!source.assetPathByPlatform[platformKey]) {
            return fail(
                'plugin_managed_dependency_architecture_unsupported',
                'Managed PyPI wheel asset does not declare this platform and architecture',
            );
        }
        const descriptor = input.sourceInstallable;
        const expectedSource = Object.freeze({
            kind: 'managed_pypi_wheel_asset' as const,
            distribution: source.distribution,
            versionSpecifier: source.versionSpecifier,
            assetPathByPlatform: source.assetPathByPlatform,
            executable: true as const,
            ...(source.compatibilityProbe
                ? { compatibilityProbe: source.compatibilityProbe }
                : {}),
            installConsent: source.installConsent,
            autoUpdateMode: source.autoUpdateMode,
            ...(source.trustedPublisher
                ? { trustedPublisher: source.trustedPublisher }
                : {}),
        });
        if (
            !descriptor
            || descriptor.id !== source.installId
            || descriptor.key !== source.installId
            || descriptor.capabilityId !== source.installId
            || descriptor.binary.commands.length !== 1
            || descriptor.binary.commands[0] !== input.dependency.definition.executable
            || !isDeepStrictEqual(descriptor.source, expectedSource)
        ) {
            return fail(
                'plugin_managed_dependency_source_invalid',
                'Managed PyPI wheel asset source acquisition is unavailable',
            );
        }
        return await getManagedPypiWheelAssetRuntimeInstallableAdapter(
            descriptor,
            input.dependency.identity.pluginId,
        )
            ?? fail(
                'plugin_managed_dependency_source_invalid',
                'Managed PyPI wheel asset descriptor could not be adapted',
            );
    }
    if (input.source.kind !== 'system' || input.source.declaration.kind !== 'system') {
        return fail(
            'plugin_managed_dependency_source_unsupported',
            'Managed dependency source is not executable by this host',
        );
    }
    const executableNames = Object.freeze([...input.source.declaration.executableNames]);
    const versionArguments = input.source.declaration.versionArguments;
    const defaultEnv = input.env ?? process.env;
    const resolve = async (env: NodeJS.ProcessEnv = defaultEnv): Promise<string | null> => {
        for (const executableName of executableNames) {
            const command = resolveExecutableCommand(executableName, { env, cwd: input.cwd });
            if (command) return command;
        }
        return null;
    };
    return Object.freeze({
        key: input.dependency.identity.localId,
        capabilityId: `dep.${input.dependency.identity.localId}`,
        async detectCapabilityStatus(params = {}) {
            const env = params.env ?? defaultEnv;
            const command = await resolve(env);
            if (!command || versionArguments === undefined) return { version: null };
            // Reuse the canonical process probe and its budget. Only explicitly
            // declared native arguments run, using the same environment as PATH
            // selection; failed probes never qualify a version from their output.
            const result = await runCliCommandBestEffort({
                resolvedPath: command, args: [...versionArguments], processEnv: env,
                cwd: input.cwd,
            });
            return { version: result.ok ? parseInstalledVersionFromOutput(
                input.dependency.definition.executable ?? executableNames[0]!, result.stdout,
            ) : null };
        },
        async detectLaunchResolution(params = {}) {
            const command = await resolve(params.env ?? defaultEnv);
            return command
                ? Object.freeze({
                    availability: Object.freeze({ ok: true as const }),
                    canAutoInstall: false,
                    canBackgroundAutoUpdate: false,
                })
                : Object.freeze({
                    availability: Object.freeze({ ok: false as const, errorMessage: 'System executable is unavailable' }),
                    canAutoInstall: false,
                    canBackgroundAutoUpdate: false,
                });
        },
        async resolveLaunchCommand(params = {}) {
            const command = await resolve(params.env ?? defaultEnv);
            return command
                ? Object.freeze({ ok: true as const, command, args: Object.freeze([]), source: 'system' as const })
                : Object.freeze({
                    ok: false as const,
                    errorMessage: 'System executable is unavailable',
                    canAutoInstall: false,
                });
        },
        async installOrUpgrade() {
            return Object.freeze({
                ok: false as const,
                errorMessage: 'System dependencies are externally managed',
                logPath: null,
            });
        },
        async runBackgroundAutoUpdateCheck() {},
    });
}
