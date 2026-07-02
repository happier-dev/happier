import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { ResolvedTerminalRequest } from '@/terminal/runtime/terminalConfig';

import { resolveDaemonCliSubcommandFromBackendTarget } from '../backendTargetRouting';
import { resolveWindowsRemoteSessionConsoleMode } from '../platform/windows/windowsSessionConsoleMode';
import { buildHappySessionControlArgs } from '../sessionSpawnArgs';
import type { ChildExit } from '../sessions/onChildExited';
import type { TrackedSession } from '../types';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { spawnRegularProcessAndWaitForWebhook } from './spawnRegularProcessAndWaitForWebhook';
import { spawnTmuxHostedSessionAndWaitForWebhook } from './spawnTmuxHostedSessionAndWaitForWebhook';
import { spawnWindowsHostedSessionAndWaitForWebhook } from './spawnWindowsHostedSessionAndWaitForWebhook';

export async function routeSpawnModeAndWaitForWebhook(params: Readonly<{
  terminalRequest: ResolvedTerminalRequest;
  directory: string;
  options: SpawnSessionOptions;
  trackedSpawnOptions: SpawnSessionOptions;
  normalizedExistingSessionId: string;
  effectiveResume: string;
  effectiveBackendTargetV2: BackendTargetRefV2;
  reservedSessionId?: string;
  permissionMode?: string;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
  directoryCreated: boolean;
  extraEnvForChildWithMessage: Record<string, string>;
  processEnv: NodeJS.ProcessEnv;
  happyHomeDir: string;
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  resolveCanonicalTrackedSessionId: (pid: number) => string;
  onChildExited: (pid: number, exit: ChildExit) => void;
  spawnLifecycleCallbacks: SpawnLifecycleCallbacks;
  cleanupSpawnResources: () => void;
  logDebug: (message: string, payload?: unknown) => void;
  warn: (message: string) => void;
}>): Promise<SpawnSessionResult> {
  const sessionControlArgs = buildHappySessionControlArgs({
    resume: params.effectiveResume,
    existingSessionId: params.normalizedExistingSessionId,
    backendTarget: params.effectiveBackendTargetV2,
    permissionMode: params.permissionMode,
    permissionModeUpdatedAt: params.permissionModeUpdatedAt,
    agentModeId: params.agentModeId,
    agentModeUpdatedAt: params.agentModeUpdatedAt,
    modelId: params.modelId,
    modelUpdatedAt: params.modelUpdatedAt,
  });

  const tmuxSpawnResult = await spawnTmuxHostedSessionAndWaitForWebhook({
    terminalRequest: params.terminalRequest,
    directory: params.directory,
    options: params.options,
    trackedSpawnOptions: params.trackedSpawnOptions,
    normalizedExistingSessionId: params.normalizedExistingSessionId,
    effectiveResume: params.effectiveResume,
    effectiveBackendTargetV2: params.effectiveBackendTargetV2,
    sessionControlArgs,
    directoryCreated: params.directoryCreated,
    extraEnvForChildWithMessage: params.extraEnvForChildWithMessage,
    pidToTrackedSession: params.pidToTrackedSession,
    pidToAwaiter: params.pidToAwaiter,
    pidToSpawnResultResolver: params.pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
    resolveCanonicalTrackedSessionId: params.resolveCanonicalTrackedSessionId,
    spawnLifecycleCallbacks: params.spawnLifecycleCallbacks,
    logDebug: params.logDebug,
    warn: params.warn,
  });
  if (tmuxSpawnResult.spawnResult) {
    return tmuxSpawnResult.spawnResult;
  }

  const { tmuxRequested, tmuxFallbackReason } = tmuxSpawnResult;

  params.logDebug('[DAEMON RUN] Using regular process spawning');

  const agentCommand = resolveDaemonCliSubcommandFromBackendTarget(params.effectiveBackendTargetV2);
  if (!agentCommand) {
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Unknown backend target',
    };
  }

  const args = [
    agentCommand,
    '--happy-starting-mode', 'remote',
    '--started-by', 'daemon',
  ];

  if (tmuxRequested) {
    const reason = tmuxFallbackReason ?? 'tmux was not used';
    args.push(
      '--happy-terminal-mode',
      'plain',
      '--happy-terminal-requested',
      'tmux',
      '--happy-terminal-fallback-reason',
      reason,
    );
  }

  args.push(...sessionControlArgs);

  const windowsLaunchMode = resolveWindowsRemoteSessionConsoleMode({
    platform: process.platform,
    requested: params.options.windowsRemoteSessionLaunchMode ?? params.options.windowsRemoteSessionConsole,
    env: params.processEnv,
  });
  if (windowsLaunchMode === 'windows_terminal' || windowsLaunchMode === 'console') {
    return await spawnWindowsHostedSessionAndWaitForWebhook({
      windowsLaunchMode,
      args,
      agentCommand,
      directory: params.directory,
      options: params.options,
      trackedSpawnOptions: params.trackedSpawnOptions,
      normalizedExistingSessionId: params.normalizedExistingSessionId,
      effectiveResume: params.effectiveResume,
      reservedSessionId: params.reservedSessionId,
      directoryCreated: params.directoryCreated,
      extraEnvForChildWithMessage: params.extraEnvForChildWithMessage,
      processEnv: params.processEnv,
      happyHomeDir: params.happyHomeDir,
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      pidToSpawnResultResolver: params.pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
      resolveCanonicalTrackedSessionId: params.resolveCanonicalTrackedSessionId,
      onChildExited: params.onChildExited,
      spawnLifecycleCallbacks: params.spawnLifecycleCallbacks,
      cleanupSpawnResources: params.cleanupSpawnResources,
      logDebug: params.logDebug,
      warn: params.warn,
    });
  }

  return await spawnRegularProcessAndWaitForWebhook({
    args,
    directory: params.directory,
    options: params.options,
    trackedSpawnOptions: params.trackedSpawnOptions,
    normalizedExistingSessionId: params.normalizedExistingSessionId,
    effectiveResume: params.effectiveResume,
    directoryCreated: params.directoryCreated,
    extraEnvForChildWithMessage: params.extraEnvForChildWithMessage,
    processEnv: params.processEnv,
    pidToTrackedSession: params.pidToTrackedSession,
    pidToAwaiter: params.pidToAwaiter,
    pidToSpawnResultResolver: params.pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
    resolveCanonicalTrackedSessionId: params.resolveCanonicalTrackedSessionId,
    onChildExited: params.onChildExited,
    spawnLifecycleCallbacks: params.spawnLifecycleCallbacks,
    cleanupSpawnResources: params.cleanupSpawnResources,
    logDebug: params.logDebug,
    warn: params.warn,
  });
}
