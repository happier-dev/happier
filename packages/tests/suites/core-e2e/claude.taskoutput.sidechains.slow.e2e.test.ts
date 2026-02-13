import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchAllMessages } from '../../src/testkit/sessions';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { postEncryptedUiTextMessage } from '../../src/testkit/uiMessages';
import { requestSessionSwitchRpc } from '../../src/testkit/sessionSwitchRpc';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { repoRootDir } from '../../src/testkit/paths';

const run = createRunDirs({ runLabel: 'core' });

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function extractOutputData(message: unknown): UnknownRecord | null {
  const record = asRecord(message);
  const content = record ? asRecord(record.content) : null;
  if (!content || content.type !== 'output') return null;
  return asRecord(content.data);
}

function collectToolUseIds(messages: unknown[], toolName: string): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    const data = extractOutputData(msg);
    if (!data || data.type !== 'assistant') continue;
    const message = asRecord(data.message);
    const blocks = message ? asArray(message.content) : null;
    if (!blocks) continue;

    for (const block of blocks) {
      const b = asRecord(block);
      if (!b) continue;
      if (b.type !== 'tool_use') continue;
      if (b.name !== toolName) continue;
      const id = b.id;
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  }
  return ids;
}

function collectToolResultBlocks(messages: unknown[], toolUseIds: Set<string>): UnknownRecord[] {
  const results: UnknownRecord[] = [];
  for (const msg of messages) {
    const data = extractOutputData(msg);
    if (!data || data.type !== 'user') continue;
    if (data.isSidechain === true) continue;
    const message = asRecord(data.message);
    const blocks = message ? asArray(message.content) : null;
    if (!blocks) continue;

    for (const block of blocks) {
      const b = asRecord(block);
      if (!b) continue;
      if (b.type !== 'tool_result') continue;
      const toolUseId = b.tool_use_id;
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) continue;
      if (!toolUseIds.has(toolUseId)) continue;
      results.push(b);
    }
  }
  return results;
}

describe('core e2e: Claude TaskOutput sidechains are imported with sidechainId + meta', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('imports TaskOutput JSONL messages into the Task sidechain and tags them as imported', async () => {
    const testDir = run.testDir('claude-taskoutput-sidechains');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      { path: workspaceDir, host: 'e2e', name: 'claude-taskoutput-sidechains', createdAt: Date.now() },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-claude-taskoutput-sidechains-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });
    const fakeClaudePath = fakeClaudeFixturePath();

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'claude-taskoutput-sidechains',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'taskoutput-sidechain',
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
      HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'taskoutput-sidechain',
      HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${randomUUID()}`,
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv });

    const proc: SpawnedProcess = spawnLoggedProcess({
      command: yarnCommand(),
      args: ['-s', 'workspace', '@happier-dev/cli', 'dev', 'claude', '--existing-session', sessionId, '--started-by', 'terminal'],
      cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

      await requestSessionSwitchRpc({ ui, sessionId, to: 'remote', secret, timeoutMs: 20_000 });

      await postEncryptedUiTextMessage({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        secret,
        text: 'E2E_TASKOUTPUT_SIDECHAIN_IMPORT',
        metaExtras: { claudeRemoteAgentSdkEnabled: true },
      });

      await waitFor(
        async () => {
          const rows = await fetchAllMessages(server!.baseUrl, auth.token, sessionId);
          const plaintext = rows.flatMap((row) => {
            try {
              return [decryptLegacyBase64(row.content.c, secret)];
            } catch {
              return [];
            }
          });

          const taskToolUseIds = collectToolUseIds(plaintext, 'Task');
          if (taskToolUseIds.size === 0) return false;

          const hasImportedSidechain = plaintext.some((msg) => {
            const record = asRecord(msg);
            const meta = record ? asRecord(record.meta) : null;
            if (meta?.importedFrom !== 'claude-taskoutput') return false;
            const data = extractOutputData(msg);
            if (!data || data.isSidechain !== true) return false;
            const sidechainId = data.sidechainId;
            if (typeof sidechainId !== 'string' || sidechainId.length === 0) return false;
            return taskToolUseIds.has(sidechainId);
          });

          return hasImportedSidechain;
        },
        { timeoutMs: 15_000, intervalMs: 250 },
      );

      const rows = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      const plaintext = rows.flatMap((row) => {
        try {
          return [decryptLegacyBase64(row.content.c, secret)];
        } catch {
          return [];
        }
      });

      const taskOutputToolUseIds = collectToolUseIds(plaintext, 'TaskOutput');
      expect(taskOutputToolUseIds.size).toBeGreaterThan(0);

      const taskOutputToolResults = collectToolResultBlocks(plaintext, taskOutputToolUseIds);
      expect(taskOutputToolResults.length).toBeGreaterThan(0);

      const hasCompactTaskOutputToolResult = taskOutputToolResults.some((b) => {
        const content = b.content;
        if (typeof content !== 'string') return false;
        return content.trim().length === 0;
      });
      expect(hasCompactTaskOutputToolResult).toBe(true);

      const hasRawPayloadInMainThread = plaintext.some((msg) => {
        const data = extractOutputData(msg);
        if (!data || data.isSidechain === true) return false;
        return JSON.stringify(data).includes('FAKE_TASKOUTPUT_SIDECHAIN_OK_');
      });
      expect(hasRawPayloadInMainThread).toBe(false);
    } finally {
      ui.close();
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 180_000);
});
