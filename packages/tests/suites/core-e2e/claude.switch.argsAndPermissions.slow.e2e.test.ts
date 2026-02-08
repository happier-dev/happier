import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts } from '../../src/testkit/sessions';
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

describe('core e2e: Claude switching preserves args + permissions', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('carries selected Claude CLI flags (max-turns + strict-mcp-config) across local→remote', async () => {
    const testDir = run.testDir('claude-switch-args-preserved');
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
      { path: workspaceDir, host: 'e2e', name: 'claude-switch-args', createdAt: Date.now() },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-claude-switch-args-${randomUUID()}`,
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
      testName: 'claude-switch-args-preserved',
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
        '--max-turns',
        '3',
        '--strict-mcp-config',
        '--append-system-prompt',
        'E2E_APPEND_PROMPT',
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

      const localInvocation: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
        fakeLog,
        (i) => i.argv.includes('--settings') && !i.argv.includes('--input-format'),
      );
      expect(Object.keys(localInvocation.mergedMcpServers ?? {}).sort()).toEqual(['custom', 'happy']);
      expect(localInvocation.argv).toContain('--max-turns');
      expect(localInvocation.argv).toContain('3');
      expect(localInvocation.argv).toContain('--strict-mcp-config');
      expect(localInvocation.argv).toContain('--append-system-prompt');
      expect(localInvocation.argv).toContain('E2E_APPEND_PROMPT');

      // Switch to remote with the legacy runner (Agent SDK disabled) and verify flags survive.
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
        (i) => i.argv.includes('--settings') && i.argv.includes('--input-format'),
      );
      expect(Object.keys(legacyRemoteInvocation.mergedMcpServers ?? {}).sort()).toEqual(['custom', 'happy']);
      expect(legacyRemoteInvocation.argv).toContain('--max-turns');
      expect(legacyRemoteInvocation.argv).toContain('3');
      expect(legacyRemoteInvocation.argv).toContain('--strict-mcp-config');

      // Switch back to local, then switch to remote with the Agent SDK runner enabled.
      await requestSessionSwitchRpc({ ui, sessionId, to: 'local', secret, timeoutMs: 25_000 });

      const localInvocation2: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
        fakeLog,
        (i) =>
          i.argv.includes('--settings') &&
          !i.argv.includes('--input-format') &&
          i.invocationId !== localInvocation.invocationId,
        { timeoutMs: 120_000 },
      );
      expect(Object.keys(localInvocation2.mergedMcpServers ?? {}).sort()).toEqual(['custom', 'happy']);

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
        (i) => i.argv.includes('--input-format') && !i.argv.includes('--settings'),
        { timeoutMs: 120_000 },
      );
      expect(Object.keys(agentSdkRemoteInvocation.mergedMcpServers ?? {}).sort()).toEqual(['custom', 'happy']);
      expect(agentSdkRemoteInvocation.argv).toContain('--max-turns');
      expect(agentSdkRemoteInvocation.argv).toContain('3');
      expect(agentSdkRemoteInvocation.argv).toContain('--strict-mcp-config');
      expect(agentSdkRemoteInvocation.argv).not.toContain('--append-system-prompt');
    } finally {
      ui.close();
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);

  it('preserves bypassPermissions across local→remote→local switching', async () => {
    const testDir = run.testDir('claude-switch-permissions-preserved');
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
      { path: workspaceDir, host: 'e2e', name: 'claude-switch-perms', createdAt: Date.now() },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-claude-switch-perms-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    const fakeClaudePath = fakeClaudeFixturePath();

    const fakeLog = resolve(join(testDir, 'fake-claude.jsonl'));

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'claude-switch-permissions-preserved',
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
        '--dangerously-skip-permissions',
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

      const localInvocation1: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
        fakeLog,
        (i) => i.argv.includes('--settings') && !i.argv.includes('--input-format'),
      );
      expect(localInvocation1.argv).toContain('--permission-mode');
      expect(localInvocation1.argv).toContain('bypassPermissions');
      expect(localInvocation1.argv).not.toContain('--dangerously-skip-permissions');

      // Legacy remote runner: should still keep bypassPermissions.
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
        (i) => i.argv.includes('--settings') && i.argv.includes('--input-format'),
      );
      expect(legacyRemoteInvocation.argv).toContain('--permission-mode');
      expect(legacyRemoteInvocation.argv).toContain('bypassPermissions');

      await requestSessionSwitchRpc({ ui, sessionId, to: 'local', secret, timeoutMs: 25_000 });

      const localInvocation2: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
        fakeLog,
        (i) =>
          i.argv.includes('--settings') &&
          !i.argv.includes('--input-format') &&
          i.invocationId !== localInvocation1.invocationId,
        { timeoutMs: 120_000 },
      );
      expect(localInvocation2.argv).toContain('--permission-mode');
      expect(localInvocation2.argv).toContain('bypassPermissions');
      expect(localInvocation2.argv).not.toContain('--dangerously-skip-permissions');

      // Agent SDK remote runner: should also keep bypassPermissions.
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
        (i) => i.argv.includes('--input-format') && !i.argv.includes('--settings'),
        { timeoutMs: 120_000 },
      );
      expect(agentSdkRemoteInvocation.argv).toContain('--permission-mode');
      expect(agentSdkRemoteInvocation.argv).toContain('bypassPermissions');
    } finally {
      ui.close();
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);

  it('adopts permissionMode from existing session metadata (no CLI override) across local→remote switching', async () => {
    const testDir = run.testDir('claude-switch-metadata-permissions');
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
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'claude-switch-metadata-perms',
        createdAt: Date.now(),
        permissionMode: 'bypassPermissions',
        permissionModeUpdatedAt: 1000,
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-claude-switch-metadata-perms-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLog = resolve(join(testDir, 'fake-claude.jsonl'));

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'claude-switch-metadata-permissions',
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

      const localInvocation: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
        fakeLog,
        (i) => i.argv.includes('--settings') && !i.argv.includes('--input-format'),
      );
      expect(localInvocation.argv).toContain('--permission-mode');
      expect(localInvocation.argv).toContain('bypassPermissions');

      await requestSessionSwitchRpc({ ui, sessionId, to: 'remote', secret, timeoutMs: 20_000 });

      await postEncryptedUiTextMessage({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        secret,
        text: 'FAKE_SWITCH_REMOTE_PROMPT',
      });

      const legacyRemoteInvocation: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
        fakeLog,
        (i) => i.argv.includes('--settings') && i.argv.includes('--input-format'),
      );
      expect(legacyRemoteInvocation.argv).toContain('--permission-mode');
      expect(legacyRemoteInvocation.argv).toContain('bypassPermissions');
    } finally {
      ui.close();
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});
