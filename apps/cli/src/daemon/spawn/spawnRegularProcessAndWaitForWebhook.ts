import { spawn as spawnChildProcess } from 'node:child_process';

import type { ChildExit } from '../sessions/onChildExited';
import { resolveSpawnWebhookResult } from '../sessions/resolveSpawnWebhookResult';
import type { TrackedSession } from '../types';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import { applySpawnedChildOomScoreAdjustment } from '../platform/linux/applySpawnedChildOomScoreAdjustment';
import { buildCgroupSelfMigratingHappyCliLaunchSpec } from '../platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { waitForSessionWebhook } from './waitForSessionWebhook';

export async function spawnRegularProcessAndWaitForWebhook(params: Readonly<{
  args: readonly string[];
  directory: string;
  options: SpawnSessionOptions;
  trackedSpawnOptions: SpawnSessionOptions;
  normalizedExistingSessionId: string;
  effectiveResume: string;
  directoryCreated: boolean;
  extraEnvForChildWithMessage: Record<string, string>;
  processEnv: NodeJS.ProcessEnv;
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
  // NOTE: sessionId is reserved for future Happy session resume; we currently ignore it.
  const baseEnv = buildSpawnChildProcessEnv({
    processEnv: params.processEnv,
    extraEnv: params.extraEnvForChildWithMessage,
  });
  const useLinuxCgroupSelfMigration =
    process.platform === 'linux'
    && String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() === 'background-service';
  const cgroupSelfMigratingLaunchSpec = useLinuxCgroupSelfMigration
    ? await buildCgroupSelfMigratingHappyCliLaunchSpec({
      args: Array.from(params.args),
      daemonPid: process.pid,
    })
    : null;
  const happyProcess = cgroupSelfMigratingLaunchSpec
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
    }, {
      preferWindowsPackagedBinary: true,
    });

  if (process.env.DEBUG) {
    happyProcess.stdout?.on('data', (data) => {
      params.logDebug(`[DAEMON RUN] Child stdout: ${data.toString()}`);
    });
    happyProcess.stderr?.on('data', (data) => {
      params.logDebug(`[DAEMON RUN] Child stderr: ${data.toString()}`);
    });
  }

  const pid = happyProcess.pid;
  if (typeof pid !== 'number') {
    params.logDebug('[DAEMON RUN] Failed to spawn process - no PID returned');
    params.cleanupSpawnResources();
    await params.spawnLifecycleCallbacks.cleanupPendingSessionAttach();
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID,
      errorMessage: 'Failed to spawn Happier process - no PID returned',
    };
  }

  params.logDebug(`[DAEMON RUN] Spawned process with PID ${pid}`);
  void applySpawnedChildOomScoreAdjustment({
    pid,
    env: params.processEnv,
    startupSource: String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() || undefined,
    logDebug: params.logDebug,
  });
  params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid(pid);

  const trackedSession: TrackedSession = {
    startedBy: 'daemon',
    happySessionId: params.normalizedExistingSessionId || undefined,
    pid,
    childProcess: happyProcess,
    spawnOptions: params.trackedSpawnOptions,
    vendorResumeId: params.effectiveResume || undefined,
    directoryCreated: params.directoryCreated,
    message: params.directoryCreated
      ? `The path '${params.directory}' did not exist. We created a new folder and spawned a new session there.`
      : undefined,
  };
  params.pidToTrackedSession.set(pid, trackedSession);
  params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget(pid);
  params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid(pid);

  happyProcess.on('exit', (code, signal) => {
    params.logDebug(`[DAEMON RUN] Child PID ${pid} exited with code ${code}, signal ${signal}`);
    if (pid) {
      const resolveSpawn = params.pidToSpawnResultResolver.get(pid);
      if (resolveSpawn) {
        params.pidToSpawnResultResolver.delete(pid);
        const timeout = params.pidToSpawnWebhookTimeout.get(pid);
        if (timeout) clearTimeout(timeout);
        params.pidToSpawnWebhookTimeout.delete(pid);
        params.pidToAwaiter.delete(pid);
        resolveSpawn({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
          errorMessage: `Child process exited before session webhook (pid=${pid}, code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        });
      }
      params.onChildExited(pid, { reason: 'process-exited', code, signal });
    }
  });

  happyProcess.on('error', (error) => {
    params.logDebug('[DAEMON RUN] Child process error:', error);
    if (pid) {
      const resolveSpawn = params.pidToSpawnResultResolver.get(pid);
      if (resolveSpawn) {
        params.pidToSpawnResultResolver.delete(pid);
        const timeout = params.pidToSpawnWebhookTimeout.get(pid);
        if (timeout) clearTimeout(timeout);
        params.pidToSpawnWebhookTimeout.delete(pid);
        params.pidToAwaiter.delete(pid);
        resolveSpawn({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
          errorMessage: `Child process error before session webhook (pid=${pid})`,
        });
      }
      params.onChildExited(pid, { reason: 'process-error', code: null, signal: null });
    }
  });

  params.logDebug(`[DAEMON RUN] Waiting for session webhook for PID ${pid}`);
  return await waitForSessionWebhook({
    pid,
    pidToAwaiter: params.pidToAwaiter,
    pidToSpawnResultResolver: params.pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
    timeoutErrorMessage: `Session webhook timeout for PID ${pid}`,
    resolveExistingSessionId: () => params.resolveCanonicalTrackedSessionId(pid),
    onTimeout: () => {
      params.logDebug(`[DAEMON RUN] Session webhook timeout for PID ${pid}`);
    },
    onSuccess: (completedSession) => {
      params.logDebug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
    },
  }).then((result) =>
    resolveSpawnWebhookResult({
      pid,
      result,
      pidToTrackedSession: params.pidToTrackedSession,
      warn: params.warn,
    }),
  );
}
