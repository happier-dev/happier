import type {
  AgentId,
  AgentCliManagedInstallSpec,
  AgentCliInstallPlatform as AgentCliInstallPlatform,
} from '@happier-dev/agents';
import { getAgentCliRuntimeSpec } from '@happier-dev/agents';

import type { ManagedInstallDeps } from './install/managedInstall.js';
import { runRuntimeInstallCoordinator } from './install/runtimeInstallCoordinator.js';
import { runRuntimeInstallPreflight } from './install/runtimeInstallPreflight.js';
import {
  type AgentCliRuntimeDescriptor,
} from './resolution.js';

export type AgentCliInstallCommand = Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
  requiresAdmin: boolean;
  note: string | null;
}>;

export type AgentCliInstallMode = 'vendor_recipe' | 'managed_package' | 'github_release_binary';

export type AgentCliInstallPlan = Readonly<{
  agentId: string;
  title: string;
  binaries: ReadonlyArray<string>;
  platform: AgentCliInstallPlatform;
  docsUrl: string | null;
  commands: ReadonlyArray<AgentCliInstallCommand>;
  requiresAdmin: boolean;
  installMode: AgentCliInstallMode;
  managedInstall: AgentCliManagedInstallSpec | null;
}>;

export type AgentCliInstallPlanResult =
  | Readonly<{ ok: true; plan: AgentCliInstallPlan }>
  | Readonly<{ ok: false; errorCode: 'no-recipe'; errorMessage: string }>;

export type InstallAgentCliResult =
  | Readonly<{ ok: true; plan: AgentCliInstallPlan; alreadyInstalled: boolean; logPath: string | null }>
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
      plan: AgentCliInstallPlan | null;
      logPath: string | null;
    }>;

type InstallAgentCliDeps = ManagedInstallDeps;

export function resolvePlatformFromNodePlatform(nodePlatform: string): AgentCliInstallPlatform | null {
  if (nodePlatform === 'darwin') return 'darwin';
  if (nodePlatform === 'linux') return 'linux';
  if (nodePlatform === 'win32') return 'win32';
  return null;
}

function resolveAgentInstallCommands(
  runtimeSpec: AgentCliRuntimeDescriptor,
  platform: AgentCliInstallPlatform,
): ReadonlyArray<AgentCliInstallCommand> | null {
  const commandsRaw = runtimeSpec.manualInstallRecipes?.[platform] ?? null;
  if (!commandsRaw || commandsRaw.length === 0) return null;
  return commandsRaw.map((c) => ({
    cmd: c.cmd,
    args: [...c.args],
    requiresAdmin: Boolean(c.requiresAdmin),
    note: typeof c.note === 'string' ? c.note : null,
  }));
}

function resolveAgentInstallDocsUrl(runtimeSpec: AgentCliRuntimeDescriptor): string | null {
  return typeof runtimeSpec.installGuideUrl === 'string'
    ? runtimeSpec.installGuideUrl
    : typeof runtimeSpec.docsUrl === 'string'
      ? runtimeSpec.docsUrl
      : null;
}

export function planAgentCliInstallForRuntime(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  platform: AgentCliInstallPlatform;
}>): AgentCliInstallPlanResult {
  const runtimeSpec = params.runtimeSpec;
  const commands = resolveAgentInstallCommands(runtimeSpec, params.platform);

  if (runtimeSpec.managedInstall) {
    return {
      ok: true,
      plan: {
        agentId: runtimeSpec.id,
        title: runtimeSpec.title,
        binaries: [runtimeSpec.binaryName],
        platform: params.platform,
        docsUrl: resolveAgentInstallDocsUrl(runtimeSpec),
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
      agentId: runtimeSpec.id,
      title: runtimeSpec.title,
      binaries: [runtimeSpec.binaryName],
      platform: params.platform,
      docsUrl: resolveAgentInstallDocsUrl(runtimeSpec),
      commands,
      requiresAdmin,
      installMode: 'vendor_recipe',
      managedInstall: null,
    },
  };
}

export function planAgentCliInstall(params: Readonly<{ agentId: AgentId; platform: AgentCliInstallPlatform }>): AgentCliInstallPlanResult {
  return planAgentCliInstallForRuntime({
    runtimeSpec: getAgentCliRuntimeSpec(params.agentId),
    platform: params.platform,
  });
}

function createInstalledOnlyAgentCliInstallPlan(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  platform: AgentCliInstallPlatform;
}>): AgentCliInstallPlan {
  const runtimeSpec = params.runtimeSpec;
  return {
    agentId: runtimeSpec.id,
    title: runtimeSpec.title,
    binaries: [runtimeSpec.binaryName],
    platform: params.platform,
    docsUrl: resolveAgentInstallDocsUrl(runtimeSpec),
    commands: [],
    requiresAdmin: false,
    installMode: runtimeSpec.managedInstall?.kind ?? 'vendor_recipe',
    managedInstall: runtimeSpec.managedInstall ?? null,
  };
}

export async function installAgentCliForRuntime(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  platform: AgentCliInstallPlatform;
  env?: NodeJS.ProcessEnv;
  logDir?: string | null;
  dryRun?: boolean;
  skipIfInstalled?: boolean;
  allowVendorRecipeExecution?: boolean;
  deps?: InstallAgentCliDeps;
}>): Promise<InstallAgentCliResult> {
  const runtimeSpec = params.runtimeSpec;
  const env = params.env ?? process.env;
  const deps = params.deps ?? {};

  const planned = planAgentCliInstallForRuntime({ runtimeSpec, platform: params.platform });
  if (!planned.ok) {
    if (params.skipIfInstalled !== false) {
      const installedOnlyPlan = createInstalledOnlyAgentCliInstallPlan({
        runtimeSpec,
        platform: params.platform,
      });
      const preflight = runRuntimeInstallPreflight({
        runtimeSpec,
        plan: installedOnlyPlan,
        env,
        dryRun: params.dryRun,
        skipIfInstalled: params.skipIfInstalled,
        allowVendorRecipeExecution: params.allowVendorRecipeExecution,
      });
      if (
        preflight.kind === 'return'
        && preflight.result.ok
        && preflight.result.alreadyInstalled
      ) {
        return preflight.result;
      }
    }
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

export async function installAgentCli(params: Readonly<{
  agentId: AgentId;
  platform: AgentCliInstallPlatform;
  env?: NodeJS.ProcessEnv;
  logDir?: string | null;
  dryRun?: boolean;
  skipIfInstalled?: boolean;
  allowVendorRecipeExecution?: boolean;
  deps?: InstallAgentCliDeps;
}>): Promise<InstallAgentCliResult> {
  return installAgentCliForRuntime({
    runtimeSpec: getAgentCliRuntimeSpec(params.agentId),
    platform: params.platform,
    env: params.env,
    logDir: params.logDir,
    dryRun: params.dryRun,
    skipIfInstalled: params.skipIfInstalled,
    allowVendorRecipeExecution: params.allowVendorRecipeExecution,
    deps: params.deps,
  });
}
