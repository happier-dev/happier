import type { PersistedTakeoverAdmissionWaitRegistration } from './persistedTakeoverAdmission';
import { randomUUID } from 'node:crypto';
import type { SpawnFailure, SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';

import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import {
  selectPreferredTmuxSessionName,
  TmuxUtilities,
  isTmuxAvailable,
  type TmuxWindowCreationDisposition,
} from '@/integrations/tmux';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { ResolvedTerminalRequest } from '@/terminal/runtime/terminalConfig';
import { configuration } from '@/configuration';
import { createTmuxTerminalHostHandle } from '@/integrations/tmux/hostHandle';
import {
  createTerminalAttachmentId,
  writeTerminalHostAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';

import { resolveDaemonCliSubcommandFromBackendTarget } from '../backendTargetRouting';
import { buildTmuxSpawnConfig } from '../platform/tmux/spawnConfig';
import type { ChildExit } from '../sessions/onChildExited';
import type {
  RunnerAgentInvocationContext,
  TrackedSession,
} from '../types';
import type {
  RunnerAgentSessionBootstrapAuthorization,
} from '../agentRuntime/sessionBridgeAuthorization';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import type { SpawnCommitRevalidation } from './spawnCommitRevalidation';
import type { HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';
import { waitForTerminalHostedSessionWebhook } from './waitForTerminalHostedSessionWebhook';

type SpawnTmuxHostedSessionAndWaitForWebhookResult = Readonly<{
  spawnResult: SpawnSessionResult | null;
  tmuxRequested: boolean;
  tmuxFallbackReason: string | null;
  tmuxCreationDisposition: TmuxWindowCreationDisposition;
  tmuxCleanupIncomplete?: boolean;
  spawnFailure?: SpawnFailure;
}>;

export async function spawnTmuxHostedSessionAndWaitForWebhook(params: Readonly<{
  terminalRequest: ResolvedTerminalRequest;
  startingMode?: 'terminal' | 'remote';
  directory: string;
  options: SpawnSessionOptions;
  trackedSpawnOptions: SpawnSessionOptions;
  normalizedExistingSessionId: string;
  /** Creation outcome of a Session the daemon committed before launch; its attaching runner reports none. */
  sessionCreationOutcome?: TrackedSession['sessionCreationOutcome'];
  effectiveResume: string;
  effectiveBackendTargetV2: BackendTargetRefV2;
  sessionControlArgs: readonly string[];
  directoryCreated: boolean;
  extraEnvForChildWithMessage: Record<string, string>;
  unsetEnvKeys?: readonly string[];
  runnerAgentSessionBootstrapAuthorization?:
    RunnerAgentSessionBootstrapAuthorization | null;
  runnerAgentInvocationContext?: RunnerAgentInvocationContext | null;
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
  revalidateBeforeCommit?: SpawnCommitRevalidation;
  runnerLaunchOptions?: HappyCliSubprocessLaunchOptions;
  memoryHighBytes?: number | null;
  readSpawnFailureLimits?: SpawnFailureLimitsReader;
}>): Promise<SpawnTmuxHostedSessionAndWaitForWebhookResult> {
  const sanitizeDiagnosticText = params.sanitizeDiagnosticText ?? ((value: string) => value);
  const tmuxRequested = params.terminalRequest.requested === 'tmux';
  const tmuxAvailable = tmuxRequested && await isTmuxAvailable();
  const useTmux = tmuxAvailable && tmuxRequested;

  const tmuxSessionName = tmuxRequested ? params.terminalRequest.tmux.sessionName : undefined;
  const tmuxTmpDir = tmuxRequested ? params.terminalRequest.tmux.tmpDir : null;
  const tmuxCommandEnv: Record<string, string> = {};
  if (tmuxTmpDir) {
    tmuxCommandEnv.TMUX_TMPDIR = tmuxTmpDir;
  }

  let tmuxFallbackReason: string | null = null;

  if (!tmuxAvailable && tmuxRequested) {
    tmuxFallbackReason = 'tmux is not available on this machine';
    params.logDebug('[DAEMON RUN] tmux requested but tmux is not available; falling back to regular spawning');
  }

  if (!(useTmux && tmuxSessionName !== undefined)) {
    return {
      spawnResult: null,
      tmuxRequested,
      tmuxFallbackReason,
      tmuxCreationDisposition: 'not_created',
    };
  }

  // Resolve empty-string session name (legacy "current/most recent") deterministically.
  let resolvedTmuxSessionName = tmuxSessionName;
  if (tmuxSessionName === '') {
    try {
      const tmuxForDiscovery = new TmuxUtilities(undefined, tmuxCommandEnv);
      const listResult = await tmuxForDiscovery.executeTmuxCommand([
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_attached}\t#{session_last_attached}',
      ]);
      resolvedTmuxSessionName =
        selectPreferredTmuxSessionName(listResult?.stdout ?? '') ?? TmuxUtilities.DEFAULT_SESSION_NAME;
    } catch (error) {
      params.logDebug(
        '[DAEMON RUN] Failed to resolve current/most-recent tmux session; defaulting to "happy"',
        sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
      );
      resolvedTmuxSessionName = TmuxUtilities.DEFAULT_SESSION_NAME;
    }
  }

  params.logDebug('[DAEMON RUN] Attempting to spawn session in tmux');

  const agentSubcommand = resolveDaemonCliSubcommandFromBackendTarget(params.effectiveBackendTargetV2);
  if (!agentSubcommand) {
    return {
      spawnResult: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unknown backend target',
      },
      tmuxRequested,
      tmuxFallbackReason,
      tmuxCreationDisposition: 'not_created',
    };
  }

  const windowName = `happy-${randomUUID()}-${agentSubcommand}`;
  const tmuxTarget = `${resolvedTmuxSessionName}:${windowName}`;
  const attachmentId = createTerminalAttachmentId();

  const terminalRuntimeArgs = [
    '--happy-terminal-mode',
    'tmux',
    '--happy-terminal-requested',
    'tmux',
    '--happy-tmux-target',
    tmuxTarget,
    '--happy-terminal-attachment-id',
    attachmentId,
    ...(tmuxTmpDir ? ['--happy-tmux-tmpdir', tmuxTmpDir] : []),
  ];

  const { commandTokens, tmuxEnv, unsetEnvKeys, linuxLaunchUnit } = await buildTmuxSpawnConfig({
    memoryHighBytes: params.memoryHighBytes,
    sessionId: params.normalizedExistingSessionId,
    happierHomeDir: configuration.happyHomeDir,
    startingMode: params.startingMode,
    agent: agentSubcommand,
    directory: params.directory,
    extraEnv: params.extraEnvForChildWithMessage,
    unsetEnvKeys: params.unsetEnvKeys,
    tmuxCommandEnv,
    extraArgs: [
      ...terminalRuntimeArgs,
      ...params.sessionControlArgs,
    ],
    launchOptions: params.runnerLaunchOptions,
  });
  const tmux = new TmuxUtilities(resolvedTmuxSessionName, tmuxCommandEnv);

  // Spawn in tmux with the merged window environment so tmux mode matches
  // regular process spawn behavior. `spawnInTmux` keeps values out of tmux
  // client arguments and scopes them to the one launched window.
  const commitRefusal = await params.revalidateBeforeCommit?.() ?? null;
  if (commitRefusal) {
    return {
      spawnResult: commitRefusal,
      tmuxRequested,
      tmuxFallbackReason,
      tmuxCreationDisposition: 'not_created',
    };
  }

  const tmuxResult = await tmux.spawnInTmux(commandTokens, {
    readSpawnFailureLimits: params.readSpawnFailureLimits,
    sessionName: resolvedTmuxSessionName,
    windowName,
    windowNameIsUnique: true,
    cwd: params.directory,
    unsetEnvKeys,
    ...(params.revalidateBeforeCommit
      ? { beforeCreateWindow: params.revalidateBeforeCommit }
      : {}),
  }, tmuxEnv);

  if (tmuxResult.commitRefusal !== undefined) {
    return {
      spawnResult: tmuxResult.commitRefusal,
      tmuxRequested,
      tmuxFallbackReason,
      tmuxCreationDisposition: tmuxResult.creationDisposition,
      tmuxCleanupIncomplete: tmuxResult.cleanupIncomplete,
    };
  }

  if (!tmuxResult.success) {
    tmuxFallbackReason = sanitizeDiagnosticText(tmuxResult.error ?? 'tmux spawn failed');
    const outcome = tmuxResult.creationDisposition === 'not_created' && !tmuxResult.cleanupIncomplete
      ? 'falling back to regular spawning'
      : 'refusing regular-spawn fallback because window creation may have committed';
    params.logDebug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxFallbackReason}, ${outcome}`);
    return {
      spawnResult: null,
      tmuxRequested,
      tmuxFallbackReason,
      tmuxCreationDisposition: tmuxResult.creationDisposition,
      tmuxCleanupIncomplete: tmuxResult.cleanupIncomplete,
      spawnFailure: tmuxResult.spawnFailure,
    };
  }

  params.logDebug(`[DAEMON RUN] Successfully spawned in tmux, PID: ${tmuxResult.pid}`);

  if (!tmuxResult.pid) {
    throw new Error('Tmux window created but no PID returned');
  }
  const tmuxPid = tmuxResult.pid;

  // Resolve the actual tmux session name used (important when sessionName was empty/undefined)
  const tmuxSession = tmuxResult.sessionName ?? (resolvedTmuxSessionName || 'happy');

  const spawnResult = await waitForTerminalHostedSessionWebhook({
    pid: tmuxPid,
    label: 'tmux',
    normalizedExistingSessionId: params.normalizedExistingSessionId,
    trackedSpawnOptions: params.trackedSpawnOptions,
    ...(params.sessionCreationOutcome ? { sessionCreationOutcome: params.sessionCreationOutcome } : {}),
    effectiveResume: params.effectiveResume,
    directoryCreated: params.directoryCreated,
    message: params.directoryCreated
      ? `The path '${params.trackedSpawnOptions.directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`
      : `Spawned new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`,
    trackedSessionFields: {
      ...(linuxLaunchUnit ? { linuxLaunchUnit } : {}),
      tmuxSessionId: tmuxResult.sessionId,
      ...(typeof tmuxTmpDir === 'string' && tmuxTmpDir.trim() ? { tmuxTmpDir: tmuxTmpDir.trim() } : {}),
    },
    runnerAgentSessionBootstrapAuthorization: params.runnerAgentSessionBootstrapAuthorization,
    runnerAgentInvocationContext: params.runnerAgentInvocationContext,
    pidToTrackedSession: params.pidToTrackedSession,
    pidToAwaiter: params.pidToAwaiter,
    pidToSpawnResultResolver: params.pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
    takeoverAdmission: params.takeoverAdmission,
    onChildExited: params.onChildExited,
    spawnLifecycleCallbacks: params.spawnLifecycleCallbacks,
    cleanupSpawnResources: params.cleanupSpawnResources,
    cancelOwnedHost: async () => await tmux.killWindow(tmuxResult.sessionId),
    bindCanonicalSession: async (sessionId) => {
      await writeTerminalHostAttachmentInfo({
        happyHomeDir: configuration.happyHomeDir,
        sessionId,
        handle: createTmuxTerminalHostHandle({
          attachmentId,
          sessionName: tmuxSession,
          windowId: tmuxResult.windowId,
          ...(tmuxTmpDir ? { tmuxTmpDir } : {}),
          topology: 'shared',
        }),
      });
    },
    logDebug: params.logDebug,
    warn: params.warn,
    sanitizeDiagnosticText,
  });

  return {
    spawnResult,
    tmuxRequested,
    tmuxFallbackReason,
    tmuxCreationDisposition: 'created_or_uncertain',
  };
}
