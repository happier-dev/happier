import { describe, expect, it } from 'vitest';
import { spawn as spawnChild } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';

describe('native Codex app-server boundary fixture', () => {
  it('rejects a resume request for the wrong native thread when the test requires an exact identity', async () => {
    const { writeFakeCodexAppServerScript } = await import('./codexAppServerRemoteHarness');
    const testDir = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-strict-resume-'));
    const requestLogPath = join(testDir, 'requests.jsonl');
    const scriptPath = await writeFakeCodexAppServerScript({
      dir: testDir,
      requestLogPath,
      expectedResumeThreadId: 'thread-started',
    });
    const child = spawnChild(process.execPath, [scriptPath], {
      cwd: testDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

    try {
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for strict resume response')), 5_000);
        lines.on('line', (line) => {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id !== 1) return;
          clearTimeout(timeout);
          resolve(parsed);
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          reject(new Error('Fake app-server exited before strict resume response'));
        });
        child.stdin.write(`${JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'wrong-thread' } })}\n`);
      });

      expect(response).toMatchObject({
        error: expect.objectContaining({ code: -32602 }),
      });
    } finally {
      child.kill();
      lines.close();
      await once(child, 'exit').catch(() => {});
    }
  });

  it('writes a fake app-server that supports goals, catalog lists, and native review', async () => {
    const { writeFakeCodexAppServerScript } = await import('./codexAppServerRemoteHarness');
    const testDir = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-script-'));
    const requestLogPath = join(testDir, 'requests.jsonl');
    const modelListStatePath = join(testDir, 'models.json');
    await writeFile(modelListStatePath, JSON.stringify({ models: [{ id: 'first' }] }));
    const scriptPath = await writeFakeCodexAppServerScript({
      dir: testDir,
      requestLogPath,
      modelListStatePath,
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

    const responseLines = lines[Symbol.asyncIterator]();
    const readResponse = async (id: number): Promise<Record<string, unknown>> => {
      while (true) {
        const next = await responseLines.next();
        if (next.done) throw new Error(`Fake app-server exited before response ${id}`);
        const parsed = JSON.parse(next.value) as Record<string, unknown>;
        if (parsed.id === id) return parsed;
      }
    };

    const send = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return await readResponse(id);
    };

    try {
      expect(await send(0, 'thread/name/set', { threadId: 'thread-started', name: 'Native Goal journey' })).toEqual({ id: 0, result: {} });
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
      expect(await send(6, 'thread/fork', { threadId: 'thread-started' })).toMatchObject({
        result: {
          threadId: 'thread-forked',
          model: 'gpt-5.4',
          serviceTier: null,
        },
      });
      expect(await send(7, 'model/list')).toMatchObject({ result: [{ id: 'first' }] });
      await writeFile(modelListStatePath, JSON.stringify({ models: [{ id: 'second' }] }));
      expect(await send(8, 'model/list')).toMatchObject({ result: [{ id: 'second' }] });
      await writeFile(modelListStatePath, JSON.stringify({ error: true }));
      expect(await send(9, 'model/list')).toMatchObject({ error: { code: -32000 } });
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

});
