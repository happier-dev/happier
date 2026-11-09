import {
  installAgentCliForRuntime, resolveAgentCliCommandForRuntime,
  resolvePlatformFromNodePlatform, type AgentCliRuntimeDescriptor,
  managedAcpInstallId, hasAgentCliManagedInstallForRuntime,
  buildManagedUvAgentEnvironment, installManagedUvAgent, resolveManagedUvAgentCommand, type ManagedUvAgentSpec,
} from '@happier-dev/cli-common/agents';
import type { AccountSettings, InstallableDependencyDescriptor } from '@happier-dev/protocol';
import { InstallableDependencyDescriptorSchema } from '@happier-dev/protocol/installables';
import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { resolveAcpPlatformFitV1, type AcpPlatformFitV1 } from '@happier-dev/protocol/acp/catalog/registry/acpPlatformFitV1';
import { isPackageRunnerCommand, normalizePackageRunnerInvocation } from '@/packagedRuntime/packageRunner/normalizePackageRunnerInvocation';
import { getRuntimeInstallableAdapterForDescriptor } from '@/packagedRuntime/installables/registry';
import { ensureRuntimeInstallableDescriptorForLaunch } from '@/packagedRuntime/installables/ensureForLaunch';
import { resolveEffectiveInstallablePolicy } from '@happier-dev/protocol/installablesPolicy';
import { hasPinnedArchiveManagedInstall } from '@/packagedRuntime/installables/sourceAdapters/pinnedArchive';
import { executeInstallCommand } from '@/capabilities/installJobs/executeInstallCommand';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';

export type AcpLaunchDefinition = Pick<AcpBackendDefinitionV1, 'id' | 'title' | 'launch'>;
export type AcpLaunchResolution =
  | Readonly<{ kind: 'ready'; command: string; args: readonly string[]; env: Readonly<Record<string, string>>; runtimeEnv?: Readonly<Record<string, string>> }>
  | Readonly<{ kind: 'needs_install'; installable: InstallableDependencyDescriptor }>
  | Readonly<{ kind: 'cant_run'; fit: AcpPlatformFitV1 }>;
export type AcpLaunchParams = Readonly<{
  accountId?: string;
  definition: AcpLaunchDefinition; platform: string | null; arch: string | null; env: ProcessEnvInput;
  launchEnv?: Readonly<Record<string, string>>;
  cwd?: string;
}>;

export function getAcpManagedInstallId(definition: Pick<AcpLaunchDefinition, 'id' | 'launch'>, accountId: string): string {
  if (definition.launch.kind === 'command') throw new Error('Command definitions have no managed installation');
  return managedAcpInstallId({ accountId, definitionId: definition.id, version: definition.launch.version });
}

function buildInstallable(definition: AcpLaunchDefinition, source: InstallableDependencyDescriptor['source'], accountId: string): InstallableDependencyDescriptor {
  const key = `dep.${getAcpManagedInstallId(definition, accountId)}` as const;
  return InstallableDependencyDescriptorSchema.parse({
    id: key, key, kind: 'dep', version: '1', capabilityId: key,
    display: { name: definition.title }, description: definition.title, source,
    binary: { commands: ['agent'], systemFirst: false, managedFallback: true },
    defaultPolicy: { autoInstallWhenNeeded: true, autoUpdateMode: 'off' },
    consent: { install: 'not_required', update: 'required' }, stability: { experimental: false, supported: true },
  });
}

export function getAcpArchiveInstallableDescriptor(definition: AcpLaunchDefinition, accountId: string): InstallableDependencyDescriptor | null {
  return definition.launch.kind === 'archive' ? buildInstallable(definition, {
    kind: 'pinned_archive', version: definition.launch.version, assetsByPlatform: definition.launch.assetsByPlatform,
  }, accountId) : null;
}

export function getAcpNpmRuntimeSpec(definition: AcpLaunchDefinition, accountId: string): AgentCliRuntimeDescriptor | null {
  const launch = definition.launch;
  if (launch.kind !== 'npm') return null;
  return {
    id: getAcpManagedInstallId(definition, accountId), title: definition.title, binaryName: 'agent', sourcePreferenceDefault: 'managed-first',
    managedInstall: { kind: 'managed_package', packageName: `${launch.package}@${launch.version}`, binaryName: 'agent',
      packageBinarySetup: { kind: 'npm_package_bin', packageName: launch.package, version: launch.version,
        managedAcpDefinition: { definitionId: definition.id, title: definition.title }, ...(launch.bin ? { bin: launch.bin } : {}) } },
    manualInstallKind: 'none', manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false,
  };
}

