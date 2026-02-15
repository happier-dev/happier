import { describe, expect, it } from 'vitest';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerEphemeralTaskHandlers } from './ephemeralTasks';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';

const execFileAsync = promisify(execFile);

async function run(cmd: string, args: readonly string[], cwd: string): Promise<void> {
  await execFileAsync(cmd, [...args], { cwd });
}

function createStaticBackend(responseText: string, capture: { lastPrompt: string }): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  return {
    async startSession() {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, prompt: string) {
      capture.lastPrompt = prompt;
      handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
    },
    async cancel(_sessionId: SessionId) {},
    onMessage(next) {
      handler = next;
    },
    async dispose() {},
    async waitForResponseComplete() {},
  };
}

function createDelayedBackend(responseText: string, delayMs: number): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done: Promise<void> | null = null;
  let resolveDone: (() => void) | null = null;
  return {
    async startSession() {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, prompt: string) {
      done = new Promise((resolve) => {
        resolveDone = resolve;
        timer = setTimeout(() => {
          handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
          resolve();
        }, delayMs);
      });
    },
    async cancel(_sessionId: SessionId) {
      if (timer) clearTimeout(timer);
      resolveDone?.();
    },
    onMessage(next) {
      handler = next;
    },
    async dispose() {},
    async waitForResponseComplete() {
      await (done ?? Promise.resolve());
    },
  };
}

async function createTmpGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-ephemeral-task-'));
  await run('git', ['init'], dir);
  await run('git', ['config', 'user.email', 'test@example.com'], dir);
  await run('git', ['config', 'user.name', 'Test'], dir);
  await writeFile(join(dir, 'a.txt'), 'hello\n', 'utf8');
  await run('git', ['add', '.'], dir);
  await run('git', ['commit', '-m', 'init'], dir);
  await writeFile(join(dir, 'a.txt'), 'hello world\n', 'utf8');
  return dir;
}

async function createTmpGitRepoWithTwoChanges(): Promise<string> {
  const dir = await createTmpGitRepo();
  await writeFile(join(dir, 'b.txt'), 'b\n', 'utf8');
  await run('git', ['add', 'b.txt'], dir);
  // Keep it uncommitted so it shows as changed/pending.
  await writeFile(join(dir, 'b.txt'), 'b2\n', 'utf8');
  return dir;
}

describe('ephemeral.task.run session RPC handler', () => {
  it('generates a commit message for scm.commit_message', async () => {
    const repoDir = await createTmpGitRepo();
    const capture = { lastPrompt: '' };

    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerEphemeralTaskHandlers(rpc, {
            workingDirectory: repoDir,
            createBackend: (_opts: { backendId: string; permissionMode: string }) =>
              createStaticBackend(
                JSON.stringify({
                  title: 'feat: update a',
                  body: 'Explain change',
                  message: 'feat: update a\\n\\nExplain change',
                  confidence: 0.8,
                }),
                capture,
              ),
          });
        },
      });

      const res = await client.call<any, any>(SESSION_RPC_METHODS.EPHEMERAL_TASK_RUN, {
        kind: 'scm.commit_message',
        sessionId: 'sess_1',
        input: { backendId: 'claude' },
        permissionMode: 'no_tools',
      });

      expect(res.ok).toBe(true);
      expect(res.result?.title).toBe('feat: update a');
      expect(String(capture.lastPrompt)).toContain('Commit message');
      expect(String(capture.lastPrompt)).toContain('a.txt');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects patches input for scm.commit_message', async () => {
    const repoDir = await createTmpGitRepo();
    const capture = { lastPrompt: '' };

    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_2',
        registerHandlers: (rpc) => {
          registerEphemeralTaskHandlers(rpc, {
            workingDirectory: repoDir,
            createBackend: (_opts: { backendId: string; permissionMode: string }) =>
              createStaticBackend(
                JSON.stringify({
                  title: 'feat: patch change',
                  body: '',
                  message: 'feat: patch change',
                }),
                capture,
              ),
          });
        },
      });

      const res = await client.call<any, any>(SESSION_RPC_METHODS.EPHEMERAL_TASK_RUN, {
        kind: 'scm.commit_message',
        sessionId: 'sess_2',
        input: { backendId: 'claude', patches: [{ path: 'a.txt', patch: 'SENTINEL' }] },
        permissionMode: 'no_tools',
      });

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('invalid_request');
      expect(String(capture.lastPrompt)).toBe('');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('uses scope.kind=paths to bound diff excerpts to selected paths', async () => {
    const repoDir = await createTmpGitRepoWithTwoChanges();
    const capture = { lastPrompt: '' };

    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_4',
        registerHandlers: (rpc) => {
          registerEphemeralTaskHandlers(rpc, {
            workingDirectory: repoDir,
            createBackend: (_opts: { backendId: string; permissionMode: string }) =>
              createStaticBackend(
                JSON.stringify({
                  title: 'feat: scoped',
                  body: '',
                  message: 'feat: scoped',
                }),
                capture,
              ),
          });
        },
      });

      const res = await client.call<any, any>(SESSION_RPC_METHODS.EPHEMERAL_TASK_RUN, {
        kind: 'scm.commit_message',
        sessionId: 'sess_4',
        input: { backendId: 'claude', scope: { kind: 'paths', include: ['b.txt'] } },
        permissionMode: 'no_tools',
      });

      expect(res.ok).toBe(true);
      expect(String(capture.lastPrompt)).toContain('### b.txt');
      expect(String(capture.lastPrompt)).not.toContain('### a.txt');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('returns task_busy when ephemeral task budget is exceeded', async () => {
    const repoDir = await createTmpGitRepo();
    const budgetRegistry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 10, maxConcurrentEphemeralTasks: 1 });

    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_3',
        registerHandlers: (rpc) => {
          registerEphemeralTaskHandlers(rpc, {
            workingDirectory: repoDir,
            budgetRegistry,
            createBackend: () =>
              createDelayedBackend(
                JSON.stringify({ title: 'feat: slow', body: '', message: 'feat: slow' }),
                200,
              ),
          });
        },
      });

      const first = client.call<any, any>(SESSION_RPC_METHODS.EPHEMERAL_TASK_RUN, {
        kind: 'scm.commit_message',
        sessionId: 'sess_3',
        input: { backendId: 'claude' },
        permissionMode: 'no_tools',
      });

      // Ensure first has acquired the slot.
      await new Promise((r) => setTimeout(r, 10));

      const second = await client.call<any, any>(SESSION_RPC_METHODS.EPHEMERAL_TASK_RUN, {
        kind: 'scm.commit_message',
        sessionId: 'sess_3',
        input: { backendId: 'claude' },
        permissionMode: 'no_tools',
      });

      expect(second.ok).toBe(false);
      expect(second.error?.code).toBe('task_busy');

      await first;
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
