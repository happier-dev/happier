import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { repoRootDir } from './paths';
import { sleep, waitFor } from './timing';

/**
 * Testkit for the deterministic fake OpenCode `serve` fixture
 * (`packages/tests/src/fixtures/fake-opencode-server-cli.cjs`).
 *
 * It exposes:
 *  - the canonical issue code + env-var names the fixture and the runtime recovery
 *    lane must agree on,
 *  - `buildFakeOpenCodeServerEnv` to point Happier's managed OpenCode server at the
 *    fake binary in server/managed mode,
 *  - `spawnFakeOpenCodeServer` to boot the fixture standalone (used by the runnable
 *    fixture self-checks; no daemon/server required),
 *  - readers/waiters over the fixture's durable JSON state + JSONL event log,
 *  - a resolver for Happier's per-managed-server durable log directory.
 *
 * It deliberately reuses the existing core-e2e testkit (real server + daemon, run
 * dirs, auth, prompt enqueue) for the daemon-driven scenarios rather than inventing
 * a second harness — see `opencode.managedServerRestart.slow.e2e.test.ts`.
 */

// ---------------------------------------------------------------------------
// Canonical contract shared with the runtime recovery lane (Plan Lane E / B2).
// The supervisor that fails an interrupted turn will define the production
// constant in `apps/cli/src/backends/opencode/server/runtime/createOpenCodeManagedServerTurnInterruptionSupervisor.ts`.
// It MUST equal this string.
// ---------------------------------------------------------------------------
export const OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE = 'opencode_server_restarted_during_turn' as const;

// Env vars consumed by the fixture. Keep these in sync with
// `packages/tests/src/fixtures/fake-opencode-server-cli.cjs`.
export const FAKE_OPENCODE_STATE_PATH_ENV = 'HAPPIER_E2E_FAKE_OPENCODE_STATE_PATH' as const;
export const FAKE_OPENCODE_LOG_ENV = 'HAPPIER_E2E_FAKE_OPENCODE_LOG' as const;
export const FAKE_OPENCODE_TEARDOWN_MODE_ENV = 'HAPPIER_E2E_FAKE_OPENCODE_TEARDOWN_MODE' as const;
export const FAKE_OPENCODE_EXIT_DELAY_MS_ENV = 'HAPPIER_E2E_FAKE_OPENCODE_EXIT_DELAY_MS' as const;
export const FAKE_OPENCODE_TOOL_NAME_ENV = 'HAPPIER_E2E_FAKE_OPENCODE_TOOL_NAME' as const;
export const FAKE_OPENCODE_SESSION_ID_ENV = 'HAPPIER_E2E_FAKE_OPENCODE_SESSION_ID' as const;

export type FakeOpenCodeTeardownMode = 'crash' | 'stay_alive';

export type FakeOpenCodeProcessRecord = Readonly<{
  pid: number;
  port: number;
  baseUrl: string;
  startedAtMs: number;
  generation: number;
}>;

export type FakeOpenCodeAbortRecord = Readonly<{
  sessionId: string;
  ts: number;
}>;

export type FakeOpenCodeMessage = Readonly<{
  info: Record<string, unknown>;
  parts: ReadonlyArray<Record<string, unknown>>;
}>;

export type FakeOpenCodeState = Readonly<{
  sessionId: string;
  directory: string;
  promptCount: number;
  toolRunning: boolean;
  messages: ReadonlyArray<FakeOpenCodeMessage>;
  generation: number;
  processes: ReadonlyArray<FakeOpenCodeProcessRecord>;
  aborts: ReadonlyArray<FakeOpenCodeAbortRecord>;
}>;

export type FakeOpenCodeLogEntry = Readonly<{
  ts: number;
  pid: number;
  port: number;
  type: string;
  [key: string]: unknown;
}>;

export type SpawnedFakeOpenCodeServer = Readonly<{
  baseUrl: string;
  hostname: string;
  port: number;
  pid: number;
  process: ChildProcess;
  stop: () => Promise<void>;
}>;

export function fakeOpenCodeServerFixturePath(): string {
  const path = resolve(repoRootDir(), 'packages/tests/src/fixtures/fake-opencode-server-cli.cjs');
  if (!existsSync(path)) {
    throw new Error(`Missing fake OpenCode server fixture at ${path}`);
  }
  return path;
}

export async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve loopback TCP port')));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