export function getAcpUvRuntimeSpec(definition: AcpLaunchDefinition, accountId: string): ManagedUvAgentSpec | null {
  const launch = definition.launch;
  return launch.kind === 'uv' ? { id: getAcpManagedInstallId(definition, accountId), definitionId: definition.id,
    title: definition.title, package: launch.package, version: launch.version, ...(launch.command ? { command: launch.command } : {}) } : null;
}

function archiveHost(params: AcpLaunchParams) {
  const fit = resolveAcpPlatformFitV1(params.definition.launch, { platform: params.platform, arch: params.arch });
  if (fit.kind !== 'can_run' || !fit.target) throw new Error('Archive launch has no supported host target');
  return {
    platform: fit.target.startsWith('win32-') ? 'win32' as const : fit.target.startsWith('darwin-') ? 'darwin' as const : 'linux' as const,
    architecture: fit.target.endsWith('-arm64') ? 'arm64' : 'x64',
  };
}

export async function resolveAcpLaunch(params: AcpLaunchParams): Promise<AcpLaunchResolution> {
  const launch = params.definition.launch;
  if (launch.kind === 'command') {
    if (isPackageRunnerCommand(launch.command)) {
      const normalized = await normalizePackageRunnerInvocation({ command: launch.command, args: launch.args, processEnv: params.env, launchEnv: params.launchEnv, cwd: params.cwd });
      if (!normalized) throw new Error(`Configured ACP command ${launch.command} was not found or is not executable. Install it on this machine or update the command and PATH.`);
      return { kind: 'ready', command: normalized.command, args: normalized.args, env: {} };
    }
    return { kind: 'ready', command: launch.command, args: launch.args, env: {} };
  }
  const fit = resolveAcpPlatformFitV1(launch, { platform: params.platform, arch: params.arch });
  if (fit.kind !== 'can_run') return { kind: 'cant_run', fit };
  if (launch.kind === 'uv') {
    const spec = getAcpUvRuntimeSpec(params.definition, params.accountId ?? '')!;
    const command = await resolveManagedUvAgentCommand(spec, params.env);
    return command ? { kind: 'ready', command, args: launch.args, env: {}, runtimeEnv: buildManagedUvAgentEnvironment(spec, params.env) }
      : { kind: 'needs_install', installable: buildInstallable(params.definition, {
        kind: 'managed_package', packageName: launch.package, version: launch.version, packageManager: 'managed_uv',
      }, params.accountId ?? '') };
  }
  if (launch.kind === 'npm') {
    const command = resolveAgentCliCommandForRuntime(getAcpNpmRuntimeSpec(params.definition, params.accountId ?? '')!, { processEnv: params.env, sourcePolicy: 'managed_only' });
    return command ? { kind: 'ready', command: command.command, args: launch.args, env: {} }
      : { kind: 'needs_install', installable: buildInstallable(params.definition, {
        kind: 'managed_package', packageName: launch.package, version: launch.version, packageManager: 'managed_js_runtime',
      }, params.accountId ?? '') };
  }
  const descriptor = getAcpArchiveInstallableDescriptor(params.definition, params.accountId ?? '')!;
  const adapter = await getRuntimeInstallableAdapterForDescriptor(descriptor, { ownerId: descriptor.id }, archiveHost(params));
  const command = await adapter.resolveLaunchCommand?.({ env: params.env });
  if (!command?.ok) return { kind: 'needs_install', installable: descriptor };
  return { kind: 'ready', command: command.command, args: [...command.args, ...launch.args],
    env: fit.target ? launch.envByPlatform?.[fit.target] ?? {} : {} };
}

export type AcpLaunchInstallParams = AcpLaunchParams & Readonly<{
  signal?: AbortSignal; onProgress?: Parameters<typeof installAgentCliForRuntime>[0]['onProgress']; intent?: 'install' | 'update'; force?: boolean;
}>;
export type AcpLaunchInstallResult = Readonly<{ ok: true; checksum?: 'verified' | 'not_published' }>
  | Readonly<{ ok: false; errorMessage: string; errorCode?: string; logPath: string | null }>;

