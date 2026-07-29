import type { BackendTargetRefV2, SessionModelSelectionV1 } from '@happier-dev/protocol';

import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { ResolvedTerminalRequest } from '@/terminal/runtime/terminalConfig';

import { resolveDaemonCliSubcommandFromBackendTarget } from '../backendTargetRouting';
import { resolveBundledPluginMetadataForBackendTarget } from '../bundledBackendPluginMetadata';
import { resolveWindowsRemoteSessionConsoleMode } from '../platform/windows/windowsSessionConsoleMode';
import { buildHappySessionControlArgs } from '../sessionSpawnArgs';
import type { ChildExit } from '../sessions/onChildExited';
import type { TrackedSession } from '../types';
import type { PluginLocalServicesBridgeAuthorization } from '../local/services/pluginBridgeAuthorization';
import type { AgentRuntimeSessionBridgeAuthorization } from '../agentRuntime/sessionBridgeAuthorization';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { spawnRegularProcessAndWaitForWebhook } from './spawnRegularProcessAndWaitForWebhook';
import { spawnTmuxHostedSessionAndWaitForWebhook } from './spawnTmuxHostedSessionAndWaitForWebhook';
import { spawnWindowsHostedSessionAndWaitForWebhook } from './spawnWindowsHostedSessionAndWaitForWebhook';
import {
  normalizeBundledWorkspaceNameFromPackageName,
  prepareSourceDevSharedDepsForHappyCliSpawn,
} from '@/subprocess/sourceDevSharedDepsPreflight';
import type { SpawnCommitRevalidation } from './spawnCommitRevalidation';
import type { ProviderStreamingSanitizer } from '@/providers/spawn/redaction';
import {
  resolveHappyCliSubprocessRuntimeDecision,
  type HappyCliSubprocessLaunchOptions,
} from '@/utils/spawnHappyCLI';
import { resolveLiveRunnerSnapshotFingerprints } from '../sessionRunnerRuntime/resolveLiveRunnerSnapshotFingerprints';

function resolveSourceDevWorkspaceNamesForBackendTarget(
  target: BackendTargetRefV2 | undefined,
): readonly string[] | undefined {
  const metadata = resolveBundledPluginMetadataForBackendTarget(target);
  if (!metadata) return undefined;
  const workspaceName = normalizeBundledWorkspaceNameFromPackageName(metadata.packageName);
  return workspaceName ? [workspaceName] : undefined;
}

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
  modelSelection?: SessionModelSelectionV1;
  directoryCreated: boolean;
  extraEnvForChildWithMessage: Record<string, string>;
  unsetEnvKeys?: readonly string[];
  localServicesBridgeAuthorization: PluginLocalServicesBridgeAuthorization;
  agentRuntimeSessionBridgeAuthorization?: AgentRuntimeSessionBridgeAuthorization | null;
  processEnv: NodeJS.ProcessEnv;
  happyHomeDir: string;
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  resolveCanonicalTrackedSessionId: (pid: number) => string;
  onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
  spawnLifecycleCallbacks: SpawnLifecycleCallbacks;
  cleanupSpawnResources: () => void | Promise<void>;
  logDebug: (message: string, payload?: unknown) => void;
  warn: (message: string) => void;
  sanitizeDiagnosticText?: (value: string) => string;
  createStreamingSanitizer?: () => ProviderStreamingSanitizer;
  revalidateBeforeCommit?: SpawnCommitRevalidation;
  onUntrackedTmuxChild: () => void;
}>): Promise<SpawnSessionResult> {
  const sessionControlArgs = buildHappySessionControlArgs({
    resume: params.effectiveResume,
    nativeForkSource: params.options.nativeForkSource,
    existingSessionId: params.normalizedExistingSessionId,
    backendTarget: params.effectiveBackendTargetV2,
    permissionMode: params.permissionMode,
    permissionModeUpdatedAt: params.permissionModeUpdatedAt,
    agentModeId: params.agentModeId,
    agentModeUpdatedAt: params.agentModeUpdatedAt,
    modelSelection: params.modelSelection,
  });

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

  const sourceDevWorkspaceNames = resolveSourceDevWorkspaceNamesForBackendTarget(params.effectiveBackendTargetV2);
  const sourceDevSharedDepsPreflight = await prepareSourceDevSharedDepsForHappyCliSpawn({
    args,
    launchOptions: { preferWindowsPackagedBinary: true },
    logDebug: params.logDebug,
    ...(sourceDevWorkspaceNames ? { workspaceNames: sourceDevWorkspaceNames } : {}),
  });
  if (sourceDevSharedDepsPreflight.type === 'error') {
    params.logDebug('[DAEMON RUN] Source-dev CLI shared deps preflight failed before spawn', {
      errorMessage: sourceDevSharedDepsPreflight.errorMessage,
    });
    await params.cleanupSpawnResources();
    await params.spawnLifecycleCallbacks.cleanupPendingSessionAttach();
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: sourceDevSharedDepsPreflight.errorMessage,
    };
  }

  const liveRunnerSnapshotFingerprints = resolveLiveRunnerSnapshotFingerprints(params.pidToTrackedSession.values());
  const runtimeDecision = resolveHappyCliSubprocessRuntimeDecision({ liveRunnerSnapshotFingerprints });
  const runnerLaunchOptions: HappyCliSubprocessLaunchOptions = {
    preferWindowsPackagedBinary: true,
    liveRunnerSnapshotFingerprints,
    ...(runtimeDecision ? { runtimeDecision } : {}),
  };

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
    unsetEnvKeys: params.unsetEnvKeys,
    localServicesBridgeAuthorization: params.localServicesBridgeAuthorization,
    agentRuntimeSessionBridgeAuthorization: params.agentRuntimeSessionBridgeAuthorization,
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
    sanitizeDiagnosticText: params.sanitizeDiagnosticText,
    revalidateBeforeCommit: params.revalidateBeforeCommit,
    runnerLaunchOptions,
  });
  if (tmuxSpawnResult.spawnResult) {
    return tmuxSpawnResult.spawnResult;
  }

  const { tmuxRequested, tmuxFallbackReason, tmuxCreationDisposition } = tmuxSpawnResult;

  if (tmuxCreationDisposition === 'created_or_uncertain') {
    params.onUntrackedTmuxChild();
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: tmuxFallbackReason ?? 'Tmux window creation may have committed; regular fallback was refused',
    };
  }

  if (tmuxCreationDisposition === 'created_and_absent') {
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: tmuxFallbackReason ?? 'Tmux window creation committed but exact absence was verified',
    };
  }

  params.logDebug('[DAEMON RUN] Using regular process spawning');

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
      unsetEnvKeys: params.unsetEnvKeys,
      localServicesBridgeAuthorization: params.localServicesBridgeAuthorization,
      agentRuntimeSessionBridgeAuthorization: params.agentRuntimeSessionBridgeAuthorization,
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
      sanitizeDiagnosticText: params.sanitizeDiagnosticText,
      revalidateBeforeCommit: params.revalidateBeforeCommit,
      runnerLaunchOptions,
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
    unsetEnvKeys: params.unsetEnvKeys,
    localServicesBridgeAuthorization: params.localServicesBridgeAuthorization,
    agentRuntimeSessionBridgeAuthorization: params.agentRuntimeSessionBridgeAuthorization,
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
    sanitizeDiagnosticText: params.sanitizeDiagnosticText,
    createStreamingSanitizer: params.createStreamingSanitizer,
    revalidateBeforeCommit: params.revalidateBeforeCommit,
    runnerLaunchOptions,
  });
}
