import type { PermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createManagedChildProcess } from '@/subprocess/supervision/managedChildProcess';
import { updateAgentStateBestEffort, updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { killProcessTree } from '@/agent/acp/killProcessTree';
import { logger } from '@/ui/logger';
import { expandHomeDirPath } from '@happier-dev/cli-common/providers';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { resolveCodexCliInvocation } from './utils/resolveCodexCliInvocation';
import { delay } from '@/utils/time';
import { resolveConfiguredCodexHome } from './utils/resolveConfiguredCodexHome';
import { configuration } from '@/configuration';

import { CodexRolloutMirror } from './localControl/codexRolloutMirror';
import { discoverCodexRolloutFileOnce } from './localControl/rolloutDiscovery';
import { resolveCodexMcpPolicyForPermissionMode } from './utils/permissionModePolicy';
import {
  createDeferredRemoteSwitchController,
  createLocalTurnLifecycleController,
} from '@/agent/localControl/turnLifecycle';
import { startLocalPendingQueueRemoteSwitchWatcher } from '@/agent/localControl/pendingQueue/startLocalPendingQueueRemoteSwitchWatcher';

export type CodexLauncherResult = { type: 'switch'; resumeId: string | null } | { type: 'exit'; code: number };

export type CodexRolloutDiscoveryConfig = Readonly<{
  /**
   * Time to poll aggressively for a rollout file before downgrading to a slower cadence.
   * Keep this short in tests; in production Codex can take a moment to initialize.
   */
  initialTimeoutMs: number;
  /**
   * Poll cadence while within `initialTimeoutMs` OR when a switch-to-remote is pending.
   */
  initialPollIntervalMs: number;
  /**
   * Poll cadence after the initial timeout when no switch is pending.
   */
  extendedPollIntervalMs: number;
}>;

function resolveRolloutDiscoveryConfig(overrides?: Partial<CodexRolloutDiscoveryConfig> | null): CodexRolloutDiscoveryConfig {
  return {
    initialTimeoutMs: typeof overrides?.initialTimeoutMs === 'number' ? overrides.initialTimeoutMs : 30_000,
    initialPollIntervalMs: typeof overrides?.initialPollIntervalMs === 'number' ? overrides.initialPollIntervalMs : 500,
    extendedPollIntervalMs: typeof overrides?.extendedPollIntervalMs === 'number' ? overrides.extendedPollIntervalMs : 2_000,
  };
}

function resolveCodexSessionsRootDir(): string {
  const override = expandHomeDirPath(
    typeof process.env.HAPPIER_CODEX_SESSIONS_DIR === 'string'
      ? process.env.HAPPIER_CODEX_SESSIONS_DIR.trim()
      : typeof process.env.HAPPY_CODEX_SESSIONS_DIR === 'string'
        ? process.env.HAPPY_CODEX_SESSIONS_DIR.trim()
        : '',
    process.env,
  );
  if (override) return override;
  return join(resolveConfiguredCodexHome(process.env), 'sessions');
}

async function resolveCodexTuiInvocation(opts: {
  cwd: string;
  resumeId?: string | null;
  permissionMode: PermissionMode;
}): Promise<{ command: string; args: string[] }> {
  return await resolveCodexCliInvocation({
    args: buildCodexTuiArgs(opts),
    cwd: opts.cwd,
    processEnv: process.env,
    overrideEnvVarKeys: ['HAPPIER_CODEX_TUI_BIN', 'HAPPY_CODEX_TUI_BIN'],
    targetLabel: 'Codex CLI',
  });
}

function buildCodexTuiChildEnv(): NodeJS.ProcessEnv {
  // Ensure Happy-managed Codex TUI sessions start a fresh Codex thread.
  //
  // The Codex Desktop app (and other wrappers) can inject Codex-internal env vars such as
  // CODEX_THREAD_ID into child processes. When present, Codex will attach to an existing
  // thread instead of creating a new one. That prevents the TUI from creating a new rollout
  // file and breaks local-control discovery + switching.
  const env: NodeJS.ProcessEnv = { ...process.env };
  const expandedSessionsDir = resolveCodexSessionsRootDir();
  if (typeof env.HAPPIER_CODEX_SESSIONS_DIR === 'string' || typeof env.HAPPY_CODEX_SESSIONS_DIR === 'string') {
    env.HAPPIER_CODEX_SESSIONS_DIR = expandedSessionsDir;
    delete env.HAPPY_CODEX_SESSIONS_DIR;
  }

  const preserveRaw =
    typeof process.env.HAPPIER_CODEX_TUI_PRESERVE_CODEX_ENV_KEYS === 'string'
      ? process.env.HAPPIER_CODEX_TUI_PRESERVE_CODEX_ENV_KEYS.trim()
      : '';
  const preserveKeys = new Set<string>(
    preserveRaw
      ? preserveRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s && s.startsWith('CODEX_'))
      : [],
  );
  preserveKeys.add('CODEX_HOME');

  const denylist = ['CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_SHELL'] as const;
  for (const key of denylist) {
    if (preserveKeys.has(key)) continue;
    delete env[key];
  }
  return env;
}