export async function installAcpLaunch(params: AcpLaunchInstallParams,
  deps: Readonly<{ installerDeps?: Parameters<typeof installAgentCliForRuntime>[0]['deps'] }> = {},
): Promise<AcpLaunchInstallResult> {
  if (params.definition.launch.kind === 'command') return { ok: false, errorCode: 'not_managed', errorMessage: 'Command definitions have no managed install', logPath: null };
  const resolution = await resolveAcpLaunch(params);
  if (resolution.kind === 'cant_run') return { ok: false, errorMessage: 'Configured ACP launch is unavailable on this machine', logPath: null };
  if (resolution.kind === 'ready' && !params.force) {
    if (params.definition.launch.kind !== 'archive') return { ok: true };
    const fit = resolveAcpPlatformFitV1(params.definition.launch, { platform: params.platform, arch: params.arch });
    const asset = fit.kind === 'can_run' && fit.target ? params.definition.launch.assetsByPlatform[fit.target] : undefined;
    return { ok: true, checksum: asset?.sha256 ? 'verified' : 'not_published' };
  }
  const runtimeSpec = getAcpNpmRuntimeSpec(params.definition, params.accountId ?? '');
  if (runtimeSpec) {
    const platform = resolvePlatformFromNodePlatform(params.platform ?? '');
    if (!platform) return { ok: false, errorMessage: 'Unsupported npm install platform', logPath: null };
    const result = await installAgentCliForRuntime({ runtimeSpec, platform, env: params.env, sourcePolicy: 'managed_only',
      skipIfInstalled: !params.force && resolution.kind === 'ready', intent: params.intent, signal: params.signal, onProgress: params.onProgress, deps: deps.installerDeps });
    if (!result.ok) return result;
  } else if (params.definition.launch.kind === 'uv') {
    await installManagedUvAgent({ spec: getAcpUvRuntimeSpec(params.definition, params.accountId ?? '')!,
      env: params.env, signal: params.signal, onProgress: params.onProgress,
      runCommand: deps.installerDeps?.execFileWithDeadline ?? executeInstallCommand });
  } else if (params.definition.launch.kind === 'archive') {
    const descriptor = getAcpArchiveInstallableDescriptor(params.definition, params.accountId ?? '')!;
    const adapter = await getRuntimeInstallableAdapterForDescriptor(descriptor, { ownerId: descriptor.id }, archiveHost(params));
    const result = await adapter.installOrUpgrade({ env: params.env, signal: params.signal, onProgress: params.onProgress,
      managedAcpDefinition: { definitionId: params.definition.id, title: params.definition.title },
    });
    if (!result.ok) return result;
    const ready = await resolveAcpLaunch(params);
    if (ready.kind !== 'ready') return { ok: false, errorMessage: 'Installed ACP launch is not ready', logPath: result.logPath };
    return { ok: true, checksum: result.checksum };
  }
  return (await resolveAcpLaunch(params)).kind === 'ready' ? { ok: true }
    : { ok: false, errorMessage: 'Installed ACP launch is not ready', logPath: null };
}

export async function ensureAcpLaunchForSession(params: AcpLaunchParams & Readonly<{
  settings: AccountSettings | null | undefined; machineId: string;
}>, deps: Readonly<{ installerDeps?: Parameters<typeof installAgentCliForRuntime>[0]['deps'] }> = {}): Promise<Extract<AcpLaunchResolution, { kind: 'ready' }>> {
  let resolution = await resolveAcpLaunch(params);
  if (resolution.kind === 'needs_install') {
    const policy = resolveEffectiveInstallablePolicy({ descriptor: resolution.installable, settings: params.settings ?? {}, machineId: params.machineId });
    if (!policy.autoInstallWhenNeeded) throw new Error('Configured ACP automatic installation is disabled');
    const archive = getAcpArchiveInstallableDescriptor(params.definition, params.accountId ?? '');
    const npm = getAcpNpmRuntimeSpec(params.definition, params.accountId ?? '');
    const uv = getAcpUvRuntimeSpec(params.definition, params.accountId ?? '');
    // Session first-use has no daemon live-use authority to repair retained bytes.
    // A changed pin has a different root and remains an ordinary first acquisition.
    if (archive ? await hasPinnedArchiveManagedInstall({ installId: archive.capabilityId, env: params.env })
      : (npm ?? uv) && await hasAgentCliManagedInstallForRuntime({ runtimeSpec: (npm ?? uv)!, env: params.env })) {
      throw new Error('Existing managed ACP version is unavailable; remove or repair it after stopping its sessions');
    }
    const result = params.definition.launch.kind === 'archive'
      ? await ensureRuntimeInstallableDescriptorForLaunch({ descriptor: resolution.installable, settings: params.settings, machineId: params.machineId, env: params.env, host: archiveHost(params),
        managedAcpDefinition: { definitionId: params.definition.id, title: params.definition.title },
      })
      : await installAcpLaunch(params, deps);
    if (!result.ok) throw new Error(result.errorMessage);
    resolution = await resolveAcpLaunch(params);
  }
  if (resolution.kind !== 'ready') throw new Error('Configured ACP launch cannot run on this machine');
  return resolution;
}
