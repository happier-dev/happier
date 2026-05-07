import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { yarnCommand } from '../../src/testkit/process/commands';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { fakeClaudeLogContainsUserText } from '../../src/testkit/sessionHandoffUiMessages';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';

const run = createRunDirs({ runLabel: 'core' });

type DecryptedMetadata = Readonly<{ claudeSessionId?: string }>;
type DecryptedAgentState = Readonly<{ controlledByUser?: boolean }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readMetadata(value: unknown): DecryptedMetadata | null {
  const record = asRecord(value);
  if (!record) return null;
  const claudeSessionId = typeof record.claudeSessionId === 'string' ? record.claudeSessionId : undefined;
  return { claudeSessionId };
}

function readAgentState(value: unknown): DecryptedAgentState | null {
  const record = asRecord(value);
  if (!record) return null;
  const controlledByUser = typeof record.controlledByUser === 'boolean' ? record.controlledByUser : undefined;
  return { controlledByUser };
}

function readTextContent(value: unknown): string | null {
  const content = asRecord(value);
  if (!content) return null;
  if (typeof content.text === 'string') return content.text;
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  return null;
}

function readClaudeAgentText(value: unknown): string | null {
  const record = asRecord(value);
  if (record?.role !== 'agent') return null;
  const content = asRecord(record.content);
  const data = asRecord(content?.data);
  const message = asRecord(data?.message);
  const messageContent = message?.content;
  if (!Array.isArray(messageContent)) return null;
  for (const part of messageContent) {
    const partRecord = asRecord(part);
    if (partRecord?.type === 'text' && typeof partRecord.text === 'string') return partRecord.text;
  }
  return null;
}

async function fakeClaudeLogHasEvent(logPath: string, eventType: string): Promise<boolean> {
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  if (!raw) return false;

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .some((line) => {
      try {
        const parsed = JSON.parse(line) as { type?: unknown };
        return parsed.type === eventType;
      } catch {
        return false;
      }
    });
}

