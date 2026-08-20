import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { startTestDaemon, stopDaemonFromHomeDir, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { waitFor } from '../../src/testkit/timing';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import {
  enqueueSessionPromptForScenario,
  waitForAssistantMessageContaining,
} from '../../src/testkit/providers/scenarios/sessionRuntime';
import {
  OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE,
  buildFakeOpenCodeServerEnv,
  countFakeOpenCodePromptAsync,
  isPidAlive,
  listManagedServerLogFiles,
  readFakeOpenCodeState,
  spawnFakeOpenCodeServer,
  waitForFakeOpenCodeGeneration,
  waitForFakeOpenCodeRunningTool,
  waitForPidExit,
  type SpawnedFakeOpenCodeServer,
} from '../../src/testkit/fakeOpenCodeServer';

const run = createRunDirs({ runLabel: 'core' });

/**
 * Lane A3 — deterministic fake-OpenCode managed-server restart e2e.
 *
 * The fixture (`fake-opencode-server-cli.cjs`) reproduces the incident shape: an
 * in-flight OpenCode tool stays `running` while the managed `opencode serve` process
 * is replaced (crash) or torn down (Happier-initiated). Durable state is shared across
 * the original and replacement processes via a JSON state file.
 *
 * STATUS:
 *  - The two fixture self-checks below are RUNNABLE today (no daemon/runtime needed)
 *    and prove the fixture boots and serves health/SSE/session/prompt + crash +
 *    replacement-continuity deterministically.
 *  - The two daemon-driven scenarios are `it.skip` PENDING runtime behavior owned by
 *    other lanes (Plan Lane E/B2 = generation-aware turn-failure; Lane A1/B = durable
 *    managed-server logs; Lane C1/F = Happier-initiated mid-turn teardown). They are
 *    fully wired so they typecheck and run once those lanes land — just remove `.skip`.
 */

async function readSseFrames(baseUrl: string, durationMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), durationMs);
  timer.unref?.();
  try {
    const res = await fetch(`${baseUrl}/global/event`, { signal: ctrl.signal });
    if (!res.body) return '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) text += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted after durationMs — return whatever we read
    }
    return text;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `\n${body}` : ''}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

