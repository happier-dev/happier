import { resolveCodexSessionBackendMode } from '@happier-dev/agents';
import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { readCodexEnvironmentAuthState, type CodexEnvironmentAuthMethod } from '../../cli/auth/environment.js';
import { createCodexAppServerClient } from '../../runtime/appServer/client.js';
import {
  readCodexAppServerSessionControls,
  type CodexAppServerSessionControlsSnapshot,
} from '../../runtime/appServer/state/controls.js';

export type CodexPreflightSessionControlsPolicy = Readonly<{
  processEnv: Readonly<{
    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: string;
  }>;
  authMethod: CodexEnvironmentAuthMethod | null;
}>;

export type CodexPreflightSessionControlsProbeParams = Readonly<{
  exec: ExecRuntimeServiceV1;
  cwd: string;
  timeoutMs: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  env?: NodeJS.ProcessEnv;
}>;

async function readCodexPreflightSessionControls(
  params: CodexPreflightSessionControlsProbeParams,
): Promise<CodexAppServerSessionControlsSnapshot | null> {
  const env = params.env ?? process.env;
  const policy = resolveCodexPreflightSessionControlsPolicy({
    accountSettings: params.accountSettings ?? null,
    timeoutMs: params.timeoutMs,
    env,
  });
  if (!policy) return null;

  const client = await createCodexAppServerClient({
    exec: params.exec,
    processEnv: {
      ...env,
      ...policy.processEnv,
    },
    cwd: params.cwd,
  });
  try {
    return await readCodexAppServerSessionControls({
      client,
      authMethod: policy.authMethod,
    });
  } finally {
    await client.dispose();
  }
}

export function resolveCodexPreflightSessionControlsProbeVariant(params: Readonly<{
  accountSettings?: Readonly<Record<string, unknown>> | null;
  env?: NodeJS.ProcessEnv;
}>): string {
  const backendMode =
    resolveCodexSessionBackendMode({ metadata: null, accountSettings: params.accountSettings ?? null }) ?? 'appServer';
  return `codex:${backendMode}`;
}

export async function probeCodexPreflightModelsRaw(
  params: CodexPreflightSessionControlsProbeParams,
): Promise<unknown | null> {
  const controls = await readCodexPreflightSessionControls(params);
  return controls?.availableModels ?? null;
}

export async function probeCodexPreflightModesRaw(
  params: CodexPreflightSessionControlsProbeParams,
): Promise<unknown | null> {
  const controls = await readCodexPreflightSessionControls(params);
  return controls?.availableModes ?? null;
}

export async function probeCodexPreflightConfigOptionsRaw(
  params: CodexPreflightSessionControlsProbeParams,
): Promise<unknown | null> {
  const controls = await readCodexPreflightSessionControls(params);
  return controls?.configOptions ?? null;
}

export const codexPreflightSessionControlsProbeConfig = {
  failureCacheStrategy: 'retry',
  needsAccountSettings: true,
  resolveProbeVariant: resolveCodexPreflightSessionControlsProbeVariant,
  probeModelsRaw: probeCodexPreflightModelsRaw,
  probeModesRaw: probeCodexPreflightModesRaw,
  probeConfigOptionsRaw: probeCodexPreflightConfigOptionsRaw,
} as const;

export function resolveCodexPreflightSessionControlsPolicy(params: Readonly<{
  accountSettings?: Readonly<Record<string, unknown>> | null;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}>): CodexPreflightSessionControlsPolicy | null {
  const backendMode =
    resolveCodexSessionBackendMode({ metadata: null, accountSettings: params.accountSettings ?? null }) ?? 'appServer';
  if (backendMode !== 'appServer') {
    return null;
  }

  return {
    processEnv: {
      HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: String(
        Math.max(250, Math.min(60_000, Math.trunc(params.timeoutMs))),
      ),
    },
    authMethod: readCodexEnvironmentAuthState(params.env ?? process.env).method,
  };
}
