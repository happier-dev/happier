import { dirname, isAbsolute, join } from 'node:path';

import type { InstallableDependencyDescriptor } from '@happier-dev/protocol/installables';
import { PluginManagedDependencyContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/managedDependencies';
import {
    installAgentCliForRuntime, removeAgentCliManagedInstallForRuntime,
    resolveAgentCliManagedCommandPathForRuntime, resolveDirectJavaScriptRuntimeCommand,
    resolveExistingManagedJavaScriptRuntimeCommand, resolvePlatformFromNodePlatform,
    resolveManagedPackageJavaScriptEntry,
    type AgentCliRuntimeDescriptor,
} from '@happier-dev/cli-common/agents';

import { configuration } from '@/configuration';
import type { RuntimeInstallableAdapter, RuntimeInstallableLaunchCommandResolution } from '../registry';

/** npm bin metadata selects the JS entry; neither PATH nor its generated shell shim is execution authority. */
export function getManagedJavaScriptPackageRuntimeInstallableAdapter(
    descriptor: InstallableDependencyDescriptor,
): RuntimeInstallableAdapter | null {
    const source = descriptor.source;
    if (source.kind !== 'managed_package' || source.packageManager !== 'managed_js_runtime'
        || !source.version || descriptor.binary.commands.length !== 1) return null;
    const binaryName = descriptor.binary.commands[0];
    // A general installable is another ingress; use the same closed package grammar as plugin declarations.
    if (!PluginManagedDependencyContributionV2Schema.safeParse({ id: 'package', title: descriptor.display.name,
        executable: binaryName, sources: [{ kind: 'managedJavaScriptPackage', installId: descriptor.capabilityId,
            packageName: source.packageName, version: source.version }] }).success) return null;
    const packageName = source.packageName;
    const version = source.version;
    // Reuse the canonical package acquisition/coordinator and its lock, promotion, cancellation and cleanup.
    // This runtime descriptor is an installation recipe, never an Agent contribution or session binding.
    const runtimeSpec: AgentCliRuntimeDescriptor = {
        id: descriptor.key, title: descriptor.display.name, binaryName, sourcePreferenceDefault: 'managed-first',
        managedInstall: { kind: 'managed_package', packageName: `${packageName}@${version}`, binaryName,
            packageBinarySetup: { kind: 'npm_package_bin', packageName, version, bin: binaryName } },
        manualInstallKind: 'none', manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false,
    };
    const environment = (env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => env ?? { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir };
    const unavailable = (): RuntimeInstallableLaunchCommandResolution => ({ ok: false,
        errorMessage: 'The pinned JavaScript package or managed runtime is not installed', canAutoInstall: false });
    const resolve = async (env?: NodeJS.ProcessEnv): Promise<RuntimeInstallableLaunchCommandResolution> => {
        const processEnv = environment(env);
        const selectedRuntime = resolveExistingManagedJavaScriptRuntimeCommand(processEnv);
        if (!selectedRuntime) return unavailable();
        const command = resolveDirectJavaScriptRuntimeCommand({ isBunRuntime: false, processEnv, currentExecPath: selectedRuntime });
        if (!command || !isAbsolute(command)) return unavailable();
        const launcher = resolveAgentCliManagedCommandPathForRuntime(runtimeSpec, { processEnv });
        const executable = resolveManagedPackageJavaScriptEntry({
            workspaceDir: join(dirname(dirname(launcher)), 'workspace'), packageName, version, bin: binaryName,
        });
        return executable ? { ok: true, command, args: [executable], source: 'managed' } : unavailable();
    };
    return {
        key: descriptor.key, capabilityId: descriptor.capabilityId,
        async detectCapabilityStatus(params = {}) {
            const installed = (await resolve(params.env)).ok;
            // One producer serves managed-dependency readiness and the capability/Tools reader.
            return { installed, installedVersion: installed ? version : null, sourceKind: 'managed_package',
                ...(installed ? { version, availableVersion: version } : {}) };
        },
        async detectLaunchResolution(params = {}) {
            const launch = await resolve(params.env);
            return { availability: launch.ok ? { ok: true } : { ok: false, errorMessage: launch.errorMessage },
                canAutoInstall: false, canBackgroundAutoUpdate: false };
        },
        resolveLaunchCommand: params => resolve(params?.env),
        async installOrUpgrade(options = {}) {
            const platform = resolvePlatformFromNodePlatform(process.platform);
            if (!platform) return { ok: false, errorMessage: 'Managed JavaScript packages are unavailable on this platform', logPath: null };
            const result = await installAgentCliForRuntime({ runtimeSpec, platform, env: environment(options.env),
                sourcePolicy: 'managed_only', skipIfInstalled: false, signal: options.signal, onProgress: options.onProgress });
            if (!result.ok) return { ok: false, errorMessage: result.errorMessage, logPath: result.logPath };
            const launch = await resolve(options.env);
            return launch.ok ? { ok: true, logPath: result.logPath }
                : { ok: false, errorMessage: launch.errorMessage, logPath: result.logPath };
        },
        async removeManagedInstall(options = {}) {
            await removeAgentCliManagedInstallForRuntime({ runtimeSpec, env: environment(options.env), signal: options.signal });
        },
        async runBackgroundAutoUpdateCheck() {},
    };
}
