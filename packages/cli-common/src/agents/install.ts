import type { AgentId } from '@happier-dev/agents/agent-ids';
import {
  getAgentCliRuntimeSpec,
  type AgentCliManagedInstallSpec,
  type AgentCliInstallPlatform,
} from '@happier-dev/agents/cli/runtime';
import { resolveAgentSetupHostPlatform } from '@happier-dev/protocol/agents/setup';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { existsSync } from 'node:fs';

import { installManagedBinaryAgentCli, type ManagedInstallDeps } from './install/managedInstall.js';
import { buildRuntimeInstallFailureResult } from './install/runtimeInstallFailureHandling.js';
import { createRuntimeInstallLifecycleContext, disposeRuntimeInstallLifecycleContext } from './install/runtimeInstallLifecycleContext.js';
import { updateInstalledAgentCli } from './install/nativeUpdateInstall.js';
import { runRuntimeInstallCoordinator } from './install/runtimeInstallCoordinator.js';
import { runRuntimeInstallPreflight } from './install/runtimeInstallPreflight.js';
import {
  resolveAgentCliManagedCommandPathForRuntime,
  resolveAgentCliManagedCommandRelativePathForRuntime,
  type AgentCliResolutionSource,
  type AgentCliRuntimeDescriptor,
  type AgentCliSourcePolicy,
  type AgentCliTargetPlatform,
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
      failureCause?: ActionFailureCauseV1;
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

/** An Agent CLI release staged on this Machine for another platform: every declared file, relative to `installDir`. */
export type AgentCliTargetRelease = Readonly<{ command: string; installDir: string; files: ReadonlyArray<string> }>;

export type InstallAgentCliForTargetResult =
  | (Readonly<{ ok: true; alreadyInstalled: boolean }> & AgentCliTargetRelease)
  | Extract<InstallAgentCliResult, { ok: false }>;

/**
 * The managed release of an Agent CLI for another platform (a Session target of
 * another OS or CPU architecture), staged on this Machine through the same
 * GitHub-release installer, asset declaration and digest verification as this
 * Machine's own managed install, under `tools/targets/<platform>-<arch>/`. It is
 * never resolved as this Machine's CLI. Detection is the same managed command
 * path: an existing staged release is reused (a pinned `releaseTag` names one
 * release). Only `github_release_binary` installs can be staged for another
 * platform (a vendor recipe or managed package runs on the platform itself).
 */
export async function installAgentCliForTarget(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  target: AgentCliTargetPlatform;
  env?: NodeJS.ProcessEnv;
  logDir?: string | null;
  signal?: AbortSignal;
  onProgress?: AgentInstallProgressCallback;
  deps?: InstallAgentCliDeps;
}>): Promise<InstallAgentCliForTargetResult> {
  params.signal?.throwIfAborted();
  const { runtimeSpec, target } = params;
  const env = params.env ?? process.env;
  const planned = planAgentCliInstallForRuntime({ runtimeSpec, platform: target.platform });
  if (!planned.ok || planned.plan.managedInstall?.kind !== 'github_release_binary') {
    return { ok: false, errorCode: 'no-recipe', plan: planned.ok ? planned.plan : null, logPath: null,
      errorMessage: `No managed release of ${runtimeSpec.id} can be staged for ${target.platform}-${target.arch}.` };
  }
  const managedInstall = planned.plan.managedInstall;
  const release = (): AgentCliTargetRelease => {
    const command = resolveAgentCliManagedCommandPathForRuntime(runtimeSpec, { processEnv: env, target });
    const commandRelativePath = resolveAgentCliManagedCommandRelativePathForRuntime(runtimeSpec, target.platform);
    const installDir = command.slice(0, command.length - commandRelativePath.length - 1);
    const declared = managedInstall.archiveEntriesByPlatform?.[target.platform]?.map(entry => entry.destinationPath) ?? [];
    const files = [...new Set([commandRelativePath.split('\\').join('/'), ...declared])].sort();
    return { command, installDir, files };
  };
  const staged = release();
  if (existsSync(staged.command)) return { ok: true, alreadyInstalled: true, ...staged };

  const lifecycleContext = await createRuntimeInstallLifecycleContext({
    runtimeSpec, plan: planned.plan, env, logDir: params.logDir, onProgress: params.onProgress });
  try {
    await installManagedBinaryAgentCli({ runtimeSpec, managedInstall, platform: target.platform, target, env,
      logPath: lifecycleContext.logPath, deps: params.deps ?? {}, signal: params.signal,
      onProgress: lifecycleContext.onProgress, appendLogLine: lifecycleContext.appendLogLine });
  } catch (error) {
    params.signal?.throwIfAborted();
    return buildRuntimeInstallFailureResult({ error, plan: planned.plan, lifecycleContext }) as Extract<InstallAgentCliResult, { ok: false }>;
  } finally {
    await disposeRuntimeInstallLifecycleContext(lifecycleContext);
  }
  return { ok: true, alreadyInstalled: false, ...release() };
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
