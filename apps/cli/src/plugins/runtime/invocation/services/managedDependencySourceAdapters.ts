import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { RuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import type { InstallableDependencyDescriptor } from '@happier-dev/protocol/installables';
import { getManagedPypiWheelAssetRuntimeInstallableAdapter } from '@/packagedRuntime/installables/sourceAdapters/pypiWheelAsset';
import type {
    ManagedDependencySourceModelDependency,
    ManagedDependencySourceModelEntry,
} from './managedDependencySourceModel';

async function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    if (process.platform === 'win32') return await resolveWindowsCommandOnPath(command, env);
    const path = env.PATH;
    if (!path) return null;
    for (const directory of path.split(delimiter).map((entry) => entry.trim()).filter(Boolean)) {
        const candidate = join(directory, command);
        try {
            await access(candidate, fsConstants.X_OK);
            return candidate;
        } catch {
            // Continue through the bounded PATH entries.
        }
    }
    return null;
}

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

export async function createProductionManagedDependencySourceAdapter(input: Readonly<{
    dependency: ManagedDependencySourceModelDependency;
    source: ManagedDependencySourceModelEntry;
    sourceInstallable?: InstallableDependencyDescriptor;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    architecture?: string;
}>): Promise<RuntimeInstallableAdapter> {
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
    const defaultEnv = input.env ?? process.env;
    const resolve = async (env: NodeJS.ProcessEnv = defaultEnv): Promise<string | null> => {
        for (const executableName of executableNames) {
            const command = await resolveCommandOnPath(executableName, env);
            if (command) return command;
        }
        return null;
    };
    return Object.freeze({
        key: input.dependency.identity.localId,
        capabilityId: `dep.${input.dependency.identity.localId}`,
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
