import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { AgentPassiveRealtimeSetupResultV1 } from '@happier-dev/plugin-sdk/agents';

import { readCodexEnvironmentAuthState, type CodexEnvironmentAuthMethod } from '../../cli/auth/environment.js';
import { classifyCodexConnectedServiceAuthFailure } from '../../auth/services/runtime/auth/failure.js';
import { createCodexNativeAppServerClient } from '../../runtime/appServer/client.js';
import {
  CODEX_OPERATION_ABORTED,
  inspectCodexRealtimeFeature,
  waitForCodexOperationOrAbort,
} from '../../runtime/appServer/realtimeFeatureInspection.js';
import {
  readCodexAppServerSessionControls,
  type CodexAppServerSessionControlsSnapshot,
} from '../../runtime/appServer/state/controls.js';
import { resolveCodexSessionBackendMode } from '../backendMode.js';

export type CodexPreflightSessionControlsPolicy = Readonly<{
  processEnv: Readonly<{
    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: string;
  }>;
  authMethod: CodexEnvironmentAuthMethod | null;
}>;

export type CodexPreflightSessionControlsProbeParams = Readonly<{
  exec: ExecService;
  cwd: string;
  timeoutMs: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>;

const CODEX_PREFLIGHT_RUNTIME_DIAGNOSTIC_ENV_KEYS = [
  'HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH',
  'HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES',
  'HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT',
] as const;

function buildCodexPreflightProcessEnv(
  env: NodeJS.ProcessEnv,
  policy: CodexPreflightSessionControlsPolicy,
): NodeJS.ProcessEnv {
  const processEnv: NodeJS.ProcessEnv = {
    ...env,
    ...policy.processEnv,
  };
  for (const key of CODEX_PREFLIGHT_RUNTIME_DIAGNOSTIC_ENV_KEYS) {
    delete processEnv[key];
  }
  return processEnv;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSupportedPassiveCodexAccount(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'apiKey') return true;
  return value.type === 'chatgpt'
    && (typeof value.email === 'string' || value.email === null)
    && typeof value.planType === 'string';
}

function isCodexAuthenticationError(error: unknown): boolean {
  const classification = classifyCodexConnectedServiceAuthFailure({
    providerErrorPath: true,
    error,
    serviceId: 'openai-codex',
    profileId: null,
    groupId: null,
  });
  return classification?.kind === 'auth_expired'
    || classification?.kind === 'account_changed'
    || classification?.kind === 'refresh_failed';
}

function readPassiveCodexAccountAuthentication(value: unknown): 'authenticated' | 'authentication_required' | 'unavailable' {
  const record = isRecord(value) ? value : null;
  if (!record || typeof record.requiresOpenaiAuth !== 'boolean') return 'unavailable';
  if (record.account === null || record.account === undefined) return 'authentication_required';
  return isSupportedPassiveCodexAccount(record.account) ? 'authenticated' : 'unavailable';
}

function passiveRealtimeResult(
  status: AgentPassiveRealtimeSetupResultV1['status'],
): AgentPassiveRealtimeSetupResultV1 {
  return { v: 1, status };
}

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

  const client = await createCodexNativeAppServerClient({
    exec: params.exec,
    processEnv: buildCodexPreflightProcessEnv(env, policy),
    cwd: params.cwd,
    ...(params.signal ? { signal: params.signal } : {}),
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

/**
 * Cold, bounded readiness inspection for Settings. This owns no thread or
 * realtime session; normal Voice Start still owns thread-scoped admission.
 */
export async function probeCodexPassiveRealtimeSetupRaw(
  params: CodexPreflightSessionControlsProbeParams,
): Promise<AgentPassiveRealtimeSetupResultV1> {
  const env = params.env ?? process.env;
  const policy = resolveCodexPreflightSessionControlsPolicy({
    accountSettings: params.accountSettings ?? null,
    timeoutMs: params.timeoutMs,
    env,
  });
  if (!policy) return passiveRealtimeResult('unavailable');

  let client: Awaited<ReturnType<typeof createCodexNativeAppServerClient>>;
  try {
    client = await createCodexNativeAppServerClient({
      exec: params.exec,
      processEnv: buildCodexPreflightProcessEnv(env, policy),
      cwd: params.cwd,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (error) {
    return passiveRealtimeResult(
      isCodexAuthenticationError(error) ? 'authentication_required' : 'unavailable',
    );
  }

  try {
    const accountOutcome = await waitForCodexOperationOrAbort(
      client.request('account/read', { refreshToken: false }, ...(params.signal ? [{ signal: params.signal }] : [])),
      params.signal,
    );
    if (accountOutcome === CODEX_OPERATION_ABORTED) return passiveRealtimeResult('unavailable');
    const accountAuthentication = readPassiveCodexAccountAuthentication(accountOutcome);
    if (accountAuthentication !== 'authenticated') {
      return passiveRealtimeResult(accountAuthentication);
    }

    const featureInspection = await inspectCodexRealtimeFeature({
      client,
      isAuthenticationError: isCodexAuthenticationError,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (featureInspection.status === 'enabled') return passiveRealtimeResult('ready');
    switch (featureInspection.code) {
      case 'feature_not_advertised':
      case 'feature_missing':
        return passiveRealtimeResult('runtime_incompatible');
      case 'authentication_required':
        return passiveRealtimeResult('authentication_required');
      case 'feature_disabled':
        return passiveRealtimeResult('feature_disabled');
      case 'inspection_aborted':
      case 'currentness_lost':
      case 'feature_list_unavailable':
      case 'feature_list_invalid':
      case 'feature_state_invalid':
      case 'feature_state_ambiguous':
      case 'feature_pagination_invalid':
      case 'feature_pagination_incomplete':
        return passiveRealtimeResult('unavailable');
    }
  } catch (error) {
    return passiveRealtimeResult(
      isCodexAuthenticationError(error) ? 'authentication_required' : 'unavailable',
    );
  } finally {
    await client.dispose();
  }
}

export function resolveCodexPreflightSessionControlsProbeVariant(params: Readonly<{
  accountSettings?: Readonly<Record<string, unknown>> | null;
  env?: NodeJS.ProcessEnv;
}>): string {
  const backendMode =
    resolveCodexSessionBackendMode({ accountSettings: params.accountSettings ?? null }) ?? 'appServer';
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
  connectedServiceAuth: 'materialized-env',
  failureCacheStrategy: 'retry',
  needsAccountSettings: true,
  resolveProbeVariant: resolveCodexPreflightSessionControlsProbeVariant,
  probeModelsRaw: probeCodexPreflightModelsRaw,
  probeModesRaw: probeCodexPreflightModesRaw,
  probeConfigOptionsRaw: probeCodexPreflightConfigOptionsRaw,
  probePassiveRealtimeSetupRaw: probeCodexPassiveRealtimeSetupRaw,
} as const;

export function resolveCodexPreflightSessionControlsPolicy(params: Readonly<{
  accountSettings?: Readonly<Record<string, unknown>> | null;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}>): CodexPreflightSessionControlsPolicy | null {
  const backendMode =
    resolveCodexSessionBackendMode({ accountSettings: params.accountSettings ?? null }) ?? 'appServer';
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
