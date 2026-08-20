import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2, type SessionV2 } from '../../src/testkit/sessions';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { yarnCommand } from '../../src/testkit/process/commands';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { repoRootDir } from '../../src/testkit/paths';

const run = createRunDirs({ runLabel: 'core' });

const CLAUDE_GOAL_ITEM_ID = 'goal:claude';

// The fake CLI's completed `goal_status` attachment carries the provider's AUTHORITATIVE totals
// (`appendGoalStatusAttachment` — met:true → `tokens: 42`, `durationMs: 1234`). Lane E's rule is that
// these REPLACE any CLI-accumulated live usage on completion; assert the exact mapped values.
const COMPLETION_TOKENS = 42;
const COMPLETION_TIME_USED_SECONDS = 1.234;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

type GoalItem = Readonly<{
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  title?: unknown;
  tokensUsed?: unknown;
  timeUsedSeconds?: unknown;
}>;

function decryptMetadata(snap: SessionV2, secret: Uint8Array): UnknownRecord | null {
  if (typeof snap.metadata !== 'string' || snap.metadata.length === 0) return null;
  try {
    return asRecord(decryptLegacyBase64(snap.metadata, secret));
  } catch {
    return null;
  }
}

function readWorkStateItems(metadata: UnknownRecord | null): UnknownRecord[] {
  const workState = asRecord(metadata?.sessionWorkStateV1);
  const items = workState?.items;
  return Array.isArray(items)
    ? items.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
      })
    : [];
}

function findClaudeGoalItem(metadata: UnknownRecord | null): GoalItem | null {
  return readWorkStateItems(metadata).find((item) => item.id === CLAUDE_GOAL_ITEM_ID) ?? null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function readMetadata(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
}>): Promise<UnknownRecord | null> {
  const snap = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
  return decryptMetadata(snap, params.secret);
}

