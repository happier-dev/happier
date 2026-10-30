import type { AgentId } from '@happier-dev/agents/agent-ids';
import {
  getAgentCliRuntimeSpec,
  type AgentCliManagedInstallSpec,
  type AgentCliInstallPlatform,
} from '@happier-dev/agents/cli/runtime';
import { resolveAgentSetupHostPlatform } from '@happier-dev/protocol/agents/setup';

import type { ManagedInstallDeps } from './install/managedInstall.js';
import { updateInstalledAgentCli } from './install/nativeUpdateInstall.js';
import { runRuntimeInstallCoordinator } from './install/runtimeInstallCoordinator.js';
import { runRuntimeInstallPreflight } from './install/runtimeInstallPreflight.js';
import {
  type AgentCliResolutionSource,
  type AgentCliRuntimeDescriptor,
  type AgentCliSourcePolicy,
} from './resolution.js';
import { classifyAgentCliInstall } from './update.js';
import type { AgentInstallProgressCallback } from './installProgress.js';
export type { AgentInstallProgressEvent, AgentInstallProgressCallback } from './installProgress.js';

export type AgentCliInstallCommand = Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
  requiresAdmin: boolean;
  note: string | null;
}>;

export type AgentCliInstallMode = 'vendor_recipe' | 'managed_package' | 'github_release_binary';
export type AgentCliInstallIntent = 'install' | 'update';

/**
 * The installed executable an `update` intent acts on: exactly what detect reported. With it, the
 * update goes to that install's owner (managed reinstall, or the declared vendor updater) and a
 * package-manager install is refused with its own command. Without it only the managed install is
 * updated.
 */
export type AgentCliUpdateTarget = Readonly<{
  command: string;
  source: AgentCliResolutionSource;
}>;

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
        | 'archive-expanded-byte-limit'
        | 'managed-runtime-unavailable'
        | 'download-failed'
        | 'rate-limited'
        | 'verification-failed'
        | 'termination-failed'
        | 'update-not-available';
      errorMessage: string;
      plan: AgentCliInstallPlan | null;
      logPath: string | null;
    }>;

type InstallAgentCliDeps = ManagedInstallDeps;

export function resolvePlatformFromNodePlatform(nodePlatform: string): AgentCliInstallPlatform | null {
  return resolveAgentSetupHostPlatform(nodePlatform);
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

/**
 * Bundled-recipe convenience wrapper.
 *
 * The generated CLI runtime table covers bundled Agents only. An externally
 * installed Agent carries its own CLI descriptor in its plugin manifest and
 * installs through {@link planAgentCliInstallForRuntime} with that descriptor,
 * so an id with no bundled recipe reports the same typed `no-recipe` outcome as
 * a bundled Agent that ships none.
 */
export function planAgentCliInstall(params: Readonly<{ agentId: AgentId; platform: AgentCliInstallPlatform }>): AgentCliInstallPlanResult {
  const runtimeSpec = getAgentCliRuntimeSpec(params.agentId);
  if (runtimeSpec == null) {
    return {
      ok: false,
      errorCode: 'no-recipe',
      errorMessage: `No auto-install recipe available for ${params.agentId} on ${params.platform}.`,
    };
  }
  return planAgentCliInstallForRuntime({
    runtimeSpec,
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
  intent?: AgentCliInstallIntent;
  updateTarget?: AgentCliUpdateTarget;
  allowVendorRecipeExecution?: boolean;
  sourcePolicy?: AgentCliSourcePolicy;
  signal?: AbortSignal;
  onProgress?: AgentInstallProgressCallback;
  deps?: InstallAgentCliDeps;
}>): Promise<InstallAgentCliResult> {
  params.signal?.throwIfAborted();
  const runtimeSpec = params.runtimeSpec;
  const env = params.env ?? process.env;
  const deps = params.deps ?? {};

  const planned = planAgentCliInstallForRuntime({ runtimeSpec, platform: params.platform });
  if (params.intent === 'update' && params.updateTarget) {
    const facts = classifyAgentCliInstall({
      runtimeSpec,
      command: params.updateTarget.command,
      source: params.updateTarget.source,
      platform: params.platform,
      env,
    });
    // A managed install continues to the managed reinstall below; every other owner is handled
    // here, so an update never adds a managed copy beside a CLI the user installed.
    if (facts.installSource !== 'managed') {
      return await updateInstalledAgentCli({
        runtimeSpec,
        plan: planned.ok ? planned.plan : createInstalledOnlyAgentCliInstallPlan({ runtimeSpec, platform: params.platform }),
        command: params.updateTarget.command,
        facts,
        env,
        logDir: params.logDir,
        dryRun: params.dryRun,
        allowVendorRecipeExecution: params.allowVendorRecipeExecution,
        signal: params.signal,
        onProgress: params.onProgress,
        deps,
      });
    }
  }
  if (
    params.intent === 'update'
    && (!planned.ok || planned.plan.managedInstall === null)
  ) {
    return {
      ok: false,
      errorCode: 'update-not-available',
      errorMessage: `No managed update is available for ${runtimeSpec.id} on ${params.platform}.`,
      plan: planned.ok ? planned.plan : null,
      logPath: null,
    };
  }
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
        intent: params.intent,
        allowVendorRecipeExecution: params.allowVendorRecipeExecution,
        sourcePolicy: params.sourcePolicy,
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
    signal: params.signal,
    onProgress: params.onProgress,
    dryRun: params.dryRun,
    skipIfInstalled: params.skipIfInstalled,
    intent: params.intent,
    allowVendorRecipeExecution: params.allowVendorRecipeExecution,
    sourcePolicy: params.sourcePolicy,
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
  intent?: AgentCliInstallIntent;
  updateTarget?: AgentCliUpdateTarget;
  allowVendorRecipeExecution?: boolean;
  sourcePolicy?: AgentCliSourcePolicy;
  signal?: AbortSignal;
  onProgress?: AgentInstallProgressCallback;
  deps?: InstallAgentCliDeps;
}>): Promise<InstallAgentCliResult> {
  const runtimeSpec = getAgentCliRuntimeSpec(params.agentId);
  if (runtimeSpec == null) {
    return {
      ok: false,
      errorCode: 'no-recipe',
      errorMessage: `No auto-install recipe available for ${params.agentId} on ${params.platform}.`,
      plan: null,
      logPath: null,
    };
  }
  return installAgentCliForRuntime({
    runtimeSpec,
    platform: params.platform,
    env: params.env,
    logDir: params.logDir,
    signal: params.signal,
    onProgress: params.onProgress,
    dryRun: params.dryRun,
    skipIfInstalled: params.skipIfInstalled,
    intent: params.intent,
    ...(params.updateTarget ? { updateTarget: params.updateTarget } : {}),
    allowVendorRecipeExecution: params.allowVendorRecipeExecution,
    sourcePolicy: params.sourcePolicy,
    deps: params.deps,
  });
}
