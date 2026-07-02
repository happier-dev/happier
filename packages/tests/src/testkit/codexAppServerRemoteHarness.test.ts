import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn as spawnChild } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';

const events: string[] = [];
let spawned = false;
let fetchCount = 0;

function encodeMetadata(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

vi.mock('./auth', () => ({
  createTestAuth: async () => {
    events.push('create-auth');
    return { token: 'token-1', publicKeyBase64: 'pk-1' };
  },
}));

vi.mock('./cliAuth', () => ({
  seedCliAuthForServer: async () => {
    events.push('seed-auth');
  },
}));

vi.mock('./cliAttachFile', () => ({
  writeCliSessionAttachFile: async () => {
    events.push('write-attach');
    return '/tmp/attach.json';
  },
}));

vi.mock('./daemon/daemon', () => ({
  stopDaemonFromHomeDir: async () => {
    events.push('stop-daemon');
  },
}));

vi.mock('./manifestForServer', () => ({
  writeTestManifestForServer: () => {
    events.push('write-manifest');
  },
}));

vi.mock('./messageCrypto', () => ({
  encryptLegacyBase64: (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
}));

vi.mock('./decryptLegacyBase64Normalized', () => ({
  decryptLegacyBase64Normalized: (value: string) => JSON.parse(Buffer.from(value, 'base64').toString('utf8')),
}));

vi.mock('./process/serverLight', () => ({
  startServerLight: async () => {
    events.push('start-server');
    return {
      baseUrl: 'http://127.0.0.1:31735',
      stop: async () => {
        events.push('stop-server');
      },
    };
  },
}));

vi.mock('./process/spawnProcess', () => ({
  spawnLoggedProcess: (params: { stdoutPath: string; stderrPath: string }) => {
    events.push('spawn');
    spawned = true;
    return {
      child: { pid: 123 } as never,
      stdoutPath: params.stdoutPath,
      stderrPath: params.stderrPath,
      stop: async () => {
        events.push('stop-proc');
      },
    };
  },
}));

vi.mock('./process/commands', () => ({
  yarnCommand: () => 'yarn',
}));

vi.mock('./sessions', () => ({
  createSessionWithCiphertexts: async () => {
    events.push('create-session');
    return { sessionId: 'session-1', tag: 'tag-1' };
  },
  fetchSessionV2: async () => {
    fetchCount += 1;
    events.push(`fetch-${fetchCount}-${spawned ? 'after-spawn' : 'before-spawn'}`);
    return {
      active: false,
      agentStateVersion: spawned ? 2 : 1,
      seq: 0,
      metadata: encodeMetadata(
        spawned
          ? { codexBackendMode: 'appServer', codexSessionId: 'session-1' }
          : { codexBackendMode: 'appServer' },
      ),
    };
  },
}));

vi.mock('./timing', () => ({
  waitFor: async (fn: () => Promise<boolean>) => {
    events.push('wait-for');
    const result = await fn();
    if (!result) {
      throw new Error('waitFor failed');
    }
  },
}));

describe('startCodexAppServerRemoteHarness', () => {
  beforeEach(() => {
    vi.resetModules();
    events.length = 0;
    spawned = false;
    fetchCount = 0;
  });

  it('captures the pre-spawn session baseline before launching the CLI', async () => {
    const { startCodexAppServerRemoteHarness } = await import('./codexAppServerRemoteHarness');
    const testDir = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-harness-'));

    const harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: 'run-1',
      testName: 'codex-app-server-harness-race',
    });

    try {
      expect(events).not.toContain('wait-for');
      expect(events).not.toContain('fetch-1-before-spawn');
      expect(events.indexOf('spawn')).toBeLessThan(events.indexOf('fetch-1-after-spawn'));
      expect(harness.readySession.agentStateVersion).toBe(2);
    } finally {
      await harness.stop();
    }
  });

  it('writes a fake app-server that supports goals, catalog lists, and native review', async () => {
    const { writeFakeCodexAppServerScript } = await import('./codexAppServerRemoteHarness');
    const testDir = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-script-'));
    const requestLogPath = join(testDir, 'requests.jsonl');
    const scriptPath = await writeFakeCodexAppServerScript({
      dir: testDir,
      requestLogPath,
      initialGoal: {
        threadId: 'thread-started',
        objective: 'Ship the import',
        status: 'active',
        tokenBudget: 1200,
      },
    });

    const child = spawnChild(process.execPath, [scriptPath], {
      cwd: testDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

    const readResponse = async (id: number): Promise<Record<string, unknown>> => {
      while (true) {
        const [line] = await Promise.race([
          once(lines, 'line') as Promise<[string]>,
          once(child, 'exit').then(() => {
            throw new Error(`Fake app-server exited before response ${id}`);
          }),
        ]);
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.id === id) return parsed;
      }
    };

    const send = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return await readResponse(id);
    };

    try {
      expect(await send(1, 'thread/goal/get', { threadId: 'thread-started' })).toMatchObject({
        result: {
          objective: 'Ship the import',
          tokenBudget: 1200,
        },
      });
      expect(await send(2, 'thread/goal/set', { threadId: 'thread-started', objective: 'Keep shipping' })).toMatchObject({
        result: {
          objective: 'Keep shipping',
          status: 'active',
        },
      });
      expect(await send(3, 'plugin/list')).toMatchObject({
        result: {
          marketplaces: [
            {
              plugins: [
                {
                  id: 'reviewer@codex',
                  installed: true,
                  enabled: true,
                },
              ],
            },
          ],
        },
      });
      expect(await send(4, 'skills/list', { cwds: [testDir] })).toMatchObject({
        result: {
          data: [
            {
              cwd: testDir,
              skills: [
                {
                  name: 'code-review',
                  enabled: true,
                },
              ],
            },
          ],
        },
      });
      expect(await send(5, 'review/start', { threadId: 'thread-started', target: { type: 'uncommittedChanges' } })).toMatchObject({
        result: {
          turn: {
            id: expect.stringMatching(/^review-turn-/),
          },
        },
      });
    } finally {
      child.kill();
      lines.close();
      await once(child, 'exit').catch(() => {});
    }
  });

  it('writes a fake app-server that models steer rows and multi-turn rollback', async () => {
    const { writeFakeCodexAppServerScript } = await import('./codexAppServerRemoteHarness');
    const testDir = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-script-rollback-'));
    const requestLogPath = join(testDir, 'requests.jsonl');
    const scriptPath = await writeFakeCodexAppServerScript({
      dir: testDir,
      requestLogPath,
    });

    const child = spawnChild(process.execPath, [scriptPath], {
      cwd: testDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HAPPIER_E2E_FAKE_CODEX_APP_SERVER_TURN_DELAY_MS: '100',
      },
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

    const readResponse = async (id: number): Promise<Record<string, unknown>> => {
      while (true) {
        const [line] = await Promise.race([
          once(lines, 'line') as Promise<[string]>,
          once(child, 'exit').then(() => {
            throw new Error(`Fake app-server exited before response ${id}`);
          }),
        ]);
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.id === id) return parsed;
      }
    };

    const send = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return await readResponse(id);
    };

    try {
      expect(await send(1, 'thread/start')).toMatchObject({
        result: { threadId: 'thread-started' },
      });
      expect(await send(2, 'turn/start', {
        threadId: 'thread-started',
        input: [{ type: 'text', text: 'first prompt' }],
      })).toMatchObject({
        result: { turn: { id: 'turn-1' }, threadId: 'thread-started' },
      });
      expect(await send(3, 'turn/steer', {
        threadId: 'thread-started',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'steer prompt' }],
      })).toMatchObject({
        result: { threadId: 'thread-started', turn: { id: 'turn-1' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect(await send(4, 'turn/start', {
        threadId: 'thread-started',
        input: [{ type: 'text', text: 'second prompt' }],
      })).toMatchObject({
        result: { turn: { id: 'turn-2' }, threadId: 'thread-started' },
      });
      await new Promise((resolve) => setTimeout(resolve, 160));

      const beforeRollback = await send(5, 'thread/read', { threadId: 'thread-started', includeTurns: true });
      expect(beforeRollback).toMatchObject({
        result: {
          threadId: 'thread-started',
          turns: [
            {
              id: 'turn-1',
              items: expect.arrayContaining([
                expect.objectContaining({ type: 'userMessage', text: 'first prompt' }),
                expect.objectContaining({ type: 'userMessage', text: 'steer prompt' }),
              ]),
            },
            {
              id: 'turn-2',
              items: expect.arrayContaining([
                expect.objectContaining({ type: 'userMessage', text: 'second prompt' }),
              ]),
            },
          ],
        },
      });

      expect(await send(6, 'thread/rollback', { threadId: 'thread-started', numTurns: 2 })).toMatchObject({
        result: { threadId: 'thread-started' },
      });
      expect(await send(7, 'thread/read', { threadId: 'thread-started', includeTurns: true })).toMatchObject({
        result: {
          threadId: 'thread-started',
          turns: [],
        },
      });
    } finally {
      child.kill();
      lines.close();
      await once(child, 'exit').catch(() => {});
    }
  });

  it('can stop only the spawned Codex runtime while keeping the test server alive', async () => {
    const { startCodexAppServerRemoteHarness } = await import('./codexAppServerRemoteHarness');
    const testDir = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-harness-runtime-stop-'));

    const harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: 'run-1',
      testName: 'codex-app-server-harness-runtime-stop',
    });

    try {
      await harness.stopRuntime();
      expect(events).toContain('stop-proc');
      expect(events).not.toContain('stop-server');
    } finally {
      await harness.stop();
    }
  });
});