describe('core e2e: OpenCode managed-server restart during an in-flight turn (fake fixture)', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let daemonHomeDir: string | null = null;
  const spawnedFakes: SpawnedFakeOpenCodeServer[] = [];
  const trackedStatePaths: string[] = [];

  afterEach(async () => {
    for (const fake of spawnedFakes.splice(0)) {
      await fake.stop().catch(() => {});
    }
    // Best-effort: kill any managed fake processes recorded in the durable state files
    // (covers detached servers spawned by the daemon-driven scenarios).
    for (const statePath of trackedStatePaths.splice(0)) {
      const state = await readFakeOpenCodeState(statePath).catch(() => null);
      for (const proc of state?.processes ?? []) {
        if (isPidAlive(proc.pid)) {
          try {
            process.kill(proc.pid, 'SIGKILL');
          } catch {
            // ignore
          }
        }
      }
    }
    if (daemonHomeDir) {
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
      daemonHomeDir = null;
    }
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  afterAll(async () => {
    if (daemonHomeDir) {
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
    }
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it('fixture self-check: boots and serves health, SSE, session create and the running-tool prompt lifecycle', async () => {
    const testDir = run.testDir(`opencode-fake-selfcheck-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    const statePath = resolve(join(testDir, 'fake-opencode-state.json'));
    const logPath = resolve(join(testDir, 'fake-opencode.jsonl'));
    trackedStatePaths.push(statePath);

    // stay_alive so we can probe the same process after it emits the running tool.
    const fake = await spawnFakeOpenCodeServer({ statePath, logPath, teardownMode: 'stay_alive' });
    spawnedFakes.push(fake);

    // Health.
    const health = await fetchJson<{ healthy: boolean }>(`${fake.baseUrl}/global/health`);
    expect(health.healthy).toBe(true);

    // SSE emits the initial server.connected frame.
    const sse = await readSseFrames(fake.baseUrl, 700);
    expect(sse).toContain('"type":"server.connected"');

    // Session create + the empty control-plane surfaces the runtime polls.
    const dirQuery = encodeURIComponent(testDir);
    const session = await fetchJson<{ id: string }>(
      `${fake.baseUrl}/session?directory=${dirQuery}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(typeof session.id).toBe('string');
    expect(session.id.length).toBeGreaterThan(0);

    expect(await fetchJson<unknown[]>(`${fake.baseUrl}/permission?directory=${dirQuery}`)).toEqual([]);
    expect(await fetchJson<unknown[]>(`${fake.baseUrl}/question?directory=${dirQuery}`)).toEqual([]);

    // First prompt → user message + assistant message with a `running` tool part.
    const promptText = `SELFCHECK_PROMPT_${randomUUID()}`;
    await fetchJson<unknown>(
      `${fake.baseUrl}/session/${encodeURIComponent(session.id)}/prompt_async?directory=${dirQuery}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: promptText }] }),
      },
    );

    const state = await waitForFakeOpenCodeRunningTool({ statePath, timeoutMs: 5_000 });
    expect(state.toolRunning).toBe(true);
    expect(state.messages.length).toBe(2);

    const messages = await fetchJson<Array<{ info: { role?: string }; parts: Array<Record<string, unknown>> }>>(
      `${fake.baseUrl}/session/${encodeURIComponent(session.id)}/message?directory=${dirQuery}`,
    );
    expect(messages.length).toBe(2);
    expect(messages[0]?.info.role).toBe('user');
    const toolPart = messages[1]?.parts.find((p) => p.type === 'tool');
    expect(toolPart).toBeDefined();
    expect((toolPart?.state as { status?: string } | undefined)?.status).toBe('running');

    // Status reports busy while the tool runs.
    const status = await fetchJson<Record<string, { type?: string }>>(`${fake.baseUrl}/session/status?directory=${dirQuery}`);
    expect(status[session.id]?.type).toBe('busy');

    // Exactly one prompt reached the fixture.
    expect(await countFakeOpenCodePromptAsync(logPath, { text: promptText })).toBe(1);
  }, 60_000);

  it('fixture self-check: crash mode orphans the running tool and a replacement process re-serves the same history', async () => {
    const testDir = run.testDir(`opencode-fake-crash-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    const statePath = resolve(join(testDir, 'fake-opencode-state.json'));
    const logPath = resolve(join(testDir, 'fake-opencode.jsonl'));
    trackedStatePaths.push(statePath);

    // Process 1: crash shortly after emitting the running tool.
    const proc1 = await spawnFakeOpenCodeServer({ statePath, logPath, teardownMode: 'crash', exitDelayMs: 150 });
    const proc1Pid = proc1.pid;
    const dirQuery = encodeURIComponent(testDir);
    const session = await fetchJson<{ id: string }>(
      `${proc1.baseUrl}/session?directory=${dirQuery}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );

    const promptText = `CRASH_PROMPT_${randomUUID()}`;
    await fetchJson<unknown>(
      `${proc1.baseUrl}/session/${encodeURIComponent(session.id)}/prompt_async?directory=${dirQuery}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: promptText }] }),
      },
    );

    // Process 1 exits after orphaning the running tool.
    expect(await waitForPidExit(proc1Pid, { timeoutMs: 5_000 })).toBe(true);
    const orphanState = await readFakeOpenCodeState(statePath);
    expect(orphanState?.toolRunning).toBe(true);
    expect(orphanState?.generation).toBe(1);

    // Process 2 (replacement) reads the SAME state file and re-serves the running tool.
    const proc2 = await spawnFakeOpenCodeServer({ statePath, logPath, teardownMode: 'crash' });
    spawnedFakes.push(proc2);

    const replacementState = await waitForFakeOpenCodeGeneration({ statePath, minGeneration: 2, timeoutMs: 5_000 });
    expect(replacementState.generation).toBe(2);

    const messages = await fetchJson<Array<{ info: { sessionID?: string }; parts: Array<Record<string, unknown>> }>>(
      `${proc2.baseUrl}/session/${encodeURIComponent(session.id)}/message?directory=${dirQuery}`,
    );
    const toolPart = messages[1]?.parts.find((p) => p.type === 'tool');
    expect((toolPart?.state as { status?: string } | undefined)?.status).toBe('running');

    // The replacement re-surfaces the orphaned running tool over SSE.
    const sse = await readSseFrames(proc2.baseUrl, 700);
    expect(sse).toContain('"type":"message.part.updated"');

    // The original prompt was sent exactly once across both processes (no duplicate replay by the fixture).
    expect(await countFakeOpenCodePromptAsync(logPath, { text: promptText })).toBe(1);
    // The recovery policy must not abort; the fixture never received an abort here.
    expect(replacementState.aborts.length).toBe(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Daemon-driven scenarios. SKIPPED pending runtime behavior in other lanes.
  // -------------------------------------------------------------------------

  it('external crash mid-turn → terminal opencode_server_restarted_during_turn, no wedge, no duplicate prompt, managed-server logs present', async () => {
    // Lane B2 lands the generation-aware turn-failure policy; Lane A1/B lands durable
    // managed-server logs. Process 1 emits a running tool then crashes; Happier ensures a
    // replacement (generation 2); the supervisor fails the turn exactly once.
    const testDir = run.testDir(`opencode-managed-restart-crash-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, token: auth.token, secret });

    const statePath = resolve(join(testDir, 'fake-opencode-state.json'));
    const fakeLogPath = resolve(join(testDir, 'fake-opencode.jsonl'));
    trackedStatePaths.push(statePath);

    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      ...buildFakeOpenCodeServerEnv({ statePath, logPath: fakeLogPath, teardownMode: 'crash', exitDelayMs: 150 }),
    };

    daemon = await startTestDaemon({ testDir, happyHomeDir: daemonHomeDir, env: daemonEnv });

    const spawnRes = await daemonControlPostJson({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken: daemon.state.controlToken,
      body: {
        directory: workspaceDir,
        terminal: { mode: 'plain' },
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        environmentVariables: daemonEnv,
      },
    });
    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    const promptText = `MANAGED_RESTART_CRASH_${randomUUID()}`;
    await enqueueSessionPromptForScenario({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: promptText,
    });

    // Process 1 emits the running tool then crashes; Happier ensures a replacement (generation 2).
    await waitForFakeOpenCodeRunningTool({ statePath, timeoutMs: 60_000 });
    await waitForFakeOpenCodeGeneration({ statePath, minGeneration: 2, timeoutMs: 60_000 });

    // RUNTIME-DEPENDENT (Lane B2): the turn is failed terminally with the canonical issue code.
    await waitForAssistantMessageContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE,
      timeoutMs: 120_000,
    });

    // RUNTIME-DEPENDENT (Lane B2): the turn is NOT left stuck running — it settles to a terminal
    // `failed` durable status carrying the canonical server-restart issue. (`active` is presence/
    // online state with a multi-minute timeout, NOT turn state — a settled session legitimately
    // stays online for the next prompt, so it is the wrong "not stuck" signal. The canonical
    // not-stuck contract is the durable turn status + runtime issue, mirroring the usage-limit/
    // quota-switch recovery e2e suites.)
    await waitFor(async () => {
      const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId).catch(() => null);
      return snap?.latestTurnStatus === 'failed'
        && snap.lastRuntimeIssue?.code === OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE;
    }, { timeoutMs: 60_000, context: 'turn settles failed with the server-restart issue (no wedge)' });

    // No duplicate prompt was sent to the replacement process; no abort issued.
    expect(await countFakeOpenCodePromptAsync(fakeLogPath, { text: promptText })).toBe(1);
    const finalState = await readFakeOpenCodeState(statePath);
    expect(finalState?.aborts.length).toBe(0);

    // RUNTIME-DEPENDENT (Lane A1/B): durable managed-server logs exist.
    const logFiles = await listManagedServerLogFiles(daemonHomeDir);
    expect(logFiles.length).toBeGreaterThan(0);
  }, 240_000);

  it('Happier-initiated mid-turn teardown (stay_alive) → terminal opencode_server_restarted_during_turn, no wedge', async () => {
    // The fake server stays ALIVE (teardownMode: 'stay_alive') with the tool still running, so the
    // replacement must be driven externally — the fixture is explicitly designed for "the test/runtime
    // lane triggers the replacement". We tear down the live managed `serve` process mid-turn, standing
    // in for a Happier-initiated forced teardown (a launch-fingerprint change / `releaseForAuthSwitch`
    // with deferral disabled). Happier's HTTP-retry path ensures a replacement on a new port
    // (generation 2) and B2's supervisor surfaces the same canonical terminal as the crash path.
    //
    // Cross-lane note: the connected-service auth-switch FSM that genuinely ORIGINATES such a teardown,
    // and the C1 in-flight-turn guard that normally BLOCKS a sole-claimant mid-turn kill, are exercised
    // against the connected-services-aware fake provider in
    // `apps/cli/src/backends/opencode/server/opencode.authSwitch.fakeProvider.e2e.test.ts`
    // (asserting `detachedReason: 'in_flight_turn'` then release-at-quiescence). The fake OpenCode
    // server here is connected-services-agnostic, so this scenario asserts the recovery-terminal side
    // (the B2 supervisor generation-change failure), per the C1 handoff ("assert via the runtime
    // supervisor path").
    const testDir = run.testDir(`opencode-managed-restart-initiated-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, token: auth.token, secret });

    const statePath = resolve(join(testDir, 'fake-opencode-state.json'));
    const fakeLogPath = resolve(join(testDir, 'fake-opencode.jsonl'));
    trackedStatePaths.push(statePath);

    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      ...buildFakeOpenCodeServerEnv({ statePath, logPath: fakeLogPath, teardownMode: 'stay_alive' }),
    };

    daemon = await startTestDaemon({ testDir, happyHomeDir: daemonHomeDir, env: daemonEnv });

    const spawnRes = await daemonControlPostJson({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken: daemon.state.controlToken,
      body: {
        directory: workspaceDir,
        terminal: { mode: 'plain' },
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        environmentVariables: daemonEnv,
      },
    });
    expect(spawnRes.status).toBe(200);
    const sessionId = spawnRes.data.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    const promptText = `MANAGED_RESTART_INITIATED_${randomUUID()}`;
    await enqueueSessionPromptForScenario({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: promptText,
    });

    const running = await waitForFakeOpenCodeRunningTool({ statePath, timeoutMs: 60_000 });

    // Drive the Happier-initiated mid-turn teardown: kill the live (non-self-exiting) managed server.
    // Happier observes the dead server on its next request and ensures a replacement (generation 2).
    const liveProcess = [...running.processes].reverse().find((proc) => isPidAlive(proc.pid));
    if (!liveProcess) {
      throw new Error('No live fake-opencode process to tear down for the stay_alive scenario');
    }
    process.kill(liveProcess.pid, 'SIGKILL');
    expect(await waitForPidExit(liveProcess.pid, { timeoutMs: 10_000 })).toBe(true);

    await waitForFakeOpenCodeGeneration({ statePath, minGeneration: 2, timeoutMs: 60_000 });

    // RUNTIME-DEPENDENT (Lane B2): the interrupted turn fails terminally with the canonical issue code.
    await waitForAssistantMessageContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE,
      timeoutMs: 120_000,
    });

    // RUNTIME-DEPENDENT (Lane B2): the turn is not stuck running — it settles terminal `failed` with
    // the server-restart issue (presence `active` is online-state, not turn-state; see the crash test).
    await waitFor(async () => {
      const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId).catch(() => null);
      return snap?.latestTurnStatus === 'failed'
        && snap.lastRuntimeIssue?.code === OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE;
    }, { timeoutMs: 60_000, context: 'turn settles failed with the server-restart issue (no wedge)' });

    // No duplicate prompt to the replacement, no abort, and durable managed-server logs exist.
    expect(await countFakeOpenCodePromptAsync(fakeLogPath, { text: promptText })).toBe(1);
    const finalState = await readFakeOpenCodeState(statePath);
    expect(finalState?.aborts.length).toBe(0);
    const logFiles = await listManagedServerLogFiles(daemonHomeDir);
    expect(logFiles.length).toBeGreaterThan(0);
  }, 240_000);
});
