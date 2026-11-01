import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { basename } from 'node:path';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { logger } from '@/ui/logger';
import { resolveOpenCodeCliLaunchSpec } from '@/backends/opencode/utils/resolveOpenCodeCliCommand';

import { resolveOpenCodeServerAuthHeaders } from './openCodeServerAuth';
import {
  resolveOpenCodeManagedServerLaunchCredential,
  resolveOpenCodeManagedServerReadinessCredentials,
} from './openCodeManagedServerCredential';
import {
  resolveOpenCodeManagedServerChildEnv,
} from './openCodeManagedServerEnv';
import {
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
} from '@/backends/opencode/brokerPlugin/openCodeBrokerPluginEnv';
import {
  prepareOpenCodeConnectedAuthAssets,
} from '@/backends/opencode/brokerPlugin/openCodeBrokerPluginAssets';
import { resolveOpenCodeManagedServerTrackedPid } from './resolveOpenCodeManagedServerTrackedPid';
import { terminateManagedOpenCodeServerPidBestEffort } from './terminateManagedOpenCodeServerPidBestEffort';
import { waitForOpenCodeServerHealth } from './waitForOpenCodeServerHealth';
import {
  createOpenCodeManagedServerLogCapture,
  pruneOpenCodeManagedServerLogs,
} from './managedServerLogs';
import { resolveOpenCodeManagedServerStartTimeoutMsFromEnv } from './openCodeManagedServerTimeouts';