describe('core e2e: Claude local→remote switch drains pending UI message', () => {
  it('waits for an active local Claude turn to complete before automatically draining a queued message remotely', async () => {
    const testName = 'claude-switch-local-to-remote-pending-active';
    const testDir = run.testDir(testName);
    const startedAt = new Date().toISOString();
    const cliHome = resolve(join(testDir, 'cli-home'));
    const claudeConfigDir = resolve(join(testDir, 'claude-config'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const startLocalTurnSignalPath = resolve(join(testDir, 'start-local-claude-turn'));
    const completeLocalTurnSignalPath = resolve(join(testDir, 'complete-local-claude-turn'));

    let server: Awaited<ReturnType<typeof startServerLight>> | null = null;
    let proc: SpawnedProcess | null = null;
    let ui: ReturnType<typeof createUserScopedSocketCollector> | null = null;

    try {
      server = await startServerLight({ testDir });
      const auth = await createTestAuth(server.baseUrl);

      await mkdir(cliHome, { recursive: true });
      await mkdir(claudeConfigDir, { recursive: true });
      await mkdir(workspaceDir, { recursive: true });

      const secret = Uint8Array.from(randomBytes(32));
      await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });

      const metadataCiphertextBase64 = encryptLegacyBase64(
        { path: workspaceDir, host: 'e2e', name: testName, createdAt: Date.now() },
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
        HAPPIER_E2E_FAKE_CLAUDE_LOCAL_ACTIVE_TURN: '1',
        HAPPIER_E2E_FAKE_CLAUDE_LOCAL_START_SIGNAL: startLocalTurnSignalPath,
        HAPPIER_E2E_FAKE_CLAUDE_LOCAL_COMPLETE_SIGNAL: completeLocalTurnSignalPath,
        HAPPIER_PENDING_QUEUE_IDLE_WAKE_POLL_INTERVAL_MS: '100',
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

      ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
      ui.connect();
      await waitFor(() => ui?.isConnected() === true, { timeoutMs: 20_000 });

      await waitForFakeClaudeInvocation(fakeLog, (i) => i.mode === 'local', { timeoutMs: 60_000 });

      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        const metadata = readMetadata(decryptLegacyBase64(snap.metadata, secret));
        const agentState = snap.agentState ? readAgentState(decryptLegacyBase64(snap.agentState, secret)) : null;
        return metadata?.claudeSessionId === fakeClaudeSessionId && agentState?.controlledByUser === true;
      }, { timeoutMs: 60_000, context: 'Claude local control publishes session metadata and local ownership' });

      const localTurnStartSeq = (await fetchSessionV2(server.baseUrl, auth.token, sessionId)).seq ?? 0;
      await writeFile(startLocalTurnSignalPath, 'start', 'utf8');

      await waitFor(async () => {
        if (await fakeClaudeLogHasEvent(fakeLog, 'local_turn_started')) return true;

        const rows = await fetchMessagesSince({
          baseUrl: server!.baseUrl,
          token: auth.token,
          sessionId,
          afterSeq: localTurnStartSeq,
        });

        return rows.some((row) => {
          const decrypted = decryptLegacyBase64(row.content.c, secret);
          const record = asRecord(decrypted);
          return record?.role === 'user' && readTextContent(record.content) === 'FAKE_CLAUDE_LOCAL_ACTIVE_TURN';
        });
      }, { timeoutMs: 60_000, context: 'Claude local transcript records the active local turn before queueing a remote handoff' });

      const baseline = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      const startAfterSeq = baseline.seq ?? 0;
      const marker = `CLAUDE_LOCAL_TO_REMOTE_${randomUUID()}`;
      const pendingLocalId = `msg-${randomUUID()}`;
      const userText = `CLAUDE_SWITCH_PENDING=${marker}`;
      const ciphertext = encryptLegacyBase64(
        {
          role: 'user',
          content: { type: 'text', text: userText },
          localId: pendingLocalId,
          meta: {
            source: 'ui',
            sentFrom: 'e2e',
            claudeRemoteAgentSdkEnabled: true,
          },
        },
        secret,
      );

      const enqueue = await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId: pendingLocalId,
        ciphertext,
        timeoutMs: 20_000,
      });
      expect(enqueue.status).toBe(200);

      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        const agentState = snap.agentState ? readAgentState(decryptLegacyBase64(snap.agentState, secret)) : null;
        if (agentState?.controlledByUser !== true) return false;

        const pending = await listPendingQueueV2({
          baseUrl: server!.baseUrl,
          token: auth.token,
          sessionId,
          timeoutMs: 20_000,
        });

        return (
          pending.status === 200 &&
          Array.isArray(pending.data?.pending) &&
          pending.data.pending.some((row) => row.localId === pendingLocalId && row.status === 'queued')
        );
      }, { timeoutMs: 20_000, context: 'Claude keeps local control while the pending row stays queued' });

      await writeFile(completeLocalTurnSignalPath, 'complete', 'utf8');

      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        const agentState = snap.agentState ? readAgentState(decryptLegacyBase64(snap.agentState, secret)) : null;
        return agentState?.controlledByUser === false;
      }, { timeoutMs: 60_000, context: 'Claude switches to remote after local end_turn' });

      await waitFor(async () => {
        const pending = await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, timeoutMs: 20_000 });
        return (
          pending.status === 200 &&
          Array.isArray(pending.data?.pending) &&
          pending.data.pending.every((row) => row.localId !== pendingLocalId || row.status !== 'queued')
        );
      }, { timeoutMs: 60_000, context: 'Claude remote drains pending queue row' });

      await waitForFakeClaudeInvocation(fakeLog, (i) => i.mode === 'sdk', { timeoutMs: 60_000 });
      await waitFor(async () => await fakeClaudeLogContainsUserText(fakeLog, userText), {
        timeoutMs: 60_000,
        context: 'Claude remote SDK receives queued pending text',
      });

      await waitFor(async () => {
        const rows = await fetchMessagesSince({
          baseUrl: server!.baseUrl,
          token: auth.token,
          sessionId,
          afterSeq: startAfterSeq,
        });
        let sawUser = false;
        let sawAssistant = false;
        for (const row of rows) {
          const decrypted = decryptLegacyBase64(row.content.c, secret);
          const record = asRecord(decrypted);
          if (row.localId === pendingLocalId && record?.role === 'user' && readTextContent(record.content) === userText) {
            sawUser = true;
          }
          if (readClaudeAgentText(decrypted)?.includes('FAKE_CLAUDE_OK_1') === true) {
            sawAssistant = true;
          }
        }
        return sawUser && sawAssistant;
      }, { timeoutMs: 90_000, context: 'Claude transcript includes queued user prompt and remote assistant response' });
    } finally {
      ui?.close();
      await proc?.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
      await server?.stop();
    }
  }, 240_000);
});
