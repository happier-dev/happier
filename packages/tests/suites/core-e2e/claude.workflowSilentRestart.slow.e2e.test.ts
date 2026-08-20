import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  SessionWorkflowActivityHeadlineV1Schema,
  SessionWorkflowRunSnapshotV1Schema,
  isTerminalWorkflowRunStatus,
  type SessionSystemRecord,
  type SessionWorkflowActivityHeadlineV1,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

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
import { fetchSessionSystemRecordsPage } from '../../src/testkit/sessionSystemRecords';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { repoRootDir } from '../../src/testkit/paths';

const run = createRunDirs({ runLabel: 'core' });

const ACTIVITY_NAMESPACE = 'activity';
const WORKFLOW_RUN_KIND = 'workflow_run.v1';
// The `progress` fixture preset (mid-run, no terminal) leaves this run active indefinitely.
const SILENT_ACTIVE_RUN_ID = 'toolu_wf_progress';
// This exceeds the removed 30-second startup-grace heuristic. The run must remain active because
// elapsed time and a runner restart are not workflow terminal evidence.
const SILENCE_ASSERTION_MS = 45_000;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function decryptMetadata(snap: SessionV2, secret: Uint8Array): UnknownRecord | null {
  if (typeof snap.metadata !== 'string' || snap.metadata.length === 0) return null;
  try {
    return asRecord(decryptLegacyBase64(snap.metadata, secret));
  } catch {
    return null;
  }
}

type ReadAccess = Readonly<{
  server: StartedServer;
  auth: Readonly<{ token: string }>;
  secret: Uint8Array;
  sessionId: string;
}>;

async function readMetadata(ctx: ReadAccess): Promise<UnknownRecord | null> {
  const snap = await fetchSessionV2(ctx.server.baseUrl, ctx.auth.token, ctx.sessionId);
  return decryptMetadata(snap, ctx.secret);
}