/**
 * Environment fragment that points Happier's managed OpenCode server at the fake
 * binary in server/managed mode. Merge into the daemon/CLI env.
 *
 * SSE reconnect timings are tightened so the crash-driven replacement is observed
 * quickly and deterministically.
 */
export function buildFakeOpenCodeServerEnv(params: Readonly<{
  statePath: string;
  logPath?: string;
  teardownMode?: FakeOpenCodeTeardownMode;
  exitDelayMs?: number;
  toolName?: string;
  sessionId?: string;
}>): Record<string, string> {
  const env: Record<string, string> = {
    HAPPIER_OPENCODE_PATH: fakeOpenCodeServerFixturePath(),
    HAPPIER_OPENCODE_BACKEND_MODE: 'server',
    [FAKE_OPENCODE_STATE_PATH_ENV]: params.statePath,
    [FAKE_OPENCODE_TEARDOWN_MODE_ENV]: params.teardownMode ?? 'crash',
    // Deterministic, snappy reconnect/health behavior for the e2e.
    HAPPIER_OPENCODE_SERVER_START_TIMEOUT_MS: '15000',
    HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS: '5000',
    HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS: '50',
    HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS: '500',
  };
  if (typeof params.logPath === 'string' && params.logPath.length > 0) {
    env[FAKE_OPENCODE_LOG_ENV] = params.logPath;
  }
  if (typeof params.exitDelayMs === 'number' && Number.isFinite(params.exitDelayMs)) {
    env[FAKE_OPENCODE_EXIT_DELAY_MS_ENV] = String(Math.max(0, Math.trunc(params.exitDelayMs)));
  }
  if (typeof params.toolName === 'string' && params.toolName.length > 0) {
    env[FAKE_OPENCODE_TOOL_NAME_ENV] = params.toolName;
  }
  if (typeof params.sessionId === 'string' && params.sessionId.length > 0) {
    env[FAKE_OPENCODE_SESSION_ID_ENV] = params.sessionId;
  }
  return env;
}

/**
 * Spawn the fixture directly (as Happier would: `<node> <fixture> serve --hostname --port`)
 * and wait until it is healthy. Used by the standalone fixture self-checks.
 */
export async function spawnFakeOpenCodeServer(params: Readonly<{
  statePath: string;
  logPath?: string;
  teardownMode?: FakeOpenCodeTeardownMode;
  exitDelayMs?: number;
  toolName?: string;
  sessionId?: string;
  hostname?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  healthTimeoutMs?: number;
}>): Promise<SpawnedFakeOpenCodeServer> {
  const hostname = params.hostname ?? '127.0.0.1';
  const port = params.port ?? (await reserveLoopbackPort());
  const baseUrl = `http://${hostname}:${port}`;
  const fixturePath = fakeOpenCodeServerFixturePath();

  const child = spawn(
    process.execPath,
    [fixturePath, 'serve', `--hostname=${hostname}`, `--port=${port}`],
    {
      env: {
        ...(params.env ?? process.env),
        ...buildFakeOpenCodeServerEnv({
          statePath: params.statePath,
          logPath: params.logPath,
          teardownMode: params.teardownMode,
          exitDelayMs: params.exitDelayMs,
          toolName: params.toolName,
          sessionId: params.sessionId,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Drain output so a chatty fixture can never block on a full pipe.
  child.stdout?.resume();
  child.stderr?.resume();

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => resolveStop(), 2_000);
        timer.unref?.();
        child.once('exit', () => {
          clearTimeout(timer);
          resolveStop();
        });
      });
    }
  };

  try {
    await waitFor(async () => {
      const res = await fetch(`${baseUrl}/global/health`).catch(() => null);
      return res?.ok === true;
    }, { timeoutMs: params.healthTimeoutMs ?? 15_000, intervalMs: 100, context: 'fake-opencode health' });
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    baseUrl,
    hostname,
    port,
    pid: child.pid ?? -1,
    process: child,
    stop,
  };
}

// ---------------------------------------------------------------------------
// Durable state + event-log readers
// ---------------------------------------------------------------------------