function buildCodexTuiArgs(opts: { cwd: string; resumeId?: string | null; permissionMode: PermissionMode }): string[] {
  const args: string[] = [];

  const resumeId = typeof opts.resumeId === 'string' && opts.resumeId.trim().length > 0 ? opts.resumeId.trim() : null;
  if (resumeId) {
    args.push('resume', resumeId);
  }

  // Always enforce working directory to match the Happy session path.
  args.push('--cd', opts.cwd);

  // When the user picked Happier's 'default' mode, don't inject --ask-for-approval or --sandbox
  // so the Codex CLI falls back to the user's ~/.codex/config.toml (top-level approval_policy /
  // sandbox_mode, or a `profile = "..."`-selected profile). Any non-'default' mode still wins,
  // overriding config.toml as before.
  if (opts.permissionMode !== 'default') {
    const { approvalPolicy, sandbox } = resolveCodexMcpPolicyForPermissionMode(opts.permissionMode);
    args.push('--ask-for-approval', approvalPolicy);
    args.push('--sandbox', sandbox);
  }

  return args;
}

function normalizeCodexSessionId(raw: unknown): string | null {
  const next = typeof raw === 'string' ? raw.trim() : '';
  return next.length > 0 ? next : null;
}

export async function codexLocalLauncher<TMode>(opts: {
  path: string;
  api: unknown;
  session: ApiSessionClient;
  messageQueue: MessageQueue2<TMode>;
  permissionMode?: PermissionMode;
  resumeId?: string | null;
  debugMirroring?: boolean;
  rolloutDiscovery?: Partial<CodexRolloutDiscoveryConfig>;
}): Promise<CodexLauncherResult> {
  // Publish local-control state immediately so UIs can render the local/remote banner
  // even before the rollout file is discovered (Codex can take a moment to initialize).
  try {
    opts.session.sendSessionEvent({ type: 'switch', mode: 'local' });
  } catch {
    // ignore
  }
  updateAgentStateBestEffort(
    opts.session,
    (current) => ({ ...current, controlledByUser: true }),
    '[codex]',
    'codex_local_launcher_start',
  );

  const sessionsRootDir = resolveCodexSessionsRootDir();
  mkdirSync(sessionsRootDir, { recursive: true });
  const startedAtMs = Date.now();
  const rolloutDiscovery = resolveRolloutDiscoveryConfig(opts.rolloutDiscovery ?? null);
  const knownResumeId: { value: string | null } = { value: null };
  const pendingMetadataSessionId: { value: string | null } = { value: null };
  let lastMetadataPublishAttemptMs = 0;
  let inFlightMetadataPublish: Promise<void> | null = null;
  const debug = opts.debugMirroring === true;
  const isWindows = process.platform === 'win32';

  let exitReason: CodexLauncherResult | null = null;
  let switchRequested = false;
  let remoteSwitchIntentObserved = false;
  let switchNotified = false;
  let mirror: CodexRolloutMirror | null = null;
  let pendingQueueWatcher: { stop: () => void } | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  let childStopRequested = false;
  const turnLifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
  turnLifecycle.observe({ type: 'turn_started', providerTurnId: null, source: 'codex_rollout_discovery_pending' });

  const publishRemoteControlState = (tag: 'switch' | 'exit' | 'launch_error'): void => {
    try {
      opts.session.sendSessionEvent({ type: 'switch', mode: 'remote' });
    } catch {
      // ignore
    }
    updateAgentStateBestEffort(
      opts.session,
      (current) => ({ ...current, controlledByUser: false }),
      '[codex]',
      `codex_local_launcher_${tag}`,
    );
  };

  const queueCodexSessionIdPublish = (raw: unknown): void => {
    const next = normalizeCodexSessionId(raw);
    if (!next) return;
    knownResumeId.value = next;
    pendingMetadataSessionId.value = next;
  };

  const maybePublishPendingCodexSessionId = (): void => {
    const pending = pendingMetadataSessionId.value;
    if (!pending) return;

    const metadataSnapshotGetter = (opts.session as unknown as { getMetadataSnapshot?: () => unknown }).getMetadataSnapshot;
    const metadata =
      typeof metadataSnapshotGetter === 'function'
        ? (metadataSnapshotGetter.call(opts.session) as Record<string, unknown> | null)
        : null;
    if (metadata && metadata.codexSessionId === pending) {
      pendingMetadataSessionId.value = null;
      return;
    }

    const now = Date.now();
    if (now - lastMetadataPublishAttemptMs < 250) {
      return;
    }
    lastMetadataPublishAttemptMs = now;
    updateMetadataBestEffort(
      opts.session,
      (current) => ({ ...current, codexSessionId: pending }),
      '[codex]',
      'publish_codex_session_id',
    );
  };

  const publishPendingCodexSessionIdNow = async (): Promise<void> => {
    const pending = pendingMetadataSessionId.value;
    if (!pending) return;

    if (inFlightMetadataPublish) {
      await inFlightMetadataPublish.catch(() => undefined);
      return;
    }

    const attempt = (async () => {
      try {
        const metadataSnapshotGetter = (opts.session as unknown as { getMetadataSnapshot?: () => unknown }).getMetadataSnapshot;
        const metadata =
          typeof metadataSnapshotGetter === 'function'
            ? (metadataSnapshotGetter.call(opts.session) as Record<string, unknown> | null)
            : null;
        if (metadata && metadata.codexSessionId === pending) {
          pendingMetadataSessionId.value = null;
          return;
        }

        lastMetadataPublishAttemptMs = Date.now();
        logger.debug('[codex] codexSessionId publish: attempting', { id: pending });
        await Promise.resolve(
          opts.session.updateMetadata((current) => ({
            ...current,
            codexSessionId: pending,
          })),
        );
        logger.debug('[codex] codexSessionId publish: succeeded', { id: pending });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug('[codex] codexSessionId publish: failed', { id: pending, error: message });
        // Best-effort only; retry loop will keep trying.
      }
    })();

    inFlightMetadataPublish = attempt;
    try {
      await attempt;
    } finally {
      if (inFlightMetadataPublish === attempt) {
        inFlightMetadataPublish = null;
      }
    }
  };

  const doSwitch = async (): Promise<void> => {
    if (switchRequested) return;
    switchRequested = true;
    logger.debug('[codex] switch: requested', {
      knownResumeId: knownResumeId.value,
      elapsedSinceStartMs: Date.now() - startedAtMs,
    });
    if (!switchNotified) {
      switchNotified = true;
      opts.session.sendSessionEvent({
        type: 'message',
        message: 'Waiting for Codex session to initialize before switching to remote mode…',
      });
    }
  };

  const deferredRemoteSwitch = createDeferredRemoteSwitchController<TMode>({
    lifecycle: turnLifecycle,
    providerLabel: 'Codex',
    requestSwitchToRemote: async () => {
      await doSwitch();
      return true;
    },
  });

  const releasePendingRolloutDiscoveryLifecycle = (): void => {
    const snapshot = turnLifecycle.snapshot();
    if (!snapshot.active || snapshot.terminal || snapshot.providerTurnId !== null) return;
    turnLifecycle.observe({
      type: 'turn_terminal',
      providerTurnId: null,
      reason: 'completed',
      source: 'codex_rollout_replay_ready',
    });
  };

  try {
    // Local-control: incoming UI messages request a remote switch. If Codex is
    // in an active local turn, the deferred switch controller waits for the
    // rollout terminal event before asking the launcher to stop the child.
    opts.messageQueue.setOnMessage((message, mode) => {
      remoteSwitchIntentObserved = true;
      deferredRemoteSwitch.onQueuedMessage(message, mode);
    });

    pendingQueueWatcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount: () => opts.session.peekPendingMessageQueueV2Count(),
      pollIntervalMs: configuration.pendingQueueIdleWakePollIntervalMs,
      requestRemoteSwitch: () => {
        remoteSwitchIntentObserved = true;
        return deferredRemoteSwitch.requestRemoteSwitch('server_pending_queue');
      },
    });

    // Allow the UI to request a switch explicitly.
    opts.session.rpcHandlerManager.registerHandler('switch', async (params: any) => {
      const to = params && typeof params === 'object' ? (params as any).to : undefined;
      if (to === 'local') return true;
      remoteSwitchIntentObserved = true;
      return await deferredRemoteSwitch.requestRemoteSwitch('rpc_switch');
    });

    const { command, args } = await resolveCodexTuiInvocation({
      cwd: opts.path,
      resumeId: opts.resumeId,
      permissionMode: opts.permissionMode ?? 'default',
    });

    const invocation = resolveWindowsCommandInvocation({
      command,
      args,
      resolveCommandOnPath: true,
    });

    const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    let bufferedStderr = '';
    const maxBufferedStderrChars = 16_000;
    child = spawn(invocation.command, invocation.args, {
      cwd: opts.path,
      env: buildCodexTuiChildEnv(),
      stdio: interactive ? 'inherit' : 'pipe',
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const managedChild = createManagedChildProcess(child);
    child.once('error', (error) => {
      if (interactive) return;
      const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (bufferedStderr.length < maxBufferedStderrChars) {
        bufferedStderr = `${bufferedStderr}\n[spawn-error] ${details}`.slice(0, maxBufferedStderrChars);
      }
    });

    if (!interactive) {
      // Drain streams to avoid backpressure and capture error context for CI/non-interactive runs.
      child.stdout?.on('data', () => {});
      child.stderr?.on('data', (chunk) => {
        if (bufferedStderr.length >= maxBufferedStderrChars) return;
        const next = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
        bufferedStderr = (bufferedStderr + next).slice(0, maxBufferedStderrChars);
      });
    }

    const childExitPromise = managedChild.waitForTermination().then((event) => {
      turnLifecycle.observe({
        type: 'turn_terminal',
        providerTurnId: turnLifecycle.snapshot().providerTurnId,
        reason: 'process-exited',
        source: 'codex_child_process_exit',
      });
      if (event.type === 'exited') return event.code;
      if (event.type === 'signaled') return childStopRequested ? 0 : 1;
      return 1;
    });

    // Discover rollout file.
    logger.debug('[codex] rollout discovery: starting', {
      sessionsRootDir,
      cwd: opts.path,
      resumeId: opts.resumeId ?? null,
      initialTimeoutMs: rolloutDiscovery.initialTimeoutMs,
      initialPollIntervalMs: rolloutDiscovery.initialPollIntervalMs,
    });
    let candidateFile: { filePath: string; sessionMeta: any } | null = null;
    const deadline = Date.now() + rolloutDiscovery.initialTimeoutMs;
    let notifiedMissing = false;
    let notifiedExtendedWait = false;
    let childExited = false;
    while (!candidateFile && Date.now() < deadline) {
      candidateFile = await discoverCodexRolloutFileOnce({
        sessionsRootDir,
        startedAtMs,
        cwd: opts.path,
        resumeId: opts.resumeId ?? null,
        scanLimit: 50,
      });
      if (candidateFile) break;
      if (!notifiedMissing) {
        notifiedMissing = true;
        opts.session.sendSessionEvent({
          type: 'message',
          message: 'Codex rollout file not found yet — waiting for it to appear…',
        });
      }
      const tick = await Promise.race([
        delay(rolloutDiscovery.initialPollIntervalMs).then(() => 'tick' as const),
        childExitPromise.then(() => 'exit' as const),
      ]);
      if (tick === 'exit') {
        childExited = true;
        break;
      }
    }

    // If we didn't find a file quickly, keep retrying at a slower cadence while the child is alive.
    while (!candidateFile && !childExited) {
      const now = Date.now();
      if (now >= deadline && !notifiedExtendedWait) {
        notifiedExtendedWait = true;
        logger.debug('[codex] rollout discovery: extended wait', {
          elapsedMs: now - startedAtMs,
          extendedPollIntervalMs: rolloutDiscovery.extendedPollIntervalMs,
        });
        opts.session.sendSessionEvent({
          type: 'message',
          message: 'Codex rollout file still not found — continuing to wait for it to appear…',
        });
      }

      if (remoteSwitchIntentObserved && !opts.resumeId && now >= deadline) {
        logger.debug('[codex] switch: starting fresh remote because no local rollout was discovered', {
          elapsedSinceStartMs: now - startedAtMs,
        });
        exitReason = { type: 'switch', resumeId: null };
        if (child && child.exitCode === null) {
          childStopRequested = true;
          if (isWindows) {
            void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
          } else {
            try {
              child.kill('SIGTERM');
            } catch {
              // ignore
            }
          }
        }
        childExited = true;
        break;
      }

      candidateFile = await discoverCodexRolloutFileOnce({
        sessionsRootDir,
        startedAtMs,
        cwd: opts.path,
        resumeId: opts.resumeId ?? null,
        scanLimit: 50,
      });
      if (candidateFile) break;

      const intervalMs =
        now < deadline || switchRequested
          ? rolloutDiscovery.initialPollIntervalMs
          : rolloutDiscovery.extendedPollIntervalMs;

      const tick = await Promise.race([
        delay(intervalMs).then(() => 'tick' as const),
        childExitPromise.then(() => 'exit' as const),
      ]);
      if (tick === 'exit') {
        childExited = true;
        break;
      }
    }

    if (!candidateFile) {
      if (exitReason) {
        await childExitPromise;
        publishRemoteControlState('switch');
        return exitReason;
      }
      logger.debug('[codex] rollout discovery: aborted without candidate', {
        elapsedMs: Date.now() - startedAtMs,
        childExited,
      });
      // If we can't find logs, fall back to exiting with the child exit code.
      const code = await childExitPromise;
      if (!interactive && bufferedStderr.trim().length > 0) {
        console.error(`[codex] Local Codex process exited before rollout file was found. stderr:\n${bufferedStderr}`);
      }
      try {
        opts.session.sendSessionEvent({ type: 'switch', mode: 'remote' });
      } catch {
        // ignore
      }
      updateAgentStateBestEffort(
        opts.session,
        (current) => ({ ...current, controlledByUser: false }),
        '[codex]',
        'codex_local_launcher_exit',
      );
      return { type: 'exit', code };
    }

    logger.debug('[codex] rollout discovery: candidate found', {
      filePath: candidateFile.filePath,
      sessionMetaId: candidateFile.sessionMeta?.id,
      sessionMetaTs: candidateFile.sessionMeta?.timestamp,
      elapsedMs: Date.now() - startedAtMs,
    });

    queueCodexSessionIdPublish(candidateFile.sessionMeta?.id);
    await publishPendingCodexSessionIdNow();
    maybePublishPendingCodexSessionId();

    if (switchRequested) {
      const resumeId = knownResumeId.value;
      if (resumeId) {
        logger.debug('[codex] switch: resolved (post-discovery)', {
          resumeId,
          elapsedSinceStartMs: Date.now() - startedAtMs,
        });
        // We can now safely switch because the session id is known.
        exitReason = { type: 'switch', resumeId };
      }
      if (child && child.exitCode === null) {
        childStopRequested = true;
        if (isWindows) {
          void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
        } else {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        }
      }
    }

    mirror = new CodexRolloutMirror({
      filePath: candidateFile.filePath,
      codexHome: process.env.CODEX_HOME ?? null,
      debug,
      session: opts.session,
      onCodexSessionId: async (id) => {
        queueCodexSessionIdPublish(id);
        await publishPendingCodexSessionIdNow();
      },
      onTurnLifecycleEvent: (event) => {
        turnLifecycle.observe(event);
      },
    });
    logger.debug('[codex] mirror: start awaiting', { filePath: candidateFile.filePath });
    await mirror.start();
    releasePendingRolloutDiscoveryLifecycle();
    logger.debug('[codex] mirror: started', { filePath: candidateFile.filePath });

    // Wait for either a switch request or process exit.
    const code = await Promise.race([
      childExitPromise,
      (async () => {
        while (!exitReason) {
          maybePublishPendingCodexSessionId();
          const resumeId = knownResumeId.value;
          if (switchRequested && resumeId) {
            logger.debug('[codex] switch: resolved', {
              resumeId,
              elapsedSinceStartMs: Date.now() - startedAtMs,
            });
            exitReason = { type: 'switch', resumeId };
            if (child && child.exitCode === null) {
              childStopRequested = true;
              if (isWindows) {
                void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
              } else {
                try {
                  child.kill('SIGTERM');
                } catch {
                  // ignore
                }
              }
            }
          }
          await delay(50);
        }
        // Ensure child is fully terminated before returning.
        const exited = await childExitPromise;
        return exited;
      })(),
    ]);

    await mirror.stop();
    mirror = null;

    if (!exitReason && switchRequested && knownResumeId.value) {
      exitReason = { type: 'switch', resumeId: knownResumeId.value };
    }

    if (exitReason) {
      publishRemoteControlState('switch');
      return exitReason;
    }
    publishRemoteControlState('exit');
    return { type: 'exit', code };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      opts.session.sendSessionEvent({ type: 'message', message });
    } catch {
      // ignore
    }
    publishRemoteControlState('launch_error');
    return { type: 'exit', code: 1 };
  } finally {
    pendingQueueWatcher?.stop();
    deferredRemoteSwitch.dispose();
    turnLifecycle.dispose();
    opts.messageQueue.setOnMessage(null);
    try {
      await mirror?.stop();
    } catch {
      // ignore
    }
    if (child && child.exitCode === null) {
      childStopRequested = true;
      if (isWindows) {
        void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
      } else {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
  }
}