function readWorkflowHeadline(metadata: UnknownRecord | null): SessionWorkflowActivityHeadlineV1 | null {
  const raw = metadata?.sessionWorkflowActivityHeadlineV1;
  if (!raw) return null;
  const parsed = SessionWorkflowActivityHeadlineV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function findHeadlineRun(headline: SessionWorkflowActivityHeadlineV1 | null, runId: string) {
  if (!headline) return null;
  return [...(headline.activeRuns ?? []), ...(headline.recentRuns ?? [])].find((r) => r.runId === runId) ?? null;
}

function openWorkflowRunSnapshot(record: SessionSystemRecord, secret: Uint8Array): SessionWorkflowRunSnapshotV1 | null {
  const content = record.content;
  if (content.t !== 'encrypted') return null;
  const decrypted = decryptLegacyBase64(content.c, secret);
  const parsed = SessionWorkflowRunSnapshotV1Schema.safeParse(decrypted);
  return parsed.success ? parsed.data : null;
}

async function fetchWorkflowRunSnapshots(ctx: ReadAccess): Promise<SessionWorkflowRunSnapshotV1[]> {
  const page = await fetchSessionSystemRecordsPage({
    baseUrl: ctx.server.baseUrl,
    token: ctx.auth.token,
    sessionId: ctx.sessionId,
    namespace: ACTIVITY_NAMESPACE,
    kind: WORKFLOW_RUN_KIND,
    limit: 50,
  });
  return page.records
    .map((record) => openWorkflowRunSnapshot(record, ctx.secret))
    .filter((snapshot): snapshot is SessionWorkflowRunSnapshotV1 => snapshot !== null);
}

describe('core e2e: Claude workflow restart preserves silent active work', () => {
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

  // A runner crash does not prove that provider-owned workflow work finished. This e2e genuinely
  // SIGKILLs the first runtime after persisting an active workflow, restarts the same Happier session
  // with no new workflow evidence, waits beyond the former grace heuristic, and requires the durable
  // record and headline to remain active and mutually consistent.
  it('keeps a SIGKILL-surviving workflow active after restart and arbitrary silence', async () => {
    const testName = 'claude-workflow-silent-restart-preserves-active';
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

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLog = resolve(join(testDir, 'fake-claude.jsonl'));
    const ctx: ReadAccess = { server: server!, auth, secret, sessionId };

    const baseCliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLog,
    };

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName,
      sessionIds: [sessionId],
      env: { CI: process.env.CI, HAPPIER_CLAUDE_PATH: fakeClaudePath, HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLog },
    });

    await ensureCliDistBuilt({ testDir, env: baseCliEnv }, { skipSourceFreshnessCheck: true });

    // Each boot consumes a single-use session-attach file, so a restart needs a fresh one.
    const bootSession = async (params: Readonly<{
      fakeClaudeSessionId: string;
      workflowSignalPath?: string;
      label: string;
    }>): Promise<SpawnedProcess> => {
      const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });
      const env: NodeJS.ProcessEnv = {
        ...baseCliEnv,
        HAPPIER_SESSION_ATTACH_FILE: attachFile,
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: params.fakeClaudeSessionId,
        ...(params.workflowSignalPath
          ? { HAPPIER_E2E_FAKE_CLAUDE_WORKFLOW_SIGNAL: params.workflowSignalPath }
          : {}),
      };
      return spawnLoggedProcess({
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
        env,
        stdoutPath: resolve(join(testDir, `${params.label}.stdout.log`)),
        stderrPath: resolve(join(testDir, `${params.label}.stderr.log`)),
      });
    };

    // ── Phase 1: boot + drive an ACTIVE (never-terminal) workflow run ────────────────────────────────
    const firstFakeSessionId = `fake-claude-session-${randomUUID()}`;
    const workflowSignalPath = resolve(join(testDir, 'workflow-signal'));
    proc = await bootSession({ fakeClaudeSessionId: firstFakeSessionId, workflowSignalPath, label: 'cli-1' });

    await waitFor(async () => {
      const metadata = await readMetadata(ctx);
      const value = metadata?.claudeSessionId;
      return typeof value === 'string' && value.length > 0;
    }, { timeoutMs: 120_000, context: 'first Claude runtime binds and publishes a claudeSessionId' });

    await writeFile(workflowSignalPath, 'progress', 'utf8');

    // The durable record exists and is NON-terminal (active).
    await waitFor(async () => {
      const snapshots = await fetchWorkflowRunSnapshots(ctx);
      const snapshot = snapshots.find((s) => s.runId === SILENT_ACTIVE_RUN_ID);
      return Boolean(snapshot && !isTerminalWorkflowRunStatus(snapshot.status));
    }, { timeoutMs: 60_000, context: 'progress preset produces a NON-terminal durable workflow run record' });

    // The headline pins the same run as active (a reconcile candidate on restart).
    await waitFor(async () => {
      const run = findHeadlineRun(readWorkflowHeadline(await readMetadata(ctx)), SILENT_ACTIVE_RUN_ID);
      return Boolean(run && !isTerminalWorkflowRunStatus(run.status));
    }, { timeoutMs: 60_000, context: 'headline pins the active workflow run before the crash' });

    // ── Phase 2: SIGKILL the provider (crash — no graceful finally-flush), then a clean daemon stop ──
    await proc.stop('SIGKILL').catch(() => {});
    proc = null;
    await stopDaemonFromHomeDir(cliHome).catch(() => {});

    // ── Phase 3: restart the SAME session under a fresh transcript with no workflow signal ───────────
    const secondFakeSessionId = `fake-claude-session-${randomUUID()}`;
    proc = await bootSession({ fakeClaudeSessionId: secondFakeSessionId, label: 'cli-2' });

    await new Promise((resolveDelay) => setTimeout(resolveDelay, SILENCE_ASSERTION_MS));
    expect(proc.child.exitCode).toBeNull();

    const snapshots = await fetchWorkflowRunSnapshots(ctx);
    const record = snapshots.find((s) => s.runId === SILENT_ACTIVE_RUN_ID);
    const headlineRun = findHeadlineRun(readWorkflowHeadline(await readMetadata(ctx)), SILENT_ACTIVE_RUN_ID);
    expect(record && !isTerminalWorkflowRunStatus(record.status)).toBe(true);
    expect(record?.statusReason).toBeUndefined();
    expect(headlineRun && !isTerminalWorkflowRunStatus(headlineRun.status)).toBe(true);
    expect(headlineRun?.statusReason).toBeUndefined();
    expect(headlineRun?.runId).toBe(record?.runId);
  }, 480_000);
});
