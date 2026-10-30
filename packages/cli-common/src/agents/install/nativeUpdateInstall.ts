import type { AgentCliInstallPlan, InstallAgentCliResult } from '../install.js';
import type { AgentCliRuntimeDescriptor } from '../resolution.js';
import type { AgentCliUpdateFacts } from '../update.js';
import { execFileWithDeadline } from '../../process/index.js';
import type { ManagedInstallDeps } from './managedInstall.js';
import {
  createRuntimeInstallLifecycleContext,
  disposeRuntimeInstallLifecycleContext,
} from './runtimeInstallLifecycleContext.js';
import { runLoggedAgentCommand } from './vendorRecipeInstall.js';
import type { AgentInstallProgressCallback } from '../installProgress.js';

/**
 * Updates an installed agent CLI that Happier did not place, through the owner that did: the
 * vendor's declared updater runs against the exact executable detect reported (after the
 * person's confirmation, like a vendor install recipe). A package-manager or unknown install is
 * never touched; its owner's command is returned for the person to run.
 */
export async function updateInstalledAgentCli(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  plan: AgentCliInstallPlan;
  command: string;
  facts: AgentCliUpdateFacts;
  env: NodeJS.ProcessEnv;
  logDir?: string | null;
  dryRun?: boolean;
  allowVendorRecipeExecution?: boolean;
  deps: ManagedInstallDeps;
  signal?: AbortSignal;
  onProgress?: AgentInstallProgressCallback;
}>): Promise<InstallAgentCliResult> {
  const { runtimeSpec, plan, facts } = params;
  params.signal?.throwIfAborted();
  if (!facts.updateSupported || !facts.nativeUpdateArgs) {
    return {
      ok: false,
      errorCode: 'update-not-available',
      errorMessage: facts.updateCommand
        ? `${runtimeSpec.title} at ${params.command} is managed by ${facts.installSource}. Update it with: ${facts.updateCommand}`
        : `${runtimeSpec.title} at ${params.command} was not installed by Happier or by its vendor installer. Update it the way it was installed.`,
      plan,
      logPath: null,
    };
  }
  if (params.dryRun) {
    return { ok: true, plan, alreadyInstalled: false, logPath: null };
  }
  if (params.allowVendorRecipeExecution !== true) {
    return {
      ok: false,
      errorCode: 'vendor-recipe-disallowed',
      errorMessage: `Updating ${runtimeSpec.title} runs its vendor updater (${facts.updateCommand}). Re-run with allowVendorRecipeExecution=true after confirming.`,
      plan,
      logPath: null,
    };
  }

  const lifecycleContext = await createRuntimeInstallLifecycleContext({
    runtimeSpec,
    plan,
    env: params.env,
    logDir: params.logDir,
    onProgress: params.onProgress,
  });
  try {
    const result = await runLoggedAgentCommand({
      runtimeSpec,
      command: { cmd: params.command, args: facts.nativeUpdateArgs },
      env: params.env,
      logPath: lifecycleContext.logPath,
      vendorScratchDir: lifecycleContext.vendorScratchDir,
      runCommand: params.deps.execFileWithDeadline ?? execFileWithDeadline,
      appendCommandLog: lifecycleContext.appendCommandLog,
      appendLogLine: lifecycleContext.appendLogLine,
      acceptResolvedAfterFailure: false,
      signal: params.signal,
      onProgress: lifecycleContext.onProgress,
    });
    if (!result.ok) {
      return { ...result, plan, logPath: lifecycleContext.logPath };
    }
    return { ok: true, plan, alreadyInstalled: false, logPath: lifecycleContext.logPath };
  } catch (error) {
    try {
      lifecycleContext.appendLogLine(lifecycleContext.logPath, error instanceof Error ? error.message : String(error));
    } finally {
      throw error;
    }
  } finally {
    await disposeRuntimeInstallLifecycleContext(lifecycleContext);
  }
}
