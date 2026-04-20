import fs from 'fs/promises';

import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { selectPreferredTmuxSessionName, TmuxUtilities, isTmuxAvailable } from '@/integrations/tmux';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { ResolvedTerminalRequest } from '@/terminal/runtime/terminalConfig';

import { resolveDaemonCliSubcommandFromBackendTarget } from '../backendTargetRouting';
import { buildTmuxSpawnConfig } from '../platform/tmux/spawnConfig';
import { resolveSpawnWebhookResult } from '../sessions/resolveSpawnWebhookResult';
import type { TrackedSession } from '../types';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { waitForSessionWebhook } from './waitForSessionWebhook';

type SpawnTmuxHostedSessionAndWaitForWebhookResult = Readonly<{
  spawnResult: SpawnSessionResult | null;
  tmuxRequested: boolean;
  tmuxFallbackReason: string | null;
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
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  resolveCanonicalTrackedSessionId: (pid: number) => string;
  spawnLifecycleCallbacks: SpawnLifecycleCallbacks;
  logDebug: (message: string, payload?: unknown) => void;
  warn: (message: string) => void;
}>): Promise<SpawnTmuxHostedSessionAndWaitForWebhookResult> {
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
      params.logDebug('[DAEMON RUN] Failed to resolve current/most-recent tmux session; defaulting to "happy"', error);
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
    };
  }

  const windowName = `happy-${Date.now()}-${agentSubcommand}`;
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

  const { commandTokens, tmuxEnv } = buildTmuxSpawnConfig({
    agent: agentSubcommand,
    directory: params.directory,
    extraEnv: params.extraEnvForChildWithMessage,
    tmuxCommandEnv,
    extraArgs: [
      ...terminalRuntimeArgs,
      ...params.sessionControlArgs,
    ],
  });
  const tmux = new TmuxUtilities(resolvedTmuxSessionName, tmuxCommandEnv);

  // Spawn in tmux with environment variables
  // IMPORTANT: `spawnInTmux` uses `-e KEY=VALUE` flags for the window.
  // Use merged env so tmux mode matches regular process spawn behavior.
  // Note: this may add many `-e` flags; if it becomes a problem we can optimize
  // by diffing against `tmux show-environment` in a follow-up.
  if (tmuxTmpDir) {
    try {
      await fs.mkdir(tmuxTmpDir, { recursive: true });
    } catch (error) {
      params.logDebug('[DAEMON RUN] Failed to ensure TMUX_TMPDIR exists; tmux may fail to start', error);
    }
  }

  const tmuxResult = await tmux.spawnInTmux(commandTokens, {
    sessionName: resolvedTmuxSessionName,
    windowName,
    cwd: params.directory,
  }, tmuxEnv);

  if (!tmuxResult.success) {
    tmuxFallbackReason = tmuxResult.error ?? 'tmux spawn failed';
    params.logDebug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
    return {
      spawnResult: null,
      tmuxRequested,
      tmuxFallbackReason,
    };
  }

  params.logDebug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

  if (!tmuxResult.pid) {
    throw new Error('Tmux window created but no PID returned');
  }
  const tmuxPid = tmuxResult.pid;

  // Resolve the actual tmux session name used (important when sessionName was empty/undefined)
  const tmuxSession = tmuxResult.sessionName ?? (resolvedTmuxSessionName || 'happy');

  const trackedSession: TrackedSession = {
    startedBy: 'daemon',
    happySessionId: params.normalizedExistingSessionId || undefined,
    pid: tmuxPid,
    spawnOptions: params.trackedSpawnOptions,
    tmuxSessionId: tmuxResult.sessionId,
    tmuxTmpDir: typeof tmuxTmpDir === 'string' && tmuxTmpDir.trim().length > 0 ? tmuxTmpDir.trim() : undefined,
    vendorResumeId: params.effectiveResume || undefined,
    directoryCreated: params.directoryCreated,
    message: params.directoryCreated
      ? `The path '${params.directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`
      : `Spawned new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`,
  };

  params.pidToTrackedSession.set(tmuxPid, trackedSession);
  params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget(tmuxPid);
  params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid(tmuxPid);
  params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid(tmuxPid);

  params.logDebug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxPid} (tmux)`);
  const spawnResult = await waitForSessionWebhook({
    pid: tmuxPid,
    pidToAwaiter: params.pidToAwaiter,
    pidToSpawnResultResolver: params.pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
    timeoutErrorMessage: `Session webhook timeout for PID ${tmuxPid} (tmux)`,
    resolveExistingSessionId: () => params.resolveCanonicalTrackedSessionId(tmuxPid),
    onTimeout: () => {
      params.logDebug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxPid} (tmux)`);
    },
    onSuccess: (completedSession) => {
      params.logDebug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
    },
  }).then((result) =>
    resolveSpawnWebhookResult({
      pid: tmuxPid,
      result,
      pidToTrackedSession: params.pidToTrackedSession,
      warn: params.warn,
    }),
  );

  return {
    spawnResult,
    tmuxRequested,
    tmuxFallbackReason,
  };
}
