import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { runManagedChildCommand } from '../../../scripts/testing/process/managedChildLifecycle.mjs';
import { createTestTempDirectory } from '../../../scripts/testing/process/temporaryDirectories.mjs';
import { sweepStaleProcessOwnershipLeases } from './sweepProcessOwnershipLeases.mjs';
import {
  appendHeartbeatDiagnostic,
  initializeHeartbeatDiagnostic,
  readCgroupMemorySnapshot,
  resolveOomKillDelta,
} from './heartbeatDiagnostic.mjs';

export { installParentDeathCleanupWatchdog, resolveSignalExitCode } from '../../../scripts/testing/process/managedChildLifecycle.mjs';

export function parseHeartbeatArgs(argv) {
  const args = argv.slice(2);
  let config = null;
  const passThrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config') {
      config = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--config=')) {
      config = arg.slice('--config='.length) || null;
      continue;
    }
    passThrough.push(arg);
  }

  return { config, passThrough };
}

export function createPlaywrightSpawnOptions(env) {
  const nextEnv = {
    ...env,
    PLAYWRIGHT_HTML_OPEN: 'never',
  };
  return {
    stdio: 'inherit',
    env: nextEnv,
    detached: process.platform !== 'win32',
  };
}

function resolveWrapperTimeoutMs(env, fallbackMs = null) {
  const rawTimeoutMs = String(env?.HAPPIER_TEST_WRAPPER_TIMEOUT_MS ?? '').trim();
  if (rawTimeoutMs.length > 0) {
    const parsed = Number.parseInt(rawTimeoutMs, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return Number.isFinite(fallbackMs) && fallbackMs > 0 ? fallbackMs : null;
}

function elapsedSeconds(startedAtMs) {
  return Math.floor((Date.now() - startedAtMs) / 1000);
}

const TIMEOUT_ARTIFACT_TOOL_NAMES = new Set(['playwright', 'vitest']);

function safeCommandMetadata(params) {
  return {
    tool: TIMEOUT_ARTIFACT_TOOL_NAMES.has(params.toolName) ? params.toolName : 'test-command',
    argumentCount: Array.isArray(params.args) ? params.args.length : 0,
    configured: Boolean(params.config),
  };
}

function firstNonEmptyEnv(env, names) {
  for (const name of names) {
    const value = String(env?.[name] ?? '').trim();
    if (value.length > 0) return value;
  }
  return null;
}

function timeoutArtifactIdentity(env) {
  const values = {
    executionCwd: process.cwd(),
    stackRepoDir: firstNonEmptyEnv(env, ['HAPPIER_STACK_REPO_DIR']),
    checkout: firstNonEmptyEnv(env, ['GITHUB_WORKSPACE']),
    commit: firstNonEmptyEnv(env, ['GITHUB_SHA', 'CI_COMMIT_SHA']),
    stack: firstNonEmptyEnv(env, ['HAPPIER_STACK_STACK', 'HAPPIER_STACK_ID']),
    session: firstNonEmptyEnv(env, [
      'HAPPIER_SESSION_ID',
      'HAPPIER_QA_SESSION_ID',
      'CODEX_SESSION_ID',
      'CODEX_THREAD_ID',
    ]),
  };

  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}

async function writeTimeoutArtifact(params, timeoutMs, env) {
  const outputPath = String(env?.HAPPIER_TEST_TIMEOUT_ARTIFACT_PATH ?? '').trim();
  if (outputPath.length === 0) return;

  const identity = timeoutArtifactIdentity(env);
  const artifact = {
    version: 1,
    classification: 'timeout',
    timeoutMs,
    timestamp: new Date().toISOString(),
    command: safeCommandMetadata(params),
    ...(Object.keys(identity).length > 0 ? { identity } : {}),
  };
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(artifact)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, outputPath);
  } catch {
    await unlink(temporaryPath).catch(() => {});
    // eslint-disable-next-line no-console
    console.error('[tests] unable to write timeout artifact');
  }
}

