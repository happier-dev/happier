import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema, type ExecutionRunGetResponse } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { callLegacyEncryptedSessionRpc as callSessionRpc } from '../../src/testkit/sessionRpc';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requireCompletedRun(value: ExecutionRunGetResponse | null): ExecutionRunGetResponse {
  if (!value) {
    throw new Error('Missing completed execution run');
  }
  return value;
}

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: execution run scm_commit_message.v1', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  }, 60_000);

  it('generates a deterministic commit message via fake Claude', async () => {
    const testDir = run.testDir(`execution-run-commit-message-${randomUUID()}`);
    server = await startServerLight({ testDir });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    // Minimal git repo with a pending change (gives the task something to summarize).
    await writeFile(join(workspaceDir, 'README.md'), '# commit message e2e\n', 'utf8');
    runGit(workspaceDir, ['init']);
    runGit(workspaceDir, ['config', 'user.name', 'Test User']);
    runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
    runGit(workspaceDir, ['add', 'README.md']);
    runGit(workspaceDir, ['commit', '-m', 'initial commit']);
    await writeFile(join(workspaceDir, 'README.md'), '# commit message e2e\n\npending line\n', 'utf8');

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForTestAccount({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, auth, mode: 'legacy' });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLog = resolve(join(testDir, 'fake-claude.jsonl'));

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLog,
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      },
    });
    const controlToken = (daemon.state as any)?.controlToken as string | undefined;

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'plain' },
        environmentVariables: {
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLog,
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'commit-message-json',
          HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        },
      },
    });
    expect(spawnRes.status, JSON.stringify(spawnRes.data, null, 2)).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing sessionId from daemon spawn-session');

    const started = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_START,
      req: {
        kind: 'scm_commit_message.v1',
        intent: 'scm_commit_message',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        intentInput: {
          scope: { kind: 'paths', include: ['README.md'] },
        },
      },
      secret,
      schema: ExecutionRunStartResponseSchema,
      timeoutMs: 40_000,
    });

    let completed: ExecutionRunGetResponse | null = null;
    await waitFor(async () => {
      const res = await callSessionRpc({
        ui,
        sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
        req: {
          runId: started.runId,
          includeStructured: true,
        },
        secret,
        schema: ExecutionRunGetResponseSchema,
        timeoutMs: 40_000,
      });
      if (res.run.status === 'running') return false;
      completed = res;
      return true;
    }, { timeoutMs: 40_000 });

    const completedRun = requireCompletedRun(completed);
    expect(completedRun.run.status).toBe('succeeded');
    expect(readRecord(completedRun.latestToolResult)?.message).toBe('feat: ephemeral commit message');
  }, 240_000);
});
