import type {
  AgentId,
  AgentCliManagedInstallSpec,
  AgentCliInstallPlatform as ProviderCliInstallPlatform,
} from '@happier-dev/agents';
import { getAgentCliRuntimeSpec } from '@happier-dev/agents';

import type { ManagedInstallDeps } from './install/managedInstall.js';
import { runRuntimeInstallCoordinator } from './install/runtimeInstallCoordinator.js';
import {
  type ProviderCliRuntimeDescriptor,
} from './resolution.js';

export type ProviderCliInstallCommand = Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
  requiresAdmin: boolean;
  note: string | null;
}>;

export type ProviderCliInstallMode = 'vendor_recipe' | 'managed_package' | 'github_release_binary';

export type ProviderCliInstallPlan = Readonly<{
  providerId: string;
  title: string;
  binaries: ReadonlyArray<string>;
  platform: ProviderCliInstallPlatform;
  docsUrl: string | null;
  commands: ReadonlyArray<ProviderCliInstallCommand>;
  requiresAdmin: boolean;
  installMode: ProviderCliInstallMode;
  managedInstall: AgentCliManagedInstallSpec | null;
}>;

export type ProviderCliInstallPlanResult =
  | Readonly<{ ok: true; plan: ProviderCliInstallPlan }>
  | Readonly<{ ok: false; errorCode: 'no-recipe'; errorMessage: string }>;

export type InstallProviderCliResult =
  | Readonly<{ ok: true; plan: ProviderCliInstallPlan; alreadyInstalled: boolean; logPath: string | null }>
  | Readonly<{
      ok: false;
      errorCode:
        | 'no-recipe'
        | 'vendor-recipe-disallowed'
        | 'command-not-found'
        | 'command-exec-failed'
        | 'command-timed-out'
        | 'command-failed'
        | 'managed-runtime-unavailable';
      errorMessage: string;
      plan: ProviderCliInstallPlan | null;
      logPath: string | null;
    }>;

type InstallProviderCliDeps = ManagedInstallDeps;

export function resolvePlatformFromNodePlatform(nodePlatform: string): ProviderCliInstallPlatform | null {
  if (nodePlatform === 'darwin') return 'darwin';
  if (nodePlatform === 'linux') return 'linux';
  if (nodePlatform === 'win32') return 'win32';
  return null;
}

function resolveProviderInstallCommands(
  runtimeSpec: ProviderCliRuntimeDescriptor,
  platform: ProviderCliInstallPlatform,
): ReadonlyArray<ProviderCliInstallCommand> | null {
  const commandsRaw = runtimeSpec.manualInstallRecipes?.[platform] ?? null;
  if (!commandsRaw || commandsRaw.length === 0) return null;
  return commandsRaw.map((c) => ({
    cmd: c.cmd,
    args: [...c.args],
    requiresAdmin: Boolean(c.requiresAdmin),
    note: typeof c.note === 'string' ? c.note : null,
  }));
}

export function planProviderCliInstallForRuntime(params: Readonly<{
  runtimeSpec: ProviderCliRuntimeDescriptor;
  platform: ProviderCliInstallPlatform;
}>): ProviderCliInstallPlanResult {
  const runtimeSpec = params.runtimeSpec;
  const commands = resolveProviderInstallCommands(runtimeSpec, params.platform);

  if (runtimeSpec.managedInstall) {
    return {
      ok: true,
      plan: {
        providerId: runtimeSpec.id,
        title: runtimeSpec.title,
        binaries: [runtimeSpec.binaryName],
        platform: params.platform,
        docsUrl: typeof runtimeSpec.docsUrl === 'string' ? runtimeSpec.docsUrl : null,
        commands: [],
        requiresAdmin: false,
        installMode: runtimeSpec.managedInstall.kind,
        managedInstall: runtimeSpec.managedInstall,
      },
    };
  }

  if (!commands) {
    return {
      ok: false,
      errorCode: 'no-recipe',
      errorMessage: `No auto-install recipe available for ${runtimeSpec.id} on ${params.platform}.`,
    };
  }

  const requiresAdmin = commands.some((c) => c.requiresAdmin);
  return {
    ok: true,
    plan: {
      providerId: runtimeSpec.id,
      title: runtimeSpec.title,
      binaries: [runtimeSpec.binaryName],
      platform: params.platform,
      docsUrl: typeof runtimeSpec.docsUrl === 'string' ? runtimeSpec.docsUrl : null,
      commands,
      requiresAdmin,
      installMode: 'vendor_recipe',
      managedInstall: null,
    },
  };
}

export function planProviderCliInstall(params: Readonly<{ providerId: AgentId; platform: ProviderCliInstallPlatform }>): ProviderCliInstallPlanResult {
  return planProviderCliInstallForRuntime({
    runtimeSpec: getAgentCliRuntimeSpec(params.providerId),
    platform: params.platform,
  });
}

export async function installProviderCliForRuntime(params: Readonly<{
  runtimeSpec: ProviderCliRuntimeDescriptor;
  platform: ProviderCliInstallPlatform;
  env?: NodeJS.ProcessEnv;
  logDir?: string | null;
  dryRun?: boolean;
  skipIfInstalled?: boolean;
  allowVendorRecipeExecution?: boolean;
  deps?: InstallProviderCliDeps;
}>): Promise<InstallProviderCliResult> {
  const runtimeSpec = params.runtimeSpec;
  const env = params.env ?? process.env;
  const deps = params.deps ?? {};

  const planned = planProviderCliInstallForRuntime({ runtimeSpec, platform: params.platform });
  if (!planned.ok) {
    return { ok: false, errorCode: planned.errorCode, errorMessage: planned.errorMessage, plan: null, logPath: null };
  }

  return runRuntimeInstallCoordinator({
    runtimeSpec,
    plan: planned.plan,
    env,
    logDir: params.logDir,
    dryRun: params.dryRun,
    skipIfInstalled: params.skipIfInstalled,
    allowVendorRecipeExecution: params.allowVendorRecipeExecution,
    deps,
  });
}

export async function installProviderCli(params: Readonly<{
  providerId: AgentId;
  platform: ProviderCliInstallPlatform;
  env?: NodeJS.ProcessEnv;
  logDir?: string | null;
  dryRun?: boolean;
  skipIfInstalled?: boolean;
  allowVendorRecipeExecution?: boolean;
  deps?: InstallProviderCliDeps;
}>): Promise<InstallProviderCliResult> {
  return installProviderCliForRuntime({
    runtimeSpec: getAgentCliRuntimeSpec(params.providerId),
    platform: params.platform,
    env: params.env,
    logDir: params.logDir,
    dryRun: params.dryRun,
    skipIfInstalled: params.skipIfInstalled,
    allowVendorRecipeExecution: params.allowVendorRecipeExecution,
    deps: params.deps,
  });
}
