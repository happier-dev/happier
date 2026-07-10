import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
  SessionRuntimeActivityPublisher,
} from '@happier-dev/plugin-sdk';
import { composeSessionIsolationEnvironment } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { isolateClaudeRuntimeAuthEnv } from '../../auth/services/runtime/env.js';
import { isUnsupportedProviderSessionStatePublication } from '../providerSessionStatePublication.js';
import {
  buildClaudeProviderTaskRuntimeActivitySourceId,
  createClaudeProviderActivityLedger,
  isReplayClaudeAgentSdkMessage,
  isClaudeAgentSdkStopHookWithNoBackgroundTasks,
  readClaudeProviderTaskActivity,
} from '../remote/sdk/providerActivity.js';

export function readClaudeRuntimeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readClaudeRuntimeDirectory(sessionParams: CreateSessionRuntimeParamsV1): string {
  return readClaudeRuntimeString(sessionParams.cwd)
    ?? readClaudeRuntimeString(sessionParams.directory)
    ?? process.cwd();
}

export function readClaudeRuntimeEnv(sessionParams: CreateSessionRuntimeParamsV1): Readonly<Record<string, string>> {
  const source = composeSessionIsolationEnvironment({
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

export function publishClaudeProviderSessionId(params: Readonly<{
  ctx: PluginContextV1;
  state: { publishedProviderSessionId: string | null };
  nextSessionId: string;
  reason: string;
  logPrefix: string;
}>): void {
  if (params.state.publishedProviderSessionId === params.nextSessionId) return;
  const previousPublishedSessionId = params.state.publishedProviderSessionId;
  params.state.publishedProviderSessionId = params.nextSessionId;
  void params.ctx.sessions.current.writeStateField({
    fieldId: 'identity.providerSessionId',
    value: {
      metadataKey: 'claudeSessionId',
      value: params.nextSessionId,
    },
    reason: params.reason,
  }).catch((error) => {
    if (
      !isUnsupportedProviderSessionStatePublication(error)
      && params.state.publishedProviderSessionId === params.nextSessionId
    ) {
      params.state.publishedProviderSessionId = previousPublishedSessionId;
    }
    if (!isUnsupportedProviderSessionStatePublication(error)) {
      params.ctx.logger.debug(`${params.logPrefix} failed to publish provider session id`, error);
    }
  });
}

export function publishClaudeRuntimeActivityUpdate(params: Readonly<{
  logger: PluginContextV1['logger'];
  logPrefix: string;
  promise: Promise<void>;
  reason: string;
}>): void {
  void params.promise.catch((error) => {
    params.logger.debug(`${params.logPrefix} failed to publish runtime activity ${params.reason}`, { error });
  });
}

export function clearClaudeRuntimeActivitySources(params: Readonly<{
  logger: PluginContextV1['logger'];
  logPrefix: string;
  runtimeActivityPublisher: SessionRuntimeActivityPublisher;
  reason: string;
}>): void {
  publishClaudeRuntimeActivityUpdate({
    logger: params.logger,
    logPrefix: params.logPrefix,
    promise: params.runtimeActivityPublisher.clearAllSources(),
    reason: params.reason,
  });
}

export function observeClaudeProviderTaskActivity(params: Readonly<{
  row: unknown;
  ledger: ReturnType<typeof createClaudeProviderActivityLedger>;
  runtimeActivityPublisher: SessionRuntimeActivityPublisher;
  logger: PluginContextV1['logger'];
  logPrefix: string;
  onLiveProviderTaskEvidence?: (taskId: string, sourceId: string) => void;
  onProviderTaskSourceActive?: (sourceId: string) => void;
  onProviderTaskSourceCleared?: (sourceId: string) => void;
}>): boolean {
  if (isReplayClaudeAgentSdkMessage(params.row)) return false;

  if (isClaudeAgentSdkStopHookWithNoBackgroundTasks(params.row)) {
    const hadActiveTasks = params.ledger.hasActiveProviderTasks();
    params.ledger.clearProviderTasks();
    if (hadActiveTasks) {
      clearClaudeRuntimeActivitySources({
        logger: params.logger,
        logPrefix: params.logPrefix,
        runtimeActivityPublisher: params.runtimeActivityPublisher,
        reason: 'stop-hook-empty-background-tasks',
      });
    }
    return hadActiveTasks;
  }

  const activity = readClaudeProviderTaskActivity(params.row);
  if (!activity) return false;
  const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(activity.taskId);
  if (!sourceId) return false;
  const sourceKind = 'provider_detached_task';
  switch (activity.type) {
    case 'background':
      {
        const taskId = params.ledger.noteBackgroundProviderTask(activity.taskId);
        if (!taskId) return false;
        params.onLiveProviderTaskEvidence?.(taskId, sourceId);
        params.onProviderTaskSourceActive?.(sourceId);
      }
      publishClaudeRuntimeActivityUpdate({
        logger: params.logger,
        logPrefix: params.logPrefix,
        promise: params.runtimeActivityPublisher.markSourceActive({ sourceId, sourceKind }),
        reason: 'background-task',
      });
      return true;
    case 'started':
      {
        const taskId = params.ledger.noteProviderTaskStarted(activity.taskId);
        if (!taskId) return false;
        params.onLiveProviderTaskEvidence?.(taskId, sourceId);
        params.onProviderTaskSourceActive?.(sourceId);
      }
      publishClaudeRuntimeActivityUpdate({
        logger: params.logger,
        logPrefix: params.logPrefix,
        promise: params.runtimeActivityPublisher.markSourceActive({ sourceId, sourceKind }),
        reason: 'task-started',
      });
      return true;
    case 'progress':
      {
        const taskId = params.ledger.noteProviderTaskProgress(activity.taskId);
        if (!taskId) return false;
        params.onLiveProviderTaskEvidence?.(taskId, sourceId);
        params.onProviderTaskSourceActive?.(sourceId);
      }
      publishClaudeRuntimeActivityUpdate({
        logger: params.logger,
        logPrefix: params.logPrefix,
        promise: params.runtimeActivityPublisher.markSourceActive({ sourceId, sourceKind }),
        reason: 'task-progress',
      });
      return true;
    case 'terminal':
      if (!params.ledger.noteProviderTaskFinished(activity.taskId)) return false;
      params.onProviderTaskSourceCleared?.(sourceId);
      publishClaudeRuntimeActivityUpdate({
        logger: params.logger,
        logPrefix: params.logPrefix,
        promise: params.runtimeActivityPublisher.clearSource(sourceId),
        reason: 'task-terminal',
      });
      return true;
  }
}

export async function respondToClaudePermission(params: Readonly<{
  ctx: PluginContextV1;
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