describe('core e2e: Claude native goal live usage (G-3 / Lane E)', () => {
  let server: StartedServer | null = null;
  let proc: SpawnedProcess | null = null;
  let cliHomeForCleanup: string | null = null;

  afterEach(async () => {
    await proc?.stop().catch(() => {});
    proc = null;
    if (cliHomeForCleanup) {
      await stopDaemonFromHomeDir(cliHomeForCleanup).catch(() => {});
      cliHomeForCleanup = null;
    }
    await server?.stop().catch(() => {});
    server = null;
  });

  // Lane E (#7 / G-3): while a Claude goal is ACTIVE, the goal work-state source folds per-turn token
  // usage (from `assistant.message.usage`) + elapsed wall-time into the published goal item on each
  // turn boundary; on completion the provider's `goal_status` totals REPLACE the accumulated values.
  //
  // This e2e rides the SAME fully-wired LOCAL path as the goal roundtrip test. It composes two existing
  // fixture mechanisms (ZERO fixture change): the `goal-status-attachment` signals (active → complete)
  // AND the `localActiveTurn` mechanism, which appends a usage-bearing assistant `end_turn` transcript
  // record (`usage {input:1,output:1}` → 2 new tokens) that the goal source folds while the goal is
  // active. Sequence: active goal_status (creates the active item, starts the wall-time basis) → local
  // active turn (intermediate usage folds onto the active item) → completed goal_status (provider totals
  // replace the accumulated intermediate values).
  it('folds live usage onto an active Claude goal mid-run, then replaces it with provider totals on completion', async () => {
    const testName = 'claude-goal-live-usage';
    const testDir = run.testDir(testName);
    const startedAt = new Date().toISOString();

    const cliHome = resolve(join(testDir, 'cli-home'));
    cliHomeForCleanup = cliHome;
    const claudeConfigDir = resolve(join(testDir, 'claude-config'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(claudeConfigDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      { path: workspaceDir, host: 'e2e', name: testName, createdAt: Date.now(), flavor: 'claude' },
      secret,
    );
    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-${testName}-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });
    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLog = resolve(join(testDir, 'fake-claude.jsonl'));
    const fakeClaudeSessionId = `fake-claude-session-${randomUUID()}`;
    const goalActiveSignalPath = resolve(join(testDir, 'goal-active-signal'));
    const goalCompletedSignalPath = resolve(join(testDir, 'goal-completed-signal'));
    const localTurnStartSignalPath = resolve(join(testDir, 'local-turn-start-signal'));
    const localTurnCompleteSignalPath = resolve(join(testDir, 'local-turn-complete-signal'));
    const objective = `pursue claude live-usage goal ${randomUUID()}`;

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName,
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLog,
        HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'goal-status-attachment',
      },
    });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLog,
      HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'goal-status-attachment',
      HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: fakeClaudeSessionId,
      HAPPIER_E2E_FAKE_CLAUDE_GOAL_ACTIVE_SIGNAL: goalActiveSignalPath,
      HAPPIER_E2E_FAKE_CLAUDE_GOAL_COMPLETED_SIGNAL: goalCompletedSignalPath,
      // Existing `localActiveTurn` mechanism: a one-shot user turn (start signal) + a usage-bearing
      // assistant `end_turn` (complete signal). This is the transcript token-usage the goal source folds.
      HAPPIER_E2E_FAKE_CLAUDE_LOCAL_ACTIVE_TURN: '1',
      HAPPIER_E2E_FAKE_CLAUDE_LOCAL_START_SIGNAL: localTurnStartSignalPath,
      HAPPIER_E2E_FAKE_CLAUDE_LOCAL_COMPLETE_SIGNAL: localTurnCompleteSignalPath,
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv }, { skipSourceFreshnessCheck: true });

    proc = spawnLoggedProcess({
      command: yarnCommand(),
      args: [
        '-s',
        'workspace',
        '@happier-dev/cli',
        'dev',
        'claude',
        '--existing-session',
        sessionId,
        '--started-by',
        'terminal',
        '--happy-starting-mode',
        'local',
      ],
      cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    // Boot readiness: the local launcher binds the transcript scanner + goal source and publishes the
    // fake CLI's session id.
    await waitFor(async () => {
      const metadata = await readMetadata({ baseUrl: server!.baseUrl, token: auth.token, sessionId, secret });
      const value = metadata?.claudeSessionId;
      return typeof value === 'string' && value.length > 0;
    }, { timeoutMs: 120_000, context: 'Claude local runtime binds and publishes a claudeSessionId' });

    // 1) Emit the ACTIVE goal_status attachment → an active goal work-state item (wall-time basis starts).
    await writeFile(goalActiveSignalPath, objective, 'utf8');

    await waitFor(async () => {
      const metadata = await readMetadata({ baseUrl: server!.baseUrl, token: auth.token, sessionId, secret });
      const goal = findClaudeGoalItem(metadata);
      return goal?.kind === 'goal' && goal?.status === 'active' && goal?.title === objective;
    }, { timeoutMs: 60_000, context: 'goal_status active attachment derives an active goal work-state item' });

    // 2) Drive ONE local active turn (user + usage-bearing assistant end_turn). The goal source folds the
    //    turn's usage into the ACTIVE goal item on the turn boundary → intermediate live usage appears.
    await writeFile(localTurnStartSignalPath, 'start', 'utf8');
    await writeFile(localTurnCompleteSignalPath, 'complete', 'utf8');

    await waitFor(async () => {
      const metadata = await readMetadata({ baseUrl: server!.baseUrl, token: auth.token, sessionId, secret });
      const goal = findClaudeGoalItem(metadata);
      if (goal?.status !== 'active') return false;
      const tokensUsed = readNumber(goal?.tokensUsed);
      // Intermediate live usage is present WHILE ACTIVE, and is the CLI-accumulated turn total — NOT the
      // provider's completion total (proves accumulation, not premature completion mapping).
      return tokensUsed !== null && tokensUsed > 0 && tokensUsed < COMPLETION_TOKENS;
    }, { timeoutMs: 60_000, context: 'live turn usage folds onto the ACTIVE Claude goal item mid-run' });

    const activeMetadata = await readMetadata({ baseUrl: server!.baseUrl, token: auth.token, sessionId, secret });
    const activeGoal = findClaudeGoalItem(activeMetadata);
    expect(activeGoal?.status).toBe('active');
    // Elapsed wall-time is also folded live (goal set → this turn spans a real, >0 interval).
    expect(readNumber(activeGoal?.timeUsedSeconds)).not.toBeNull();
    expect(readNumber(activeGoal?.timeUsedSeconds)! >= 0).toBe(true);

    // 3) Emit the COMPLETED goal_status (met:true) → provider totals REPLACE the accumulated live usage.
    await writeFile(goalCompletedSignalPath, objective, 'utf8');

    await waitFor(async () => {
      const metadata = await readMetadata({ baseUrl: server!.baseUrl, token: auth.token, sessionId, secret });
      const goal = findClaudeGoalItem(metadata);
      return goal?.status === 'complete' && readNumber(goal?.tokensUsed) === COMPLETION_TOKENS;
    }, { timeoutMs: 60_000, context: 'met:true goal_status transitions to complete and provider totals replace accumulated usage' });

    const completedMetadata = await readMetadata({ baseUrl: server!.baseUrl, token: auth.token, sessionId, secret });
    const completedGoal = findClaudeGoalItem(completedMetadata);
    expect(completedGoal?.status).toBe('complete');
    // Provider authoritative totals WIN on completion (exact mapped values, NOT accumulated 2).
    expect(readNumber(completedGoal?.tokensUsed)).toBe(COMPLETION_TOKENS);
    expect(readNumber(completedGoal?.timeUsedSeconds)).toBe(COMPLETION_TIME_USED_SECONDS);
  }, 300_000);
});