export async function runHeartbeatWrappedCommand(params) {
  const startedAt = Date.now();
  // Reap stale detached lease-owned helpers before spawning a new child run.
  // This prevents a previous crashed wrapper from destabilizing the next run.
  await sweepStaleProcessOwnershipLeases().catch(() => {});
  const commandMetadata = safeCommandMetadata(params);
  const initialMemory = params.diagnosticPath ? await readCgroupMemorySnapshot() : null;
  if (params.diagnosticPath) {
    await initializeHeartbeatDiagnostic(params.diagnosticPath, {
      event: 'start',
      command: commandMetadata,
      pid: process.pid,
      cgroupMemory: initialMemory,
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[tests] starting: ${commandMetadata.tool} (${commandMetadata.argumentCount} arguments; config=${commandMetadata.configured ? 'set' : 'unset'})`);

  const heartbeatMs = Number.parseInt(process.env.HAPPIER_TEST_HEARTBEAT_MS ?? '30000', 10);
  const safeHeartbeatMs = Number.isFinite(heartbeatMs) && heartbeatMs >= 1000 ? heartbeatMs : 30000;
  const wrapperTimeoutMs = resolveWrapperTimeoutMs(process.env, params.defaultTimeoutMs ?? null);

  const heartbeat = setInterval(() => {
    // eslint-disable-next-line no-console
    console.log(`[tests] still running (${elapsedSeconds(startedAt)}s elapsed): ${commandMetadata.tool}`);
  }, safeHeartbeatMs);

  let finished = false;
  function clearHeartbeat() {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
  }

  let spawnOptions = params.spawnOptions;
  if (params.toolName === 'playwright') {
    const { root } = createTestTempDirectory('happier-playwright-');
    spawnOptions = {
      ...spawnOptions,
      env: { ...spawnOptions.env, HAPPIER_TEST_TEMP_ROOTS: process.env.HAPPIER_TEST_TEMP_ROOTS, TMPDIR: root, TMP: root, TEMP: root },
    };
  }

  const result = await runManagedChildCommand({
    command: params.command,
    args: params.args,
    spawnOptions,
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    maxRuntimeMs: wrapperTimeoutMs,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
    onProcessSignal: async (signal) => {
      clearHeartbeat();
      if (params.diagnosticPath) {
        await appendHeartbeatDiagnostic(params.diagnosticPath, {
          event: 'process-signal',
          signal,
          pid: process.pid,
          parentPid: process.ppid,
        });
      }
    },
    onMaxRuntime: (maxRuntimeMs) => {
      clearHeartbeat();
      // eslint-disable-next-line no-console
      console.error(`[tests] timed out after ${Math.ceil(maxRuntimeMs / 1000)}s: ${commandMetadata.tool}`);
    },
    onParentDeath: async () => {
      clearHeartbeat();
      process.exit(1);
    },
  });

  clearHeartbeat();

  if (result.ok && result.timedOut === true && wrapperTimeoutMs !== null) {
    await writeTimeoutArtifact(params, wrapperTimeoutMs, process.env);
  }

  // Ensure detached lease-owned processes (Metro, server-light, etc.) do not survive a failed run.
  // These are tracked under `.project/tmp/*-processes` and should be safe to reap once the
  // Playwright child has exited (owners are dead/stale by definition at this point).
  await sweepStaleProcessOwnershipLeases().catch(() => {});

  if (!result.ok) {
    if (params.diagnosticPath) {
      await appendHeartbeatDiagnostic(params.diagnosticPath, {
        event: 'spawn-error',
        message: result.error.message,
      });
    }
    // eslint-disable-next-line no-console
    console.error(`[tests] failed to start ${commandMetadata.tool}`);
    process.exit(1);
  }

  const exitCode = result.timedOut === true ? 124 : params.resolveExitCode(result);
  const finalMemory = params.diagnosticPath ? await readCgroupMemorySnapshot() : null;
  const oomKillDelta = resolveOomKillDelta(initialMemory, finalMemory);
  if (params.diagnosticPath) {
    await appendHeartbeatDiagnostic(params.diagnosticPath, {
      event: 'exit',
      code: exitCode,
      childCode: result.code,
      signal: result.signal,
      elapsedSeconds: elapsedSeconds(startedAt),
      cgroupMemory: finalMemory,
      oomKillDelta,
    });
  }
  if (oomKillDelta !== null && oomKillDelta > 0) {
    // eslint-disable-next-line no-console
    console.error(`[tests] cgroup reported ${oomKillDelta} OOM-killed process(es) during ${commandMetadata.tool}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[tests] completed in ${elapsedSeconds(startedAt)}s with code ${exitCode}`);
  process.exit(exitCode);
}
