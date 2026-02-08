import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { fakeClaudeFixturePath, type FakeClaudeInvocation, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { postEncryptedUiTextMessage } from '../../src/testkit/uiMessages';
import { requestSessionSwitchRpc } from '../../src/testkit/sessionSwitchRpc';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: Claude local↔remote switching carries MCP config', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('merges user --mcp-config with Happy MCP server and keeps it across local→remote switch', async () => {
    const testDir = run.testDir('claude-switch-mcp-config');
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
      { path: workspaceDir, host: 'e2e', name: 'claude-switch', createdAt: Date.now() },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-claude-switch-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    const fakeClaudePath = fakeClaudeFixturePath();

    const fakeLog = resolve(join(testDir, 'fake-claude.jsonl'));
    const customMcpConfig = JSON.stringify({
      mcpServers: {
        custom: { type: 'http', url: 'http://127.0.0.1:9999' },
      },
    });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'claude-switch-mcp-config',
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
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLog,
      HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${randomUUID()}`,
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv });

    const proc: SpawnedProcess = spawnLoggedProcess({
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
        '--mcp-config',
        customMcpConfig,
      ],
      cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

      // Note: the CLI may spawn Claude in "local" mode for SDK metadata extraction (no --settings).
      // We only want the actual session run, which always passes Happy's internal hook `--settings`.
      const localInvocation: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
        fakeLog,
        (i) => i.mode === 'local' && i.argv.includes('--settings'),
      );
      expect(Object.keys(localInvocation.mergedMcpServers ?? {}).sort()).toEqual(['custom', 'happy']);
      expect(localInvocation.mcpConfigs?.length ?? 0).toBe(1);

      // Legacy remote runner should keep the merged MCP config.
      await requestSessionSwitchRpc({ ui, sessionId, to: 'remote', secret, timeoutMs: 20_000 });

      await postEncryptedUiTextMessage({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        secret,
        text: 'FAKE_SWITCH_REMOTE_LEGACY_PROMPT',
      });

      const legacyRemoteInvocation: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
        fakeLog,
        (i) => i.mode === 'sdk' && i.argv.includes('--settings'),
      );
      expect(Object.keys(legacyRemoteInvocation.mergedMcpServers ?? {}).sort()).toEqual(['custom', 'happy']);
      expect(legacyRemoteInvocation.mcpConfigs?.length ?? 0).toBe(1);

      // Switch back to local, then re-enter remote with Agent SDK enabled.
      await requestSessionSwitchRpc({ ui, sessionId, to: 'local', secret, timeoutMs: 25_000 });
      await requestSessionSwitchRpc({ ui, sessionId, to: 'remote', secret, timeoutMs: 20_000 });

      await postEncryptedUiTextMessage({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        secret,
        text: 'FAKE_SWITCH_REMOTE_AGENT_SDK_PROMPT',
        metaExtras: {
          claudeRemoteAgentSdkEnabled: true,
        },
      });

      const agentSdkRemoteInvocation: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
        fakeLog,
        (i) => i.mode === 'sdk' && !i.argv.includes('--settings'),
      );
      expect(Object.keys(agentSdkRemoteInvocation.mergedMcpServers ?? {}).sort()).toEqual(['custom', 'happy']);
      expect(agentSdkRemoteInvocation.mcpConfigs?.length ?? 0).toBe(1);

      const snap = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      expect(typeof snap.metadata).toBe('string');
    } finally {
      ui.close();
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 180_000);
});
