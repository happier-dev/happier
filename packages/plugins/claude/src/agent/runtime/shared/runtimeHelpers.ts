import type { ClaudeRuntimeActivityPublisher } from './runtimeActivityPublisher.js';
import type { ClaudePermissionContext } from '../../permissions/createClaudePermissionEngine.js';
import type { ClaudeRuntimeLogger } from '../dependencies.js';

import { isolateClaudeRuntimeAuthEnv } from '../../auth/services/runtime/env.js';
import {
  createClaudeProviderActivityLedger,
  isReplayClaudeAgentSdkMessage,
  readClaudeProviderTaskActivity,
  type ClaudeProviderTaskActivity,
} from '../remote/sdk/providerActivity.js';

export function composeClaudeRuntimeEnvironment(params: Readonly<{
  inheritedEnvironment?: Readonly<Record<string, string | undefined>> | null;
  isolationEnvironment?: Readonly<Record<string, string>> | null;
  environment?: Readonly<Record<string, string>> | null;
  unsetEnvKeys?: readonly string[] | null;
  platform?: 'win32' | 'posix';
}>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.inheritedEnvironment ?? {})) {
    if (typeof value === 'string') output[key] = value;
  }
  const unsetNames = new Set((params.unsetEnvKeys ?? []).map((key) => key.toUpperCase()));
  for (const key of Object.keys(output)) {
    if (unsetNames.has(key.toUpperCase())) delete output[key];
  }
  const platform = params.platform
    ?? (process.platform === 'win32' ? 'win32' : 'posix');
  const apply = (
    entries: Readonly<Record<string, string>> | null | undefined,
  ): void => {
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (platform === 'win32') {
        const normalized = key.toUpperCase();
        for (const existingKey of Object.keys(output)) {
          if (existingKey.toUpperCase() === normalized) delete output[existingKey];
        }
      }
      output[key] = value;
    }
  };
  apply(params.isolationEnvironment);
  apply(params.environment);
  return output;
}

export function readClaudeRuntimeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type ClaudeRuntimeSessionParams = Readonly<{
  cwd?: string | null;
  directory?: string | null;
  env?: Readonly<Record<string, string>> | null;
  isolation?: Readonly<{
    env?: Readonly<Record<string, string>> | null;
    unsetEnvKeys?: readonly string[] | null;
  }> | null;
}>;

export function readClaudeRuntimeDirectory(sessionParams: ClaudeRuntimeSessionParams): string {
  return readClaudeRuntimeString(sessionParams.cwd)
    ?? readClaudeRuntimeString(sessionParams.directory)
    ?? process.cwd();
}

export function readClaudeRuntimeEnv(sessionParams: ClaudeRuntimeSessionParams): Readonly<Record<string, string>> {
  const source = composeClaudeRuntimeEnvironment({
    isolationEnvironment: sessionParams.isolation?.env,
    environment: sessionParams.env,
    unsetEnvKeys: sessionParams.isolation?.unsetEnvKeys,
  });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') env[key] = value;
  }
  return isolateClaudeRuntimeAuthEnv(env);
}

function readNonEmptyConfigString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRuntimeConfigOption(update: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null {
  const configOption = update.configOption;
  return configOption && typeof configOption === 'object' && !Array.isArray(configOption)
    ? configOption as Readonly<Record<string, unknown>>
    : null;
}

export function readClaudeRuntimeConfigEffortUpdate(
  update: Readonly<Record<string, unknown>>,
): string | null | undefined {
  const option = readRuntimeConfigOption(update);
  if (!option) return undefined;
  const optionId = readNonEmptyConfigString(option.id);
  if (optionId !== 'reasoning_effort' && optionId !== 'effort') return undefined;
  return readNonEmptyConfigString(option.value) ?? null;
}

export function readClaudeRuntimeConfigUltracodeUpdate(
  update: Readonly<Record<string, unknown>>,
): boolean | undefined {
  const option = readRuntimeConfigOption(update);
  if (!option || readNonEmptyConfigString(option.id) !== 'ultracode') return undefined;
  if (option.value === true || option.value === 'true') return true;
  if (option.value === false || option.value === 'false') return false;
  return undefined;
}

export function publishClaudeRuntimeActivityUpdate(params: Readonly<{
  logger: ClaudeRuntimeLogger;
  logPrefix: string;
  promise: Promise<void>;
  reason: string;
}>): void {
  void params.promise.catch((error) => {
    params.logger.debug(`${params.logPrefix} failed to publish runtime activity ${params.reason}`, { error });
  });
}

export function publishClaudeProviderTaskInventory(params: Readonly<{
  logger: ClaudeRuntimeLogger;
  logPrefix: string;
  ledger: ReturnType<typeof createClaudeProviderActivityLedger>;
  runtimeActivityPublisher: ClaudeRuntimeActivityPublisher;
  reason: string;
}>): void {
  publishClaudeRuntimeActivityUpdate({
    logger: params.logger,
    logPrefix: params.logPrefix,
    promise: params.runtimeActivityPublisher.publish(params.ledger.getSnapshot()),
    reason: params.reason,
  });
}

export function observeClaudeProviderTaskActivity(params: Readonly<{
  row: unknown;
  providerSessionId?: string;
  ledger: ReturnType<typeof createClaudeProviderActivityLedger>;
  runtimeActivityPublisher: ClaudeRuntimeActivityPublisher;
  logger: ClaudeRuntimeLogger;
  logPrefix: string;
}>): boolean {
  if (isReplayClaudeAgentSdkMessage(params.row)) return false;
  const activity = readClaudeProviderTaskActivity(params.row, params.providerSessionId);
  if (!activity) return false;
  applyClaudeProviderTaskActivity({ ...params, activity });
  return true;
}

export function applyClaudeProviderTaskActivity(params: Readonly<{
  activity: ClaudeProviderTaskActivity;
  ledger: ReturnType<typeof createClaudeProviderActivityLedger>;
  runtimeActivityPublisher: ClaudeRuntimeActivityPublisher;
  logger: ClaudeRuntimeLogger;
  logPrefix: string;
}>): void {
  const activity = params.activity;
  const didChange = params.ledger.apply(activity);
  if (!didChange) return;
  publishClaudeProviderTaskInventory({
    ...params,
    reason: activity.type === 'terminal' ? 'task-terminal' : `task-${activity.type}`,
  });
}

export async function respondToClaudePermission(params: Readonly<{
  ctx: ClaudePermissionContext;
  provider: string;
  requestId: string;
  approved: boolean;
}>): Promise<{ delivered: true }> {
  await params.ctx.sessions.current.permissions.requestDecision({
    provider: params.provider,
    requestId: params.requestId,
    approved: params.approved,
  });
  return { delivered: true };
}
