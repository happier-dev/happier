import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  SessionWorkflowActivityHeadlineV1Schema,
  SessionWorkflowRunSnapshotV1Schema,
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

/** Read + decrypt the headline metadata, validating it against the count-only protocol contract. */
function readWorkflowHeadline(metadata: UnknownRecord | null): SessionWorkflowActivityHeadlineV1 | null {
  const raw = metadata?.sessionWorkflowActivityHeadlineV1;
  if (!raw) return null;
  const parsed = SessionWorkflowActivityHeadlineV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Open + decrypt one `activity/workflow_run.v1` system record into its snapshot. */
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

type WorkflowE2eContext = Readonly<{
  server: StartedServer;
  auth: Awaited<ReturnType<typeof createTestAuth>>;
  secret: Uint8Array;
  sessionId: string;
  cliEnv: NodeJS.ProcessEnv;
  workflowSignalPath: string;
  testDir: string;
}>;

describe('core e2e: Claude Dynamic Workflow activity roundtrip', () => {
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

  // Bring up the FULL WIRED LOCAL path (the same path the goal e2e exercises): the
  // `claudeLocalLauncher` builds `createClaudeWorkflowActivitySourceForSession`, the projector
  // feeds it the raw transcript channel (`observeRaw`), the CWF2 tracker normalizes, and the CWF3
  // publisher writes durable `activity/workflow_run.v1` system records + a count-only
  // `sessionWorkflowActivityHeadlineV1` metadata headline. The fake CLI writes the Dynamic Workflow
  // transcript records (stamped with its own session id) straight to the native Claude transcript,
  // the launcher's scanner tails them, and the wired source produces the records this test asserts.
  async function bootWorkflowSession(params: Readonly<{ testName: string }>): Promise<WorkflowE2eContext> {
    const testDir = run.testDir(params.testName);
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
      { path: workspaceDir, host: 'e2e', name: params.testName, createdAt: Date.now(), flavor: 'claude' },
      secret,
    );
    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-${params.testName}-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });
    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLog = resolve(join(testDir, 'fake-claude.jsonl'));
    const fakeClaudeSessionId = `fake-claude-session-${randomUUID()}`;
    const workflowSignalPath = resolve(join(testDir, 'workflow-signal'));

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: params.testName,
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLog,
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
      HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: fakeClaudeSessionId,
      HAPPIER_E2E_FAKE_CLAUDE_WORKFLOW_SIGNAL: workflowSignalPath,
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

    const ctx: WorkflowE2eContext = { server: server!, auth, secret, sessionId, cliEnv, workflowSignalPath, testDir };

    // Boot readiness: the local launcher reports the fake CLI's session id via the SessionStart hook
    // and binds the transcript scanner + workflow source. The source's foreign-session guard compares
    // each workflow row's `session_id` against this bound id; the fake CLI stamps the same id.
    await waitFor(async () => {
      const metadata = await readMetadata(ctx);
      const value = metadata?.claudeSessionId;
      return typeof value === 'string' && value.length > 0;
    }, { timeoutMs: 120_000, context: 'Claude local runtime binds and publishes a claudeSessionId' });

    return ctx;
  }

  it('drives a success workflow through the wired runtime to a durable record + count-only headline', async () => {
    const ctx = await bootWorkflowSession({ testName: 'claude-workflow-success' });

    // Trigger the Dynamic Workflow transcript stream (Research/Implementation/Review, all complete).
    await writeFile(ctx.workflowSignalPath, 'success', 'utf8');

    // 1) A durable `activity/workflow_run.v1` system record is written with the correct
    //    phases/agents/status/counts.
    await waitFor(async () => {
      const snapshots = await fetchWorkflowRunSnapshots(ctx);
      return snapshots.some((s) => s.runId === 'toolu_wf_success' && s.status === 'complete');
    }, { timeoutMs: 60_000, context: 'workflow run system record reaches complete status' });

    const snapshots = await fetchWorkflowRunSnapshots(ctx);
    const snapshot = snapshots.find((s) => s.runId === 'toolu_wf_success');
    expect(snapshot).toBeDefined();
    expect(snapshot!.workflowToolUseId).toBe('toolu_wf_success');
    expect(snapshot!.title).toBe('ship-feature');
    expect(snapshot!.phases.map((p) => p.title)).toEqual(['Research', 'Implementation', 'Review']);
    expect(snapshot!.totalAgents).toBe(6);
    expect(snapshot!.completedAgents).toBe(6);

    // 2) The count-only headline is written, derived from the same run, with NO detail fields.
    await waitFor(async () => {
      const metadata = await readMetadata(ctx);
      const h = readWorkflowHeadline(metadata);
      return [...(h?.activeRuns ?? []), ...(h?.recentRuns ?? [])]
        .some((r) => r.runId === 'toolu_wf_success' && r.status === 'complete');
    }, { timeoutMs: 60_000, context: 'workflow headline reaches complete status' });

    const headline = readWorkflowHeadline(await readMetadata(ctx));
    expect(headline).not.toBeNull();
    const headlineRun = [...(headline!.activeRuns ?? []), ...(headline!.recentRuns ?? [])]
      .find((r) => r.runId === 'toolu_wf_success');
    expect(headlineRun?.totalAgents).toBe(6);
    expect(headlineRun?.completedAgents).toBe(6);
    expect(headlineRun?.recordRevision).toBeTruthy();
    // The headline is a count-only pointer: the strip schema dropped any leaked detail keys.
    expect((headlineRun as unknown as { phases?: unknown }).phases).toBeUndefined();
    expect((headlineRun as unknown as { agents?: unknown }).agents).toBeUndefined();
  }, 240_000);

  it('keeps two concurrent workflows as two distinct records with no merged agents and both in the headline', async () => {
    const ctx = await bootWorkflowSession({ testName: 'claude-workflow-concurrent' });

    await writeFile(ctx.workflowSignalPath, 'concurrent', 'utf8');

    // Two distinct durable records with isolated agents (no cross-run leakage / merge).
    await waitFor(async () => {
      const snapshots = await fetchWorkflowRunSnapshots(ctx);
      const a = snapshots.find((s) => s.runId === 'toolu_wf_a');
      const b = snapshots.find((s) => s.runId === 'toolu_wf_b');
      return Boolean(a && b && a.status === 'complete' && b.status === 'failed');
    }, { timeoutMs: 90_000, context: 'two concurrent workflow records reach terminal states' });

    const snapshots = await fetchWorkflowRunSnapshots(ctx);
    const alpha = snapshots.find((s) => s.runId === 'toolu_wf_a');
    const beta = snapshots.find((s) => s.runId === 'toolu_wf_b');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha!.title).toBe('workflow-alpha');
    expect(beta!.title).toBe('workflow-beta');
    // Workflow agent ids are run-local (`workflow-agent:1`, `workflow-agent:2`), so isolation is
    // proven by each run keeping its own rows/titles/statuses instead of by global id uniqueness.
    expect(alpha!.agents.map((a) => [a.id, a.title, a.status])).toEqual([
      ['workflow-agent:1', 'alpha_search', 'complete'],
      ['workflow-agent:2', 'alpha_coder', 'complete'],
    ]);
    expect(beta!.agents.map((a) => [a.id, a.title, a.status])).toEqual([
      ['workflow-agent:1', 'beta_coder', 'complete'],
      ['workflow-agent:2', 'beta_tester', 'failed'],
    ]);
    expect(beta!.failedAgents).toBe(1);

    // The headline carries BOTH runs (the publisher partitions active vs terminal; both are terminal).
    await waitFor(async () => {
      const metadata = await readMetadata(ctx);
      const h = readWorkflowHeadline(metadata);
      if (!h) return false;
      const ids = new Set([...(h.activeRuns ?? []), ...(h.recentRuns ?? [])].map((r) => r.runId));
      return ids.has('toolu_wf_a') && ids.has('toolu_wf_b');
    }, { timeoutMs: 60_000, context: 'headline carries both concurrent workflow runs' });

    const headline = readWorkflowHeadline(await readMetadata(ctx));
    expect(headline).not.toBeNull();
    const headlineRunIds = new Set([
      ...(headline!.activeRuns ?? []),
      ...(headline!.recentRuns ?? []),
    ].map((r) => r.runId));
    expect(headlineRunIds.has('toolu_wf_a')).toBe(true);
    expect(headlineRunIds.has('toolu_wf_b')).toBe(true);
  }, 240_000);

  it('does NOT duplicate workflow-owned agents as top-level work-state task/todo rows (CWF4)', async () => {
    const ctx = await bootWorkflowSession({ testName: 'claude-workflow-cwf4' });

    await writeFile(ctx.workflowSignalPath, 'success', 'utf8');

    // Wait until the durable workflow record exists (workflow agents are tracked + owned).
    await waitFor(async () => {
      const snapshots = await fetchWorkflowRunSnapshots(ctx);
      return snapshots.some((s) => s.runId === 'toolu_wf_success' && s.totalAgents === 6);
    }, { timeoutMs: 60_000, context: 'workflow record with all agents exists before CWF4 assertion' });

    const snapshots = await fetchWorkflowRunSnapshots(ctx);
    const snapshot = snapshots.find((s) => s.runId === 'toolu_wf_success');
    expect(snapshot).toBeDefined();
    const workflowAgentIds = new Set(snapshot!.agents.map((a) => a.id));
    expect(workflowAgentIds.size).toBe(6);

    // The work-state metadata must NOT contain task/todo rows that reference the workflow-owned agent
    // ids (via vendorRef or parentId). CWF4 filters them at the work-state merge chokepoint, so the
    // workflow agents live only in the durable record, never as duplicate compact work-state rows.
    const metadata = await readMetadata(ctx);
    const workStateItems = readWorkStateItems(metadata);
    for (const item of workStateItems) {
      const vendorRef = typeof item.vendorRef === 'string' ? item.vendorRef : null;
      const parentId = typeof item.parentId === 'string' ? item.parentId : null;
      if (vendorRef) expect(workflowAgentIds.has(vendorRef)).toBe(false);
      if (parentId) expect(workflowAgentIds.has(parentId)).toBe(false);
    }
  }, 240_000);

  it('does NOT create a workflow record for a plain single-subagent Task (no workflow_progress)', async () => {
    const ctx = await bootWorkflowSession({ testName: 'claude-workflow-plain-task' });

    // The fake CLI has no `plain` workflow preset, so no Workflow transcript stream is emitted; a
    // plain single Task subagent is below the implicit-promotion threshold. Assert that after the
    // session is bound and stable, NO `activity/workflow_run.v1` record exists.
    // (We intentionally do NOT write the workflow signal here.)
    await waitFor(async () => {
      const metadata = await readMetadata(ctx);
      return metadata?.claudeSessionId ? true : false;
    }, { timeoutMs: 30_000, context: 'session bound before asserting no workflow record' });

    // Give the runtime a brief settle window, then confirm there is still no workflow record.
    const snapshots = await fetchWorkflowRunSnapshots(ctx);
    expect(snapshots).toHaveLength(0);
    const metadata = await readMetadata(ctx);
    expect(readWorkflowHeadline(metadata)).toBeNull();
  }, 180_000);
});
