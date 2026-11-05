import type { PersistedTakeoverAdmissionWaitRegistration } from './persistedTakeoverAdmission';
import type { BackendTargetRefV2, SessionModelSelectionV1 } from '@happier-dev/protocol';

import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { ResolvedTerminalRequest } from '@/terminal/runtime/terminalConfig';

import { resolveDaemonCliSubcommandFromBackendTarget } from '../backendTargetRouting';
import { resolveBundledPluginMetadataForBackendTarget } from '../bundledBackendPluginMetadata';
import { resolveWindowsRemoteSessionConsoleMode } from '../platform/windows/windowsSessionConsoleMode';
import { buildHappySessionControlArgs } from '../sessionSpawnArgs';
import type { ChildExit } from '../sessions/onChildExited';
import type {
  RunnerAgentInvocationContext,
  TrackedSession,
} from '../types';
import type {
  RunnerAgentSessionBootstrapAuthorization,
} from '../agentRuntime/sessionBridgeAuthorization';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { spawnRegularProcessAndWaitForWebhook } from './spawnRegularProcessAndWaitForWebhook';
import { spawnTmuxHostedSessionAndWaitForWebhook } from './spawnTmuxHostedSessionAndWaitForWebhook';
import { spawnAdapterHostedSessionAndWaitForWebhook } from './spawnAdapterHostedSessionAndWaitForWebhook';
import { spawnWindowsHostedSessionAndWaitForWebhook } from './spawnWindowsHostedSessionAndWaitForWebhook';
import {
  normalizeBundledWorkspaceNameFromPackageName,
  prepareSourceDevSharedDepsForHappyCliSpawn,
} from '@/subprocess/sourceDevSharedDepsPreflight';
import { withTakeoverAdmissionCommitRevalidation, type SpawnCommitRevalidation } from './spawnCommitRevalidation';
import type { ProviderStreamingSanitizer } from '@/providers/spawn/redaction';
import {
  isRuntimeBackedHappyCliSubprocess,
  resolveHappyCliSubprocessRuntimeDecision,
  type HappyCliSubprocessLaunchOptions,
} from '@/utils/spawnHappyCLI';
import { ensureJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';
import { resolveLiveRunnerSnapshotFingerprints } from '../sessionRunnerRuntime/resolveLiveRunnerSnapshotFingerprints';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import type { SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';

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
  terminalPresentation?: Awaited<ReturnType<NonNullable<BackendExecutionSurfaces['resolveTerminalPresentation']>>>;
  directory: string;
  options: SpawnSessionOptions;
  initialAccessFilePath?: string;
  trackedSpawnOptions: SpawnSessionOptions;
  normalizedExistingSessionId: string;
  /** Creation outcome of a Session the daemon committed before launch; its attaching runner reports none. */
  sessionCreationOutcome?: TrackedSession['sessionCreationOutcome'];
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
  runnerAgentSessionBootstrapAuthorization?:
    RunnerAgentSessionBootstrapAuthorization | null;
  runnerAgentInvocationContext?: RunnerAgentInvocationContext | null;
  processEnv: NodeJS.ProcessEnv;
  happyHomeDir: string;
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  takeoverAdmission?: PersistedTakeoverAdmissionWaitRegistration;
  resolveCanonicalTrackedSessionId: (pid: number) => string;
  onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
  spawnLifecycleCallbacks: SpawnLifecycleCallbacks;
  cleanupSpawnResources: () => void | Promise<void>;
  logDebug: (message: string, payload?: unknown) => void;
  warn: (message: string) => void;
  sanitizeDiagnosticText?: (value: string) => string;
  createStreamingSanitizer?: () => ProviderStreamingSanitizer;
  revalidateBeforeCommit?: SpawnCommitRevalidation;
  onUntrackedHostedChild: () => void;
  readSpawnFailureLimits?: SpawnFailureLimitsReader;
  memoryHighBytes?: number | null;
}>): Promise<SpawnSessionResult> {
  const revalidateBeforeCommit = withTakeoverAdmissionCommitRevalidation(
    params.takeoverAdmission,
    params.revalidateBeforeCommit,
  );
  const sessionControlArgs = buildHappySessionControlArgs({
    resume: params.effectiveResume,
    nativeForkSource: params.options.nativeForkSource,
    sessionCreationTag: params.options.sessionCreationTag,
    sessionCreationCorrespondence: params.options.sessionCreationCorrespondence,
    placementOrigin: params.options.placementOrigin,
    initialTitle: params.options.initialTitle,
    initialAccessFilePath: params.initialAccessFilePath,
    primaryTeamId: params.options.primaryTeamId,
    teamCredentialBindings: params.options.teamCredentialBindings,
    existingSessionId: params.normalizedExistingSessionId,
    backendTarget: params.effectiveBackendTargetV2,
    permissionMode: params.permissionMode,
    permissionModeUpdatedAt: params.permissionModeUpdatedAt,
    agentModeId: params.agentModeId,
    agentModeUpdatedAt: params.agentModeUpdatedAt,
    modelSelection: params.modelSelection,
  });
  const terminalPresentation = params.terminalPresentation;
  const terminalPresentationEnabled = terminalPresentation !== undefined && terminalPresentation.kind !== 'none';
  // Only runner presentation places the controller in a terminal. Managed
  // terminal and provider-attach runtimes present their own prepared client.
  const effectiveTerminalRequest = terminalPresentation?.kind === 'runner'
    ? params.terminalRequest
    : { requested: 'plain' as const };
  const startingMode = terminalPresentation?.startingMode ?? 'remote';

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
    '--happy-starting-mode', startingMode,
    '--started-by', 'daemon',
  ];
  if (terminalPresentation?.kind === 'provider_attach' || terminalPresentation?.kind === 'managed_terminal') {
    const request = params.terminalRequest;
    if (request.requested === 'herdr' || request.requested === 'zellij' || request.requested === 'tmux') {
      args.push('--happy-terminal-mode', 'plain', '--happy-terminal-requested', request.requested);
      if (request.requested === 'herdr') args.push('--happy-herdr-session-name', request.herdr.sessionName,
        ...(request.herdr.socketPath ? ['--happy-herdr-socket-path', request.herdr.socketPath] : []));
      if (request.requested === 'tmux') args.push('--happy-tmux-target', request.tmux.sessionName,
        ...(request.tmux.tmpDir ? ['--happy-tmux-tmpdir', request.tmux.tmpDir] : []));
    }
  }

  const sourceDevWorkspaceNames = resolveSourceDevWorkspaceNamesForBackendTarget(params.effectiveBackendTargetV2);
  const sourceDevSharedDepsPreflight = await prepareSourceDevSharedDepsForHappyCliSpawn({
    args,
    processEnv: params.processEnv,
    launchOptions: { preferWindowsPackagedBinary: true },
    logDebug: params.logDebug,
    ...(sourceDevWorkspaceNames ? { workspaceNames: sourceDevWorkspaceNames } : {}),
  });
  if (sourceDevSharedDepsPreflight.type === 'error') {
    params.logDebug('[DAEMON RUN] Source-dev CLI shared deps preflight failed before spawn', {
      errorMessage: sourceDevSharedDepsPreflight.errorMessage,
      code: sourceDevSharedDepsPreflight.code,
      subtype: sourceDevSharedDepsPreflight.subtype,
    });
    await params.cleanupSpawnResources();
    await params.spawnLifecycleCallbacks.cleanupPendingSessionAttach();
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: sourceDevSharedDepsPreflight.errorMessage,
      ...(sourceDevSharedDepsPreflight.code ? { errorDetail: {
        kind: 'launch_error' as const,
        code: sourceDevSharedDepsPreflight.code,
        ...(sourceDevSharedDepsPreflight.subtype ? { subtype: sourceDevSharedDepsPreflight.subtype } : {}),
        message: sourceDevSharedDepsPreflight.errorMessage,
      } } : {}),
    };
  }

  const liveRunnerSnapshotFingerprints = resolveLiveRunnerSnapshotFingerprints(params.pidToTrackedSession.values());
  if (isRuntimeBackedHappyCliSubprocess(params.processEnv)) {
    await ensureJavaScriptRuntimeExecutable({
      isBunRuntime: isBun(),
      processEnv: params.processEnv,
      currentExecPath: process.execPath,
    });
  }
  const runtimeDecision = resolveHappyCliSubprocessRuntimeDecision({
    environment: params.processEnv,
    liveRunnerSnapshotFingerprints,
  });
  const runnerLaunchOptions: HappyCliSubprocessLaunchOptions = {
    preferWindowsPackagedBinary: true,
    liveRunnerSnapshotFingerprints,
    ...(runtimeDecision ? { runtimeDecision } : {}),
  };

  const tmuxSpawnResult = await spawnTmuxHostedSessionAndWaitForWebhook({
    memoryHighBytes: params.memoryHighBytes,
    readSpawnFailureLimits: params.readSpawnFailureLimits,
    startingMode,
    terminalRequest: effectiveTerminalRequest,
    directory: params.directory,
    options: params.options,
    trackedSpawnOptions: params.trackedSpawnOptions,
    normalizedExistingSessionId: params.normalizedExistingSessionId,
    ...(params.sessionCreationOutcome ? { sessionCreationOutcome: params.sessionCreationOutcome } : {}),
    effectiveResume: params.effectiveResume,
    effectiveBackendTargetV2: params.effectiveBackendTargetV2,
    sessionControlArgs,
    directoryCreated: params.directoryCreated,
    extraEnvForChildWithMessage: params.extraEnvForChildWithMessage,
    unsetEnvKeys: params.unsetEnvKeys,
    runnerAgentSessionBootstrapAuthorization:
      params.runnerAgentSessionBootstrapAuthorization,
    runnerAgentInvocationContext: params.runnerAgentInvocationContext,
    pidToTrackedSession: params.pidToTrackedSession,
    pidToAwaiter: params.pidToAwaiter,
    takeoverAdmission: params.takeoverAdmission,
    pidToSpawnResultResolver: params.pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
    resolveCanonicalTrackedSessionId: params.resolveCanonicalTrackedSessionId,
    onChildExited: params.onChildExited,
    spawnLifecycleCallbacks: params.spawnLifecycleCallbacks,
    cleanupSpawnResources: params.cleanupSpawnResources,
    logDebug: params.logDebug,
    warn: params.warn,
    sanitizeDiagnosticText: params.sanitizeDiagnosticText,
    revalidateBeforeCommit,
    runnerLaunchOptions,
  });
  if (tmuxSpawnResult.spawnResult) {
    return tmuxSpawnResult.spawnResult;
  }

  const { tmuxRequested, tmuxFallbackReason, tmuxCreationDisposition } = tmuxSpawnResult;

  if (tmuxCreationDisposition === 'created_or_uncertain') {
    params.onUntrackedHostedChild();
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: tmuxFallbackReason ?? 'Tmux window creation may have committed; regular fallback was refused',
      ...(tmuxSpawnResult.spawnFailure ? { errorDetail: { kind: 'spawn_failure' as const, ...tmuxSpawnResult.spawnFailure } } : {}),
    };
  }

  if (tmuxCreationDisposition === 'created_and_absent') {
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: tmuxFallbackReason ?? 'Tmux window creation committed but exact absence was verified',
      ...(tmuxSpawnResult.spawnFailure ? { errorDetail: { kind: 'spawn_failure' as const, ...tmuxSpawnResult.spawnFailure } } : {}),
    };
  }

  if (tmuxSpawnResult.tmuxCleanupIncomplete) {
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: tmuxFallbackReason ?? 'Tmux launch cleanup is incomplete; regular fallback was refused',
      ...(tmuxSpawnResult.spawnFailure ? { errorDetail: { kind: 'spawn_failure' as const, ...tmuxSpawnResult.spawnFailure } } : {}),
    };
  }

  const adapterHostedResult = await spawnAdapterHostedSessionAndWaitForWebhook({
    memoryHighBytes: params.memoryHighBytes,
    readSpawnFailureLimits: params.readSpawnFailureLimits,
    startingMode,
    onUntrackedHostedChild: params.onUntrackedHostedChild,
    terminalRequest: effectiveTerminalRequest,
    directory: params.directory,
    trackedSpawnOptions: params.trackedSpawnOptions,
    normalizedExistingSessionId: params.normalizedExistingSessionId,
    ...(params.sessionCreationOutcome ? { sessionCreationOutcome: params.sessionCreationOutcome } : {}),
    effectiveResume: params.effectiveResume,
    effectiveBackendTargetV2: params.effectiveBackendTargetV2,
    sessionControlArgs,
    directoryCreated: params.directoryCreated,
    extraEnvForChildWithMessage: params.extraEnvForChildWithMessage,
    unsetEnvKeys: params.unsetEnvKeys,
    runnerAgentSessionBootstrapAuthorization: params.runnerAgentSessionBootstrapAuthorization,
    runnerAgentInvocationContext: params.runnerAgentInvocationContext,
    processEnv: params.processEnv,
    happyHomeDir: params.happyHomeDir,
    pidToTrackedSession: params.pidToTrackedSession,
    pidToAwaiter: params.pidToAwaiter,
    pidToSpawnResultResolver: params.pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
    takeoverAdmission: params.takeoverAdmission,
    onChildExited: params.onChildExited,
    spawnLifecycleCallbacks: params.spawnLifecycleCallbacks,
    cleanupSpawnResources: params.cleanupSpawnResources,
    logDebug: params.logDebug,
    warn: params.warn,
    sanitizeDiagnosticText: params.sanitizeDiagnosticText,
    revalidateBeforeCommit,
    runnerLaunchOptions,
  });
  if (adapterHostedResult) return adapterHostedResult;

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
      readSpawnFailureLimits: params.readSpawnFailureLimits,
      windowsLaunchMode,
      args,
      agentCommand,
      directory: params.directory,
      options: params.options,
      trackedSpawnOptions: params.trackedSpawnOptions,
      normalizedExistingSessionId: params.normalizedExistingSessionId,
      ...(params.sessionCreationOutcome ? { sessionCreationOutcome: params.sessionCreationOutcome } : {}),
      effectiveResume: params.effectiveResume,
      reservedSessionId: params.reservedSessionId,
      directoryCreated: params.directoryCreated,
      extraEnvForChildWithMessage: params.extraEnvForChildWithMessage,
      unsetEnvKeys: params.unsetEnvKeys,
      runnerAgentSessionBootstrapAuthorization:
        params.runnerAgentSessionBootstrapAuthorization,
      runnerAgentInvocationContext: params.runnerAgentInvocationContext,
      processEnv: params.processEnv,
      happyHomeDir: params.happyHomeDir,
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      takeoverAdmission: params.takeoverAdmission,
      pidToSpawnResultResolver: params.pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
      resolveCanonicalTrackedSessionId: params.resolveCanonicalTrackedSessionId,
      onChildExited: params.onChildExited,
      spawnLifecycleCallbacks: params.spawnLifecycleCallbacks,
      cleanupSpawnResources: params.cleanupSpawnResources,
      logDebug: params.logDebug,
      warn: params.warn,
      sanitizeDiagnosticText: params.sanitizeDiagnosticText,
      revalidateBeforeCommit,
      runnerLaunchOptions,
    });
  }

  return await spawnRegularProcessAndWaitForWebhook({
    memoryHighBytes: params.memoryHighBytes,
    args,
    directory: params.directory,
    options: params.options,
    trackedSpawnOptions: terminalPresentationEnabled
      ? params.trackedSpawnOptions
      : { ...params.trackedSpawnOptions, terminal: { mode: 'plain' } },
    normalizedExistingSessionId: params.normalizedExistingSessionId,
    ...(params.sessionCreationOutcome ? { sessionCreationOutcome: params.sessionCreationOutcome } : {}),
    effectiveResume: params.effectiveResume,
    directoryCreated: params.directoryCreated,
    extraEnvForChildWithMessage: params.extraEnvForChildWithMessage,
    unsetEnvKeys: params.unsetEnvKeys,
    runnerAgentSessionBootstrapAuthorization:
      params.runnerAgentSessionBootstrapAuthorization,
    runnerAgentInvocationContext: params.runnerAgentInvocationContext,
    processEnv: params.processEnv,
    pidToTrackedSession: params.pidToTrackedSession,
    pidToAwaiter: params.pidToAwaiter,
    takeoverAdmission: params.takeoverAdmission,
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
    readSpawnFailureLimits: params.readSpawnFailureLimits,
    revalidateBeforeCommit,
    runnerLaunchOptions,
  });
}
