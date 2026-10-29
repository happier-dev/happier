import type { AgentId, AgentCliInstallPlatform } from '@happier-dev/agents';
import {
  installAgentCli as installAgentCliDefault,
  installAgentCliForRuntime as installAgentCliForRuntimeDefault,
  resolvePlatformFromNodePlatform,
  type AgentCliRuntimeDescriptor,
  type AgentCliUpdateTarget,
  type InstallAgentCliResult,
  type AgentInstallProgressCallback,
} from '@happier-dev/cli-common/agents';
import { fetchGitHubLatestRelease, fetchGitHubReleaseByTag } from '@/capabilities/cliUpdate/githubReleaseLookup';

type AgentCliInstallIntent = 'install' | 'update';

export type AgentCliInstallInvocationParams = Readonly<{
  dryRun?: boolean;
  skipIfInstalled?: boolean;
  intent?: AgentCliInstallIntent;
  platform?: string;
  allowVendorRecipeExecution?: boolean;
  /** With `intent: 'update'`: the executable detect reported, so its own owner updates it. */
  updateTarget?: AgentCliUpdateTarget;
}>;

export type AgentCliInstallInvocationResult =
  | Readonly<{
      ok: true;
      plan: NonNullable<Extract<InstallAgentCliResult, { ok: true }>['plan']>;
      alreadyInstalled: boolean;
      logPath: string | null;
    }>
  | Readonly<{
      ok: false;
      errorCode:
        | 'unsupported-platform'
        | 'install-not-available'
        | 'update-not-available'
        | 'install-confirmation-required'
        | 'archive-expanded-byte-limit'
        | 'download-failed'
        | 'rate-limited'
        | 'verification-failed'
        | 'command-timed-out'
        | 'termination-failed'
        | 'install-failed';
      errorMessage: string;
      logPath: string | null;
    }>;

function resolveAgentCliInstallPlatform(params: Readonly<{
  platform?: string;
  nodePlatform: string;
}>): AgentCliInstallPlatform | null {
  const rawPlatform = typeof params.platform === 'string' ? params.platform.trim() : '';
  if (rawPlatform === 'darwin' || rawPlatform === 'linux' || rawPlatform === 'win32') return rawPlatform;
  return resolvePlatformFromNodePlatform(params.nodePlatform);
}

export async function invokeAgentCliInstall(params: Readonly<{
  agentId: string;
  runtimeSpec?: AgentCliRuntimeDescriptor;
  params?: AgentCliInstallInvocationParams;
  env?: NodeJS.ProcessEnv;
  nodePlatform?: string;
  signal?: AbortSignal;
  onProgress?: AgentInstallProgressCallback;
  installerDeps?: Parameters<typeof installAgentCliForRuntimeDefault>[0]['deps'];
  installAgentCli?: typeof installAgentCliDefault;
  installAgentCliForRuntime?: typeof installAgentCliForRuntimeDefault;
}>): Promise<AgentCliInstallInvocationResult> {
  const nodePlatform = params.nodePlatform ?? process.platform;
  const platform = resolveAgentCliInstallPlatform({
    platform: params.params?.platform,
    nodePlatform,
  });
  if (!platform) {
    return {
      ok: false,
      errorCode: 'unsupported-platform',
      errorMessage: `Unsupported platform: ${nodePlatform}`,
      logPath: null,
    };
  }

  const dryRun = Boolean(params.params?.dryRun);
  const intent = params.params?.intent === 'update' ? 'update' : 'install';
  const skipIfInstalled = intent === 'update'
    ? false
    : typeof params.params?.skipIfInstalled === 'boolean'
      ? params.params.skipIfInstalled
      : true;
  const allowVendorRecipeExecution = params.params?.allowVendorRecipeExecution === true;
  const commonInstallParams = {
    platform,
    dryRun,
    skipIfInstalled,
    ...(params.params?.intent === 'update' ? { intent: 'update' as const } : {}),
    ...(params.params?.intent === 'update' && params.params.updateTarget ? { updateTarget: params.params.updateTarget } : {}),
    allowVendorRecipeExecution,
    env: params.env ?? process.env,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    deps: { fetchGitHubLatestRelease, fetchGitHubReleaseByTag, ...params.installerDeps },
  } as const;
  const result = params.runtimeSpec
    ? await (params.installAgentCliForRuntime ?? installAgentCliForRuntimeDefault)({
      runtimeSpec: params.runtimeSpec,
      ...commonInstallParams,
    })
    : await (params.installAgentCli ?? installAgentCliDefault)({
      agentId: params.agentId as AgentId,
      ...commonInstallParams,
    });

  if (!result.ok) {
    const errorCode = String(result.errorCode);
    return {
      ok: false,
      errorCode:
        errorCode === 'no-recipe'
          ? 'install-not-available'
          : errorCode === 'update-not-available'
            ? 'update-not-available'
          : errorCode === 'vendor-recipe-disallowed'
            ? 'install-confirmation-required'
            : errorCode === 'archive-expanded-byte-limit' || errorCode === 'download-failed' || errorCode === 'rate-limited' || errorCode === 'verification-failed' || errorCode === 'command-timed-out' || errorCode === 'termination-failed'
              ? errorCode
            : 'install-failed',
      errorMessage: result.errorMessage,
      logPath: result.logPath ?? null,
    };
  }

  return {
    ok: true,
    plan: result.plan,
    alreadyInstalled: result.alreadyInstalled,
    logPath: result.logPath ?? null,
  };
}
