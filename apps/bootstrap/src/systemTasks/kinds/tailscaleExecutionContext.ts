import type { RelayAccessExecutionContext } from '@happier-dev/cli-common/relayAccess';
import {
  resolveTailscaleInstallStrategy,
  runTailscaleLogin,
  runTailscaleStatusJson,
  type RunTailscaleLoginResult,
} from '@happier-dev/cli-common/tailscale';

import type { TailscaleReadinessInspectionOptions, TailscaleReadinessState } from './tailscaleReadinessFlow.js';
import { isUnavailableTailscaleError } from './tailscaleReadinessFlow.js';

type TailscaleInstallPrompt = Readonly<{
  platform: NodeJS.Platform;
  url: string;
}>;

type TailscaleCommandDeps = Readonly<{
  runCommand?: RelayAccessExecutionContext['runCommand'];
  resolveCommandOnPath?: RelayAccessExecutionContext['resolveCommandOnPath'];
}>;

export async function inspectTailscaleReadinessStateForExecutionContext(
  context: RelayAccessExecutionContext,
  options?: TailscaleReadinessInspectionOptions,
): Promise<TailscaleReadinessState> {
  try {
    const status = await runTailscaleStatusJson(
      {
        env: context.env,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options?.deadline ? { deadline: options.deadline } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      },
      createTailscaleCommandDeps(context),
    );
    return {
      installed: true,
      loggedIn: status.loggedIn,
      authUrl: status.authUrl,
      shareableHttpsUrl: null,
    };
  } catch (error) {
    if (isUnavailableTailscaleError(error)) {
      return {
        installed: false,
        loggedIn: false,
        authUrl: null,
        shareableHttpsUrl: null,
      };
    }
    throw error;
  }
}

export async function runTailscaleLoginForExecutionContext(
  context: RelayAccessExecutionContext,
): Promise<RunTailscaleLoginResult> {
  return await runTailscaleLogin(
    { env: context.env },
    createTailscaleCommandDeps(context),
  );
}

export async function resolveTailscaleInstallPromptForExecutionContext(
  context: RelayAccessExecutionContext,
): Promise<TailscaleInstallPrompt> {
  const platform = await detectExecutionPlatform(context);
  return {
    platform,
    url: resolveTailscaleInstallStrategy(platform, context.env).docsUrl,
  };
}

function createTailscaleCommandDeps(context: RelayAccessExecutionContext): TailscaleCommandDeps {
  return {
    ...(context.runCommand ? { runCommand: context.runCommand } : {}),
    ...(context.resolveCommandOnPath ? { resolveCommandOnPath: context.resolveCommandOnPath } : {}),
  };
}

async function detectExecutionPlatform(
  context: RelayAccessExecutionContext,
): Promise<NodeJS.Platform> {
  const runCommand = context.runCommand;
  if (!runCommand) {
    return process.platform;
  }

  try {
    const result = await runCommand({
      command: 'sh',
      args: ['-lc', "uname -s | tr '[:upper:]' '[:lower:]'"],
      env: context.env,
      timeoutMs: 5_000,
    });
    const normalized = String(result.stdout ?? '').trim().toLowerCase();
    if (normalized.startsWith('darwin')) {
      return 'darwin';
    }
    if (normalized.startsWith('linux')) {
      return 'linux';
    }
  } catch {
    return 'linux';
  }

  return 'linux';
}
