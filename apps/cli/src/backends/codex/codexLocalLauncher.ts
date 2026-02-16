import type { PermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createManagedChildProcess } from '@/subprocess/supervision/managedChildProcess';
import { updateAgentStateBestEffort, updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';

import { CodexRolloutMirror } from './localControl/codexRolloutMirror';
import { discoverCodexRolloutFileOnce } from './localControl/rolloutDiscovery';
import { resolveCodexMcpPolicyForPermissionMode } from './utils/permissionModePolicy';

export type CodexLauncherResult = { type: 'switch'; resumeId: string } | { type: 'exit'; code: number };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const override =
    typeof process.env.HAPPIER_CODEX_SESSIONS_DIR === 'string'
      ? process.env.HAPPIER_CODEX_SESSIONS_DIR.trim()
      : typeof process.env.HAPPY_CODEX_SESSIONS_DIR === 'string'
        ? process.env.HAPPY_CODEX_SESSIONS_DIR.trim()
        : '';
  if (override) return override;
  return join(os.homedir(), '.codex', 'sessions');
}

function resolveCodexTuiCommand(): string {
  const override =
    typeof process.env.HAPPIER_CODEX_TUI_BIN === 'string'
      ? process.env.HAPPIER_CODEX_TUI_BIN.trim()
      : typeof process.env.HAPPY_CODEX_TUI_BIN === 'string'
        ? process.env.HAPPY_CODEX_TUI_BIN.trim()
        : '';
  return override || 'codex';
}

function buildCodexTuiArgs(opts: { cwd: string; resumeId?: string | null; permissionMode: PermissionMode }): string[] {
  const args: string[] = [];

  const resumeId = typeof opts.resumeId === 'string' && opts.resumeId.trim().length > 0 ? opts.resumeId.trim() : null;
  if (resumeId) {
    args.push('resume', resumeId);
  }

  // Always enforce working directory to match the Happy session path.
  args.push('--cd', opts.cwd);

  const { approvalPolicy, sandbox } = resolveCodexMcpPolicyForPermissionMode(opts.permissionMode);

  args.push('--ask-for-approval', approvalPolicy);
  args.push('--sandbox', sandbox);

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
  const debug = opts.debugMirroring === true;

  let exitReason: CodexLauncherResult | null = null;
  let switchRequested = false;
  let switchNotified = false;
  let mirror: CodexRolloutMirror | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  let childStopRequested = false;

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

  const doSwitch = async (): Promise<void> => {
    if (switchRequested) return;
    switchRequested = true;
    if (!switchNotified) {
      switchNotified = true;
      opts.session.sendSessionEvent({
        type: 'message',
        message: 'Waiting for Codex session to initialize before switching to remote mode…',
      });
    }
  };

  try {
    // Local-control: any incoming UI message triggers a mode switch to remote.
    opts.messageQueue.setOnMessage(() => {
      void doSwitch();
    });

    // Allow the UI to request a switch explicitly.
    opts.session.rpcHandlerManager.registerHandler('switch', async (params: any) => {
      const to = params && typeof params === 'object' ? (params as any).to : undefined;
      if (to === 'local') return false;
      await doSwitch();
      return true;
    });

    // Spawn Codex TUI process.
    const command = resolveCodexTuiCommand();
    const args = buildCodexTuiArgs({
      cwd: opts.path,
      resumeId: opts.resumeId,
      permissionMode: opts.permissionMode ?? 'default',
    });

    const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    let bufferedStderr = '';
    const maxBufferedStderrChars = 16_000;
    child = spawn(command, args, {
      cwd: opts.path,
      env: process.env,
      stdio: interactive ? 'inherit' : 'pipe',
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
      if (event.type === 'exited') return event.code;
      if (event.type === 'signaled') return childStopRequested ? 0 : 1;
      return 1;
    });

    // Discover rollout file.
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
        opts.session.sendSessionEvent({
          type: 'message',
          message: 'Codex rollout file still not found — continuing to wait for it to appear…',
        });
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

    queueCodexSessionIdPublish(candidateFile.sessionMeta?.id);
    maybePublishPendingCodexSessionId();

    if (switchRequested) {
      const resumeId = knownResumeId.value;
      if (resumeId) {
        // We can now safely switch because the session id is known.
        exitReason = { type: 'switch', resumeId };
      }
      if (child && child.exitCode === null) {
        childStopRequested = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }

    mirror = new CodexRolloutMirror({
      filePath: candidateFile.filePath,
      debug,
      session: opts.session,
      onCodexSessionId: (id) => queueCodexSessionIdPublish(id),
    });
    await mirror.start();

    // Wait for either a switch request or process exit.
    const code = await Promise.race([
      childExitPromise,
      (async () => {
        while (!exitReason) {
          maybePublishPendingCodexSessionId();
          const resumeId = knownResumeId.value;
          if (switchRequested && resumeId) {
            exitReason = { type: 'switch', resumeId };
            if (child && child.exitCode === null) {
              childStopRequested = true;
              try {
                child.kill('SIGTERM');
              } catch {
                // ignore
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

    if (exitReason) {
      try {
        opts.session.sendSessionEvent({ type: 'switch', mode: 'remote' });
      } catch {
        // ignore
      }
      updateAgentStateBestEffort(
        opts.session,
        (current) => ({ ...current, controlledByUser: false }),
        '[codex]',
        'codex_local_launcher_switch',
      );
      return exitReason;
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
  } finally {
    opts.messageQueue.setOnMessage(null);
    try {
      await mirror?.stop();
    } catch {
      // ignore
    }
    if (child && child.exitCode === null) {
      childStopRequested = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }
}
