import fs from 'fs/promises';
import { randomUUID } from 'node:crypto';

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
import { writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import { resolveDaemonCliSubcommandFromBackendTarget } from '../backendTargetRouting';
import { buildTmuxSpawnConfig } from '../platform/tmux/spawnConfig';
import { resolveSpawnWebhookResult } from '../sessions/resolveSpawnWebhookResult';
import type { ChildExit } from '../sessions/onChildExited';
import type { TrackedSession } from '../types';
import type { PluginLocalServicesBridgeAuthorization } from '../local/services/pluginBridgeAuthorization';
import type { AgentRuntimeSessionBridgeAuthorization } from '../agentRuntime/sessionBridgeAuthorization';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { waitForSessionWebhook } from './waitForSessionWebhook';
import type { SpawnCommitRevalidation } from './spawnCommitRevalidation';
import type { HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';
import {
  completeStartupCancellationCleanup,
  resolveSpawnErrorAfterStartupCancellation,
  type CancelStartupLaunch,
} from './startupLaunchCancellation';

type SpawnTmuxHostedSessionAndWaitForWebhookResult = Readonly<{
  spawnResult: SpawnSessionResult | null;
  tmuxRequested: boolean;
  tmuxFallbackReason: string | null;
  tmuxCreationDisposition: TmuxWindowCreationDisposition;
}>;

export async function spawnTmuxHostedSessionAndWaitForWebhook(params: Readonly<{
  terminalRequest: ResolvedTerminalRequest;
  directory: string;
  options: SpawnSessionOptions;
  trackedSpawnOptions: SpawnSessionOptions;
  normalizedExistingSessionId: string;
  effectiveResume: string;
  effectiveBackendTargetV2: BackendTargetRefV2;
  sessionControlArgs: readonly string[];
  directoryCreated: boolean;
  extraEnvForChildWithMessage: Record<string, string>;
  unsetEnvKeys?: readonly string[];
  localServicesBridgeAuthorization: PluginLocalServicesBridgeAuthorization;
  agentRuntimeSessionBridgeAuthorization?: AgentRuntimeSessionBridgeAuthorization | null;
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
  revalidateBeforeCommit?: SpawnCommitRevalidation;
  runnerLaunchOptions?: HappyCliSubprocessLaunchOptions;
}>): Promise<SpawnTmuxHostedSessionAndWaitForWebhookResult> {
  const sanitizeDiagnosticText = params.sanitizeDiagnosticText ?? ((value: string) => value);
  const tmuxAvailable = await isTmuxAvailable();
  const tmuxRequested = params.terminalRequest.requested === 'tmux';
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

  const sessionDesc = resolvedTmuxSessionName || 'current/most recent session';
  params.logDebug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

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

  const terminalRuntimeArgs = [
    '--happy-terminal-mode',
    'tmux',
    '--happy-terminal-requested',
    'tmux',
    '--happy-tmux-target',
    tmuxTarget,
    ...(tmuxTmpDir ? ['--happy-tmux-tmpdir', tmuxTmpDir] : []),
  ];

  const { commandTokens, tmuxEnv, unsetEnvKeys } = buildTmuxSpawnConfig({
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
  if (tmuxTmpDir) {
    try {
      await fs.mkdir(tmuxTmpDir, { recursive: true });
    } catch (error) {
      params.logDebug(
        '[DAEMON RUN] Failed to ensure TMUX_TMPDIR exists; tmux may fail to start',
        sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
      );
    }
  }

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
    };
  }

  if (!tmuxResult.success) {
    tmuxFallbackReason = sanitizeDiagnosticText(tmuxResult.error ?? 'tmux spawn failed');
    const outcome = tmuxResult.creationDisposition === 'not_created'
      ? 'falling back to regular spawning'
      : 'refusing regular-spawn fallback because window creation may have committed';
    params.logDebug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxFallbackReason}, ${outcome}`);
    return {
      spawnResult: null,
      tmuxRequested,
      tmuxFallbackReason,
      tmuxCreationDisposition: tmuxResult.creationDisposition,
    };
  }

  params.logDebug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

  if (!tmuxResult.pid) {
    throw new Error('Tmux window created but no PID returned');
  }
  const tmuxPid = tmuxResult.pid;

  // Resolve the actual tmux session name used (important when sessionName was empty/undefined)
  const tmuxSession = tmuxResult.sessionName ?? (resolvedTmuxSessionName || 'happy');

  let resolveAcceptedSpawnMarker!: (accepted: boolean) => void;
  const acceptedSpawnMarkerGate = new Promise<boolean>((resolve) => {
    resolveAcceptedSpawnMarker = resolve;
  });
  const trackedSession: TrackedSession = {
    startedBy: 'daemon',
    happySessionId:
      params.normalizedExistingSessionId || `PID-${tmuxPid}`,
    pid: tmuxPid,
    spawnOptions: params.trackedSpawnOptions,
    acceptedSpawnMarkerGate,
    localServicesBridgeTokenHash: params.localServicesBridgeAuthorization.tokenHash,
    localServicesBridgePluginId: params.localServicesBridgeAuthorization.pluginId,
    localServicesBridgeContributionId: params.localServicesBridgeAuthorization.contributionId,
    localServicesBridgeTokenFilePath: params.localServicesBridgeAuthorization.tokenFilePath,
    ...(params.agentRuntimeSessionBridgeAuthorization ? {
      agentRuntimeBridgeTokenHash: params.agentRuntimeSessionBridgeAuthorization.tokenHash,
      agentRuntimeBridgePluginId:
        params.agentRuntimeSessionBridgeAuthorization.descriptor.pluginId,
      agentRuntimeBridgeAgentId:
        params.agentRuntimeSessionBridgeAuthorization.descriptor.agentId,
      agentRuntimeBridgeBackendId:
        params.agentRuntimeSessionBridgeAuthorization.descriptor.backendId,
      agentRuntimeBridgeGeneration:
        params.agentRuntimeSessionBridgeAuthorization.descriptor.generation,
    } : {}),
    tmuxSessionId: tmuxResult.sessionId,
    tmuxTmpDir: typeof tmuxTmpDir === 'string' && tmuxTmpDir.trim().length > 0 ? tmuxTmpDir.trim() : undefined,
    vendorResumeId: params.effectiveResume || undefined,
    directoryCreated: params.directoryCreated,
    message: params.directoryCreated
      ? `The path '${params.directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`
      : `Spawned new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`,
  };
  let startupLaunchCancellation: ReturnType<CancelStartupLaunch> | null =
    null;
  const cancelStartupLaunch: CancelStartupLaunch = () => {
    startupLaunchCancellation ??= (async () => {
      try {
        await params.cleanupSpawnResources();
      } catch {
        return {
          status: 'incomplete' as const,
          reason: 'exit_cleanup_incomplete' as const,
        };
      }
      if (!await tmux.killWindow(tmuxResult.sessionId)) {
        return {
          status: 'incomplete' as const,
          reason: 'terminal_host_disposition_failed' as const,
        };
      }
      return await completeStartupCancellationCleanup({
        trackedSession,
        pidToTrackedSession: params.pidToTrackedSession,
        onChildExited: params.onChildExited,
      });
    })();
    return startupLaunchCancellation;
  };
  trackedSession.cancelStartupLaunchBeforeAck =
    cancelStartupLaunch;

  params.pidToTrackedSession.set(tmuxPid, trackedSession);
  const acceptedSpawnMarkerPromise =
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker(trackedSession);
  params.logDebug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxPid} (tmux)`);
  const spawnResultPromise = waitForSessionWebhook({
    pid: tmuxPid,
    pidToAwaiter: params.pidToAwaiter,
    pidToSpawnResultResolver: params.pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
    pidToTrackedSession: params.pidToTrackedSession,
    timeoutErrorMessage: `Session webhook timeout for PID ${tmuxPid} (tmux)`,
    onTimeout: () => {
      params.logDebug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxPid} (tmux)`);
    },
    onSuccess: (completedSession) => {
      params.logDebug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
    },
  });
  try {
    await acceptedSpawnMarkerPromise;
  } catch (error) {
    resolveAcceptedSpawnMarker(false);
    const timeout = params.pidToSpawnWebhookTimeout.get(tmuxPid);
    if (timeout) clearTimeout(timeout);
    params.pidToSpawnWebhookTimeout.delete(tmuxPid);
    params.pidToAwaiter.delete(tmuxPid);
    params.pidToSpawnResultResolver.delete(tmuxPid);
    if (
      params.pidToTrackedSession.get(trackedSession.pid)
      === trackedSession
    ) {
      const incompleteRetirement =
        resolveSpawnErrorAfterStartupCancellation(
          await cancelStartupLaunch(),
        );
      if (incompleteRetirement) {
        throw new Error(incompleteRetirement);
      }
    }
    throw error;
  }
  params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget(tmuxPid);
  params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid(tmuxPid);
  params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid(tmuxPid);
  trackedSession.acceptedSpawnMarkerGate = undefined;
  resolveAcceptedSpawnMarker(true);

  let spawnResult = await spawnResultPromise.then((result) =>
    resolveSpawnWebhookResult({
      pid: tmuxPid,
      result,
      pidToTrackedSession: params.pidToTrackedSession,
      warn: params.warn,
    }),
  );
  if (
    spawnResult.type === 'error'
    && (
      trackedSession.spawnStartupReadinessFailure
      || typeof trackedSession.sessionWebhookTimedOutAtMs === 'number'
    )
  ) {
    const incompleteRetirement =
      resolveSpawnErrorAfterStartupCancellation(
        await cancelStartupLaunch(),
      );
    if (incompleteRetirement) {
      spawnResult = {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: incompleteRetirement,
      };
    }
  }
  if (spawnResult.type === 'success') {
    const sessionId = spawnResult.sessionId?.trim() ?? '';
    try {
      if (!sessionId) throw new Error('canonical_session_id_missing');
      await writeTerminalHostAttachmentInfo({
        happyHomeDir: configuration.happyHomeDir,
        sessionId,
        handle: createTmuxTerminalHostHandle({
          sessionName: tmuxSession,
          windowName: tmuxResult.windowName ?? windowName,
          ...(tmuxTmpDir ? { tmuxTmpDir } : {}),
          topology: 'shared',
        }),
      });
    } catch (error) {
      params.logDebug(
        '[DAEMON RUN] Failed to bind the spawned tmux host to its canonical session',
        sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
      );
      const incompleteRetirement = resolveSpawnErrorAfterStartupCancellation(
        await cancelStartupLaunch(),
      );
      spawnResult = {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: incompleteRetirement ?? 'terminal_attachment_binding_failed',
      };
    }
  }
  if (spawnResult.type === 'success') {
    delete trackedSession.cancelStartupLaunchBeforeAck;
  }

  return {
    spawnResult,
    tmuxRequested,
    tmuxFallbackReason,
    tmuxCreationDisposition: 'created_or_uncertain',
  };
}