async function resolveEphemeralPort(hostname: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve ephemeral port')));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * For connected (config-isolated) sessions only, ensure the Happier-owned config home exists and the
 * broker plugin file(s) referenced by the materialized `OPENCODE_CONFIG_CONTENT` are written. Keyed
 * on the selection-identity env so NATIVE sessions (no selection identity) are a strict no-op and
 * keep loading the user's own config/plugins.
 */
async function ensureConnectedOpenCodeBrokerAssetsBeforeSpawn(
  env: NodeJS.ProcessEnv,
  apiGeneration: 'auto' | 'v2',
): Promise<Readonly<{ brokerLoadNonce: string | null; openCodeConfigContent?: string }>> {
  const prepared = await prepareOpenCodeConnectedAuthAssets({ env, apiGeneration });
  let brokerLoadNonce: string | null = null;
  if (prepared.providers.length > 0) {
    brokerLoadNonce = randomUUID();
    env[OPEN_CODE_BROKER_LOAD_NONCE_ENV] = brokerLoadNonce;
  }
  return {
    brokerLoadNonce,
    ...(prepared.openCodeConfigContent ? { openCodeConfigContent: prepared.openCodeConfigContent } : {}),
  };
}

export async function startManagedOpenCodeServer(params: Readonly<{
  hostname?: string;
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onCleanup?: (cleanup: () => Promise<void>) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  xdgRootDir?: string | null;
  isolateConfig?: boolean;
  /** Override the durable-log directory (defaults to `configuration.logsDir`). */
  logsDir?: string;
  /** Launch fingerprint recorded in the log header for cross-server diagnostics. */
  launchFingerprint?: string;
  onSpawned?: (started: Readonly<{
    baseUrl: string;
    pid: number;
    logPath: string;
    brokerLoadNonce?: string;
    apiGeneration: 'auto' | 'v2';
    /**
     * Minted password this managed child is protected with, for the state owner to retain. Absent when
     * the child inherited an operator-configured password: that credential is re-derived from the
     * environment (keeping its username override) instead of being written down.
     */
    authPassword?: string;
  }>) => void | Promise<void>;
}> = {}): Promise<{
  baseUrl: string;
  pid: number;
  close: () => Promise<void>;
  logPath: string;
  brokerLoadNonce?: string;
  apiGeneration: 'auto' | 'v2';
  authPassword?: string;
}> {
  params.signal?.throwIfAborted();
  const processEnv = { ...(params.env ?? process.env) };
  const hostname = typeof params.hostname === 'string' && params.hostname.trim().length > 0 ? params.hostname.trim() : '127.0.0.1';
  const port = typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0
    ? Math.floor(params.port)
    : await resolveEphemeralPort(hostname);
  params.signal?.throwIfAborted();
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? Math.floor(params.timeoutMs)
    : resolveOpenCodeManagedServerStartTimeoutMsFromEnv(processEnv);

  const launch = resolveOpenCodeCliLaunchSpec(processEnv);
  const cmd = launch.command;
  const args = [...launch.args, `serve`, `--hostname=${hostname}`, `--port=${port}`];
  // Released OpenCode 2 password-protects every `serve`, generating an unknowable secret when the
  // environment supplies none. Mint the credential BEFORE spawning so the child is protected with a
  // password this launch can authenticate with; the caller retains it in the managed-server state so
  // later readers of THIS server can too.
  const launchCredential = resolveOpenCodeManagedServerLaunchCredential(processEnv);
  const readinessCredentials = resolveOpenCodeManagedServerReadinessCredentials({
    env: processEnv,
    launchCredential: launchCredential.credential,
  });
  const healthHeaders = resolveOpenCodeServerAuthHeaders(readinessCredentials.v1);
  const v2HealthHeaders = resolveOpenCodeServerAuthHeaders(readinessCredentials.v2);

  logger.debug('[OpenCodeServer] Spawning managed server', { cmd, args });

  const xdgRootDir = typeof params.xdgRootDir === 'string' ? params.xdgRootDir.trim() : '';
  const isolateConfig = params.isolateConfig === true;

  // Connected sessions (selection identity present) are config-isolated: ensure the Happier-owned
  // empty config home exists and write the broker plugin file(s) before spawn. Native sessions have
  // no selection identity ⇒ this is a no-op ⇒ native HOME/XDG/config/plugins remain untouched.
  const brokerAssets = await ensureConnectedOpenCodeBrokerAssetsBeforeSpawn(
    processEnv,
    launch.apiGeneration,
  );
  const brokerLoadNonce = brokerAssets.brokerLoadNonce;
  params.signal?.throwIfAborted();

  const childEnv = resolveOpenCodeManagedServerChildEnv({
    baseEnv: brokerAssets.openCodeConfigContent
      ? { ...processEnv, OPENCODE_CONFIG_CONTENT: brokerAssets.openCodeConfigContent }
      : processEnv,
    xdgRootDir: xdgRootDir.length > 0 ? xdgRootDir : null,
    isolateConfig,
    authCredential: launchCredential.credential,
  });
  const invocation = resolveWindowsCommandInvocation({
    command: cmd,
    args,
    env: childEnv,
    resolveCommandOnPath: false,
  });

  const proc = spawn(invocation.command, invocation.args, {
    env: childEnv,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const baseUrl = `http://${hostname}:${port}`;
  let trackedPid = proc.pid ?? -1;

  // Durable per-server log: tee post-start stdout/stderr to disk for future incident diagnosis.
  // The data listeners below double as the pipe drain, so the child never blocks on a full pipe.
  const logCapture = createOpenCodeManagedServerLogCapture({
    ...(typeof params.logsDir === 'string' ? { logsDir: params.logsDir } : {}),
    port,
    spawnPid: proc.pid ?? -1,
    commandBasename: basename(cmd),
    args,
    hostname,
    baseUrl,
    ...(typeof params.launchFingerprint === 'string' && params.launchFingerprint.trim().length > 0
      ? { launchFingerprint: params.launchFingerprint.trim() }
      : {}),
  });
  const logPath = logCapture.logPath;

  // Bounded startup buffer (used only for readiness/failure error messages). After readiness we
  // stop growing it but KEEP the listeners so output continues to drain + persist to the log.
  const MAX_STARTUP_OUTPUT_BYTES = 64 * 1024;
  const startupChunks: string[] = [];
  let startupOutputBytes = 0;
  let captureStartupOutput = true;
  const appendStartupOutput = (text: string): void => {
    if (!captureStartupOutput || startupOutputBytes >= MAX_STARTUP_OUTPUT_BYTES) return;
    startupChunks.push(text);
    startupOutputBytes += text.length;
  };
  const readStartupOutput = (): string => startupChunks.join('') || '<no output captured>';
  const onStdout = (chunk: Buffer): void => {
    appendStartupOutput(chunk.toString());
    logCapture.write('stdout', chunk);
  };
  const onStderr = (chunk: Buffer): void => {
    appendStartupOutput(chunk.toString());
    logCapture.write('stderr', chunk);
  };
  proc.stdout?.on('data', onStdout);
  proc.stderr?.on('data', onStderr);

  let closePromise: Promise<void> | null = null;
  const close = async () => {
    if (closePromise) {
      await closePromise;
      return;
    }
    closePromise = (async () => {
      try {
        if (trackedPid > 0) {
          const terminated = await terminateManagedOpenCodeServerPidBestEffort(trackedPid);
          if (!terminated) {
            throw Object.assign(new Error('Owned OpenCode server termination could not be verified'), {
              code: 'open_code_server_termination_incomplete',
            });
          }
          return;
        }
        try {
          proc.kill();
        } catch {
          // best-effort only
        }
      } finally {
        await logCapture.close().catch(() => {});
      }
    })().catch((error: unknown) => {
      logger.infoFile('[OpenCodeServer] Owned native server cleanup failed');
      throw error;
    });
    await closePromise;
  };
  params.onCleanup?.(close);

  let detectedApiGeneration = launch.apiGeneration;
  await new Promise<void>((resolve, reject) => {
    const tag = randomUUID();
    const timer = setTimeout(() => {
      void close().catch(() => undefined);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms (${tag}). Log: ${logPath}. Output:\n${readStartupOutput()}`));
    }, timeoutMs);
    timer.unref?.();

    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      void close().catch(() => undefined);
      const codeLabel = code ?? 'unknown';
      const signalLabel = signal ?? 'none';
      reject(new Error(
        `OpenCode server exited before ready (code=${codeLabel}, signal=${signalLabel}). Log: ${logPath}. Output:
${readStartupOutput()}`,
      ));
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      void close().catch(() => undefined);
      reject(error);
    });

    void waitForOpenCodeServerHealth({
      signal: params.signal,
      baseUrl,
      timeoutMs,
      pollIntervalMs: 200,
      headers: healthHeaders,
      v2Headers: v2HealthHeaders,
      apiGeneration: launch.apiGeneration,
      onReady: (apiGeneration) => {
        detectedApiGeneration = apiGeneration;
      },
    })
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((error) => {
        clearTimeout(timer);
        void close().catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`OpenCode server did not become healthy: ${message}. Log: ${logPath}. Output:
${readStartupOutput()}`));
      });
  }).catch(async (error: unknown) => {
    await close();
    throw error;
  });

  // Readiness reached: stop growing the bounded startup buffer; the log listeners keep draining and
  // persisting subsequent output (this replaces the old removeAllListeners + resume drain-only path).
  captureStartupOutput = false;

  try {
    trackedPid = await resolveOpenCodeManagedServerTrackedPid({
      spawnPid: proc.pid ?? trackedPid,
      baseUrl,
      invocationCommand: invocation.command,
    });
  } catch {
    // keep the spawned pid best-effort
  }
  logCapture.recordTrackedPid(trackedPid);
  if (params.signal?.aborted) {
    await close();
    params.signal.throwIfAborted();
  }

  try {
    await params.onSpawned?.({
      baseUrl,
      pid: trackedPid,
      logPath,
      ...(brokerLoadNonce ? { brokerLoadNonce } : {}),
      apiGeneration: detectedApiGeneration,
      ...(launchCredential.retainedPassword ? { authPassword: launchCredential.retainedPassword } : {}),
    });
  } catch (error) {
    await close();
    throw error;
  }

  // Prune old managed-server logs by count (never the just-created one). Best-effort, non-blocking.
  void pruneOpenCodeManagedServerLogs({
    ...(typeof params.logsDir === 'string' ? { logsDir: params.logsDir } : {}),
    keepPath: logPath,
  }).catch(() => {});

  proc.unref?.();
  return {
    baseUrl,
    pid: trackedPid,
    close,
    logPath,
    ...(brokerLoadNonce ? { brokerLoadNonce } : {}),
    apiGeneration: detectedApiGeneration,
    ...(launchCredential.retainedPassword ? { authPassword: launchCredential.retainedPassword } : {}),
  };
}
