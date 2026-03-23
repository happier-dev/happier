import type { AgentId, ProviderCliRuntimeInstallPlatform } from '@happier-dev/agents';
import {
  installProviderCli as installProviderCliDefault,
  resolvePlatformFromNodePlatform,
  type InstallProviderCliResult,
} from '@happier-dev/cli-common/providers';

export type ProviderCliInstallInvocationParams = Readonly<{
  dryRun?: boolean;
  skipIfInstalled?: boolean;
  platform?: string;
  allowVendorRecipeExecution?: boolean;
}>;

export type ProviderCliInstallInvocationResult =
  | Readonly<{
      ok: true;
      plan: NonNullable<Extract<InstallProviderCliResult, { ok: true }>['plan']>;
      alreadyInstalled: boolean;
      logPath: string | null;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'unsupported-platform' | 'install-not-available' | 'install-confirmation-required' | 'install-failed';
      errorMessage: string;
      logPath: string | null;
    }>;

function resolveProviderCliInstallPlatform(params: Readonly<{
  platform?: string;
  nodePlatform: string;
}>): ProviderCliRuntimeInstallPlatform | null {
  const rawPlatform = typeof params.platform === 'string' ? params.platform.trim() : '';
  if (rawPlatform === 'darwin' || rawPlatform === 'linux' || rawPlatform === 'win32') return rawPlatform;
  return resolvePlatformFromNodePlatform(params.nodePlatform);
}

export async function invokeProviderCliInstall(params: Readonly<{
  agentId: AgentId;
  params?: ProviderCliInstallInvocationParams;
  env?: NodeJS.ProcessEnv;
  nodePlatform?: string;
  installProviderCli?: typeof installProviderCliDefault;
}>): Promise<ProviderCliInstallInvocationResult> {
  const nodePlatform = params.nodePlatform ?? process.platform;
  const platform = resolveProviderCliInstallPlatform({
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

  const installProviderCli = params.installProviderCli ?? installProviderCliDefault;
  const dryRun = Boolean(params.params?.dryRun);
  const skipIfInstalled = typeof params.params?.skipIfInstalled === 'boolean' ? params.params.skipIfInstalled : true;
  const allowVendorRecipeExecution =
    typeof params.params?.allowVendorRecipeExecution === 'boolean'
      ? params.params.allowVendorRecipeExecution
      : !dryRun;
  const result = await installProviderCli({
    providerId: params.agentId,
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