export async function readFakeOpenCodeState(statePath: string): Promise<FakeOpenCodeState | null> {
  const raw = await readFile(statePath, 'utf8').catch(() => '');
  if (!raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return {
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
      directory: typeof record.directory === 'string' ? record.directory : '',
      promptCount: typeof record.promptCount === 'number' ? record.promptCount : 0,
      toolRunning: record.toolRunning === true,
      messages: Array.isArray(record.messages) ? (record.messages as FakeOpenCodeMessage[]) : [],
      generation: typeof record.generation === 'number' ? record.generation : 0,
      processes: Array.isArray(record.processes) ? (record.processes as FakeOpenCodeProcessRecord[]) : [],
      aborts: Array.isArray(record.aborts) ? (record.aborts as FakeOpenCodeAbortRecord[]) : [],
    };
  } catch {
    return null;
  }
}

export async function readFakeOpenCodeEventLog(logPath: string): Promise<FakeOpenCodeLogEntry[]> {
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return [parsed as FakeOpenCodeLogEntry];
        }
      } catch {
        // ignore malformed line
      }
      return [];
    });
}

/**
 * Count prompt_async log entries, optionally filtered by prompt text.
 *
 * The `text` filter is a SUBSTRING match. Happier prepends provider guidance (title/options/
 * attachments/linked-files instructions) to the user's prompt, so the fixture logs the full
 * composed prompt rather than the bare user text. Passing a unique per-test marker therefore
 * reliably identifies "the user's prompt reached the fixture N times" regardless of the surrounding
 * system preamble — and still matches a bare-text prompt sent directly to the fixture in the
 * standalone self-checks (`marker.includes(marker)`). This is what makes the "no duplicate prompt to
 * the replacement" assertion meaningful: a replayed prompt would surface a second matching entry.
 */
export async function countFakeOpenCodePromptAsync(
  logPath: string,
  opts?: Readonly<{ text?: string }>,
): Promise<number> {
  const entries = await readFakeOpenCodeEventLog(logPath);
  return entries.filter((entry) => {
    if (entry.type !== 'prompt_async') return false;
    if (typeof opts?.text === 'string') {
      return typeof entry.text === 'string' && entry.text.includes(opts.text);
    }
    return true;
  }).length;
}

export async function readFakeOpenCodeServeStartCount(logPath: string): Promise<number> {
  const entries = await readFakeOpenCodeEventLog(logPath);
  return entries.filter((entry) => entry.type === 'serve_start').length;
}

// ---------------------------------------------------------------------------
// Waiters
// ---------------------------------------------------------------------------

export async function waitForFakeOpenCodeRunningTool(params: Readonly<{
  statePath: string;
  timeoutMs?: number;
}>): Promise<FakeOpenCodeState> {
  let last: FakeOpenCodeState | null = null;
  await waitFor(async () => {
    last = await readFakeOpenCodeState(params.statePath);
    return Boolean(last?.toolRunning && last.messages.length > 0);
  }, { timeoutMs: params.timeoutMs ?? 60_000, intervalMs: 100, context: 'fake-opencode running tool' });
  if (!last) throw new Error('fake-opencode running-tool state unexpectedly missing');
  return last;
}

/** Wait until the fixture has started at least `minGeneration` server processes. */
export async function waitForFakeOpenCodeGeneration(params: Readonly<{
  statePath: string;
  minGeneration: number;
  timeoutMs?: number;
}>): Promise<FakeOpenCodeState> {
  let last: FakeOpenCodeState | null = null;
  await waitFor(async () => {
    last = await readFakeOpenCodeState(params.statePath);
    return Boolean(last && last.generation >= params.minGeneration);
  }, {
    timeoutMs: params.timeoutMs ?? 60_000,
    intervalMs: 150,
    context: `fake-opencode generation >= ${params.minGeneration}`,
  });
  if (!last) throw new Error('fake-opencode generation state unexpectedly missing');
  return last;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPidExit(pid: number, opts?: Readonly<{ timeoutMs?: number }>): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

// ---------------------------------------------------------------------------
// Happier managed-server durable logs (Plan Lane A1 / Lane B owns creation).
// configuration.logsDir === <happyHomeDir>/logs.
// ---------------------------------------------------------------------------

export function resolveManagedServerLogsDir(happyHomeDir: string): string {
  return join(happyHomeDir, 'logs', 'opencode-managed-servers');
}

export async function listManagedServerLogFiles(happyHomeDir: string): Promise<string[]> {
  const dir = resolveManagedServerLogsDir(happyHomeDir);
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((entry) => entry.endsWith('.log'));
}
