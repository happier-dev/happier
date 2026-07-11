import type { AgentId, AgentCliInstallPlatform } from '@happier-dev/agents';
import {
  installAgentCli as installAgentCliDefault,
  resolvePlatformFromNodePlatform,
  type InstallAgentCliResult,
} from '@happier-dev/cli-common/agents';

export type AgentCliInstallInvocationParams = Readonly<{
  dryRun?: boolean;
  skipIfInstalled?: boolean;
  platform?: string;
  allowVendorRecipeExecution?: boolean;
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
      errorCode: 'unsupported-platform' | 'install-not-available' | 'install-confirmation-required' | 'install-failed';
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
  agentId: AgentId;
  params?: AgentCliInstallInvocationParams;
  env?: NodeJS.ProcessEnv;
  nodePlatform?: string;
  installAgentCli?: typeof installAgentCliDefault;
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

  const installAgentCli = params.installAgentCli ?? installAgentCliDefault;
  const dryRun = Boolean(params.params?.dryRun);
  const skipIfInstalled = typeof params.params?.skipIfInstalled === 'boolean' ? params.params.skipIfInstalled : true;
  const allowVendorRecipeExecution =
    typeof params.params?.allowVendorRecipeExecution === 'boolean'
      ? params.params.allowVendorRecipeExecution
      : !dryRun;
  const result = await installAgentCli({
    agentId: params.agentId,
    platform,
    dryRun,
    skipIfInstalled,
    allowVendorRecipeExecution,
    env: params.env ?? process.env,
  });

  if (!result.ok) {
    return {
      ok: false,
      errorCode:
        result.errorCode === 'no-recipe'
          ? 'install-not-available'
          : result.errorCode === 'vendor-recipe-disallowed'
            ? 'install-confirmation-required'
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
