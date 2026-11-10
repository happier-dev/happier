import type { AgentCliInstallPlatform } from '@happier-dev/agents';

import {
  installAgentCliForRuntime,
  type AgentCliInstallPlan,
  type InstallAgentCliResult,
} from './install.js';
import type { ManagedInstallDeps } from './install/managedInstall.js';
import {
  resolveAgentCliCommandForRuntime,
  type AgentCliRuntimeDescriptor,
} from './resolution.js';

type InstallFailureCode = Extract<InstallAgentCliResult, { ok: false }>['errorCode'];

export type ManagedAgentCliPreparationErrorCode =
  | InstallFailureCode
  | 'managed-install-unsupported'
  | 'managed-resolution-unavailable';

/**
 * The exact managed executable this preparation installed or validated. It is
 * the value the runtime launches; a caller must not resolve again.
 */
export type ManagedAgentCliResolution = Readonly<{
  source: 'managed';
  command: string;
}>;

export type ManagedAgentCliPreparation =
  | Readonly<{
      ok: true;
      resolution: ManagedAgentCliResolution;
      alreadyInstalled: boolean;
      plan: AgentCliInstallPlan;
      logPath: string | null;
    }>
  | Readonly<{
      ok: false;
      errorCode: ManagedAgentCliPreparationErrorCode;
      errorMessage: string;
      plan: AgentCliInstallPlan | null;
      logPath: string | null;
    }>;

/**
 * One request-scoped decision covering source policy, managed installation or
 * currentness validation, and exact executable resolution.
 *
 * `managed_only` is the strict policy used by a composition that may run only
 * the executable it installed and validated into its own `HAPPIER_HOME_DIR`:
 * environment overrides, system/global installs and vendor install recipes are
 * ignored, and a retry may reuse a valid current managed install.
 * Cancellation rejects with the supplied signal reason after installer cleanup;
 * an aborted acquisition never returns a prepared resolution. The returned
 * resolution is passed unchanged into the runtime launch, so an override or
 * system binary cannot substitute itself between readiness and launch.
 */
export async function prepareAgentCliForRuntime(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  platform: AgentCliInstallPlatform;
  sourcePolicy: 'managed_only';
  env?: NodeJS.ProcessEnv;
  logDir?: string | null;
  isBunRuntime?: boolean;
  currentExecPath?: string | null;
  signal?: AbortSignal;
  deps?: ManagedInstallDeps;
}>): Promise<ManagedAgentCliPreparation> {
  params.signal?.throwIfAborted();
  const runtimeSpec = params.runtimeSpec;
  const env = params.env ?? process.env;

  if (!runtimeSpec.managedInstall) {
    return {
      ok: false,
      errorCode: 'managed-install-unsupported',
      errorMessage:
        `${runtimeSpec.id} declares no managed install for ${params.platform}, so it cannot be prepared under the managed_only source policy.`,
      plan: null,
      logPath: null,
    };
  }

  const installed = await installAgentCliForRuntime({
    runtimeSpec,
    platform: params.platform,
    env,
    logDir: params.logDir,
    signal: params.signal,
    sourcePolicy: params.sourcePolicy,
    ...(params.deps ? { deps: params.deps } : {}),
  });
  if (!installed.ok) {
    return {
      ok: false,
      errorCode: installed.errorCode,
      errorMessage: installed.errorMessage,
      plan: installed.plan,
      logPath: installed.logPath,
    };
  }

  params.signal?.throwIfAborted();
  const resolution = resolveAgentCliCommandForRuntime(runtimeSpec, {
    processEnv: env,
    sourcePolicy: params.sourcePolicy,
    ...(params.isBunRuntime !== undefined ? { isBunRuntime: params.isBunRuntime } : {}),
    ...(params.currentExecPath !== undefined ? { currentExecPath: params.currentExecPath } : {}),
  });
  if (resolution?.source !== 'managed') {
    return {
      ok: false,
      errorCode: 'managed-resolution-unavailable',
      errorMessage:
        `${runtimeSpec.id} reported a completed managed install, but no runnable managed executable resolved for ${params.platform}.`,
      plan: installed.plan,
      logPath: installed.logPath,
    };
  }

  return {
    ok: true,
    resolution: { source: 'managed', command: resolution.command },
    alreadyInstalled: installed.alreadyInstalled,
    plan: installed.plan,
    logPath: installed.logPath,
  };
}
