import { spawn as spawnChildProcess, type ChildProcess } from 'node:child_process';

import { observeProcessLaunch } from '@/processes/launchNotification';
import { classifySpawnFailure, spawnFailureMessage, type SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';
import type { ProviderStreamingSanitizer } from '@/providers/spawn/redaction';
import { readHostProcessOwnerTag, withHostProcessOwnerEnvironment } from '@/processes/ownerTag';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { buildHappyCliSubprocessLaunchSpec, spawnHappyCLI, type HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';

import { applySpawnedChildOomScoreAdjustment } from '../platform/linux/applySpawnedChildOomScoreAdjustment';
import { buildCgroupSelfMigratingHappyCliLaunchSpec } from '../platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { createHappierLinuxScopeName, shouldUseSystemdUserSessionResourceGovernor } from '../platform/linux/systemdUserResourceGovernor';
import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import { appendBoundedChildStderr, type CapturedChildStderr } from './childStderrDiagnostic';
import type { SpawnCommitRevalidation } from './spawnCommitRevalidation';

export type DetachedHappierProcessLaunch = Readonly<{
  child: ChildProcess;
  pid: number;
  linuxLaunchUnit?: string;
  /** Bounded, sanitized stderr captured so far. */
  readStderr(): CapturedChildStderr;
  /** Flush the streaming sanitizers into the captured diagnostics (at exit). */
  flushDiagnostics(): void;
}>;

export type DetachedHappierProcessLaunchResult =
  | Readonly<{ status: 'launched'; launch: DetachedHappierProcessLaunch }>
  /** The commit fence refused before any process was created. */
  | Readonly<{ status: 'refused'; result: SpawnSessionResult }>
  /** The OS refused the launch; the caller retires the resources it prepared for it. */
  | Readonly<{ status: 'failed'; result: SpawnSessionResult }>;

/**
 * The daemon's one launch owner for a detached Happier CLI process (a Session runner or the
 * session host): binary-safe command, Linux user scope and memory ceiling, OOM score, bounded
 * sanitized stderr capture.
 */
export async function launchDetachedHappierProcess(params: Readonly<{
  args: readonly string[];
  directory: string;
  processEnv: NodeJS.ProcessEnv;
  /** Handoff environment for this process; the Linux scope launch keys are added here. */
  extraEnv: Readonly<Record<string, string>>;
  unsetEnvKeys?: readonly string[];
  /** The Session a runner is launched for (its process owner); absent = owned like the daemon. */
  sessionId?: string;
  runnerLaunchOptions?: HappyCliSubprocessLaunchOptions;
  memoryHighBytes?: number | null;
  revalidateBeforeCommit?: SpawnCommitRevalidation;
  readSpawnFailureLimits?: SpawnFailureLimitsReader;
  logDebug: (message: string, payload?: unknown) => void;
  sanitizeDiagnosticText?: (value: string) => string;
  createStreamingSanitizer?: () => ProviderStreamingSanitizer;
}>): Promise<DetachedHappierProcessLaunchResult> {
  const processExecStartedAt = performance.now();
  const sanitizeDiagnosticText = params.sanitizeDiagnosticText ?? ((value: string) => value);
  const useLinuxCgroupSelfMigration = shouldUseSystemdUserSessionResourceGovernor({
    platform: process.platform,
    startupSource: String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim(),
  });
  const runnerLaunchSpec = useLinuxCgroupSelfMigration
    ? buildHappyCliSubprocessLaunchSpec(Array.from(params.args), params.runnerLaunchOptions ?? { preferWindowsPackagedBinary: true })
    : null;
  const childEnv = buildSpawnChildProcessEnv({
    ...(params.sessionId ? { processOwner: { kind: 'session' as const, sessionId: params.sessionId } } : {}),
    ...(params.processEnv.HAPPIER_HOME_DIR ? { happierHomeDir: params.processEnv.HAPPIER_HOME_DIR } : {}),
    processEnv: params.processEnv,
    extraEnv: {
      ...params.extraEnv,
      ...(runnerLaunchSpec?.env ?? {}),
    },
    unsetEnvKeys: params.unsetEnvKeys,
  });
  const baseEnv = useLinuxCgroupSelfMigration && !params.sessionId
    ? withHostProcessOwnerEnvironment(childEnv, readHostProcessOwnerTag(params.processEnv))
    : childEnv;
  const cgroupSelfMigratingLaunchSpec = runnerLaunchSpec
    ? await buildCgroupSelfMigratingHappyCliLaunchSpec({
      unit: createHappierLinuxScopeName(baseEnv.HAPPIER_PROCESS_OWNER),
      memoryHighBytes: params.memoryHighBytes,
      launchSpec: { ...runnerLaunchSpec, env: baseEnv },
      daemonPid: process.pid,
      environment: params.processEnv,
    })
    : null;
  const commitRefusal = await params.revalidateBeforeCommit?.() ?? null;
  if (commitRefusal) return { status: 'refused', result: commitRefusal };
  let child: ChildProcess;
  try {
    child = cgroupSelfMigratingLaunchSpec
      ? spawnChildProcess(cgroupSelfMigratingLaunchSpec.filePath, cgroupSelfMigratingLaunchSpec.args, {
        cwd: params.directory,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...baseEnv,
          ...(cgroupSelfMigratingLaunchSpec.env ?? {}),
        },
      })
      : spawnHappyCLI(Array.from(params.args), {
        cwd: params.directory,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: baseEnv,
      }, params.runnerLaunchOptions ?? { preferWindowsPackagedBinary: true });
  } catch (error) {
    const spawnFailure = classifySpawnFailure(error, { syscall: 'spawn', cwd: params.directory, limits: params.readSpawnFailureLimits?.() });
    return { status: 'failed', result: { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: spawnFailureMessage(spawnFailure, 'Failed to spawn Happier process'),
      errorDetail: { kind: 'spawn_failure', ...spawnFailure } } };
  }

  let capturedStderr: CapturedChildStderr = { head: '', tail: '' };
  observeProcessLaunch(child);
  const stderrSanitizer = params.createStreamingSanitizer?.() ?? null;
  const stdoutSanitizer = params.createStreamingSanitizer?.() ?? null;
  const sanitizeStreamChunk = (
    sanitizer: ProviderStreamingSanitizer | null,
    chunk: unknown,
  ): string => sanitizer
    ? sanitizer.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array))
    : sanitizeDiagnosticText(String(chunk ?? ''));
  const flushDiagnostics = () => {
    const stderrFinal = stderrSanitizer?.flush() ?? '';
    if (stderrFinal) capturedStderr = appendBoundedChildStderr(capturedStderr, stderrFinal);
    const stdoutFinal = stdoutSanitizer?.flush() ?? '';
    if (stdoutFinal && process.env.DEBUG) {
      params.logDebug(`[DAEMON RUN] Child stdout: ${stdoutFinal}`);
    }
  };
  child.stderr?.on('data', (data) => {
    const safeChunk = sanitizeStreamChunk(stderrSanitizer, data);
    if (safeChunk) capturedStderr = appendBoundedChildStderr(capturedStderr, safeChunk);
    if (safeChunk && process.env.DEBUG) {
      params.logDebug(`[DAEMON RUN] Child stderr: ${safeChunk}`);
    }
  });
  if (process.env.DEBUG) {
    child.stdout?.on('data', (data) => {
      const safeChunk = sanitizeStreamChunk(stdoutSanitizer, data);
      if (safeChunk) params.logDebug(`[DAEMON RUN] Child stdout: ${safeChunk}`);
    });
  }

  const pid = child.pid;
  if (typeof pid !== 'number') {
    // A failed Node OS spawn has no PID and emits its errno on the next tick.
    // Observe it before returning, so it cannot become an unhandled error.
    const error = await new Promise<Error>((resolve) => child.once('error', resolve));
    const spawnFailure = classifySpawnFailure(error, { syscall: 'spawn', cwd: params.directory, limits: params.readSpawnFailureLimits?.() });
    params.logDebug('[DAEMON RUN] Failed to spawn process - no PID returned');
    return {
      status: 'failed',
      result: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID,
        errorMessage: spawnFailureMessage(spawnFailure, 'Failed to spawn Happier process - no PID returned'),
        errorDetail: { kind: 'spawn_failure', ...spawnFailure },
      },
    };
  }

  params.logDebug(`[DAEMON RUN] Spawned process with PID ${pid}`);
  params.logDebug('[DAEMON RUN] Spawn process phase', { phase: 'process_exec', pid,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    durationMs: Math.round(performance.now() - processExecStartedAt) });
  void applySpawnedChildOomScoreAdjustment({
    pid,
    env: params.processEnv,
    startupSource: String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() || undefined,
    logDebug: params.logDebug,
  });
  return {
    status: 'launched',
    launch: {
      child,
      pid,
      ...(cgroupSelfMigratingLaunchSpec?.linuxLaunchUnit ? { linuxLaunchUnit: cgroupSelfMigratingLaunchSpec.linuxLaunchUnit } : {}),
      readStderr: () => capturedStderr,
      flushDiagnostics,
    },
  };
}
