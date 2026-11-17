import { describe, expect, it } from 'vitest';
import { spawn as spawnChild } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { existsSync } from 'node:fs';
import { parseCodexCliStableVersion } from '../../../plugins/codex/src/agent/cli/detect';
import { assertCodexToolRestrictionRuntimeSupported } from '../../../plugins/codex/src/agent/runtime/appServer/client/toolRestriction';
import { buildCodexAppServerConfigOverrides } from '../../../plugins/codex/src/agent/runtime/appServer/config/overrides';
import { connectManagedJsonRpcTestClient, createManagedJsonRpcTestClient } from '../../../../apps/cli/src/testkit/process/managedJsonRpc';
import { waitFor } from './timing';

describe('native Codex app-server boundary fixture', () => {
  it('reports the native CLI version and tool-mode catalog required by confinement admission', async () => {
    const { writeFakeCodexAppServerScript } = await import('./codexAppServerRemoteHarness');
    const testDir = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-version-'));
    const scriptPath = await writeFakeCodexAppServerScript({ dir: testDir, requestLogPath: join(testDir, 'requests.jsonl') });
    const child = spawnChild(process.execPath, [scriptPath, '--version'], {
      cwd: testDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const [exitCode] = await once(child, 'exit');
    expect(exitCode, stderr).toBe(0);
    expect(() => assertCodexToolRestrictionRuntimeSupported(parseCodexCliStableVersion(stdout)?.value)).not.toThrow();
    const catalog = spawnChild(process.execPath, [scriptPath, 'debug', 'models'], {
      cwd: testDir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let models = '';
    catalog.stdout.setEncoding('utf8').on('data', chunk => { models += chunk; });
    const [catalogExit] = await once(catalog, 'exit');
    expect(catalogExit).toBe(0);
    expect(JSON.parse(models)).toMatchObject({ models: [{ slug: 'gpt-5.4', tool_mode: 'code_mode_only' }] });
  });

  it.skipIf(process.platform === 'win32')('serves native initialization, confinement config and turns through Unix and raw proxy transports', async () => {
    const { writeFakeCodexAppServerScript } = await import('./codexAppServerRemoteHarness');
    const testDir = await mkdtemp(join(tmpdir(), 'cx-socket-'));
    const scriptPath = await writeFakeCodexAppServerScript({ dir: testDir, requestLogPath: join(testDir, 'requests.jsonl') });
    const socketPath = join(testDir, 'private', 'app-server.sock');
    const overrides = buildCodexAppServerConfigOverrides({}, { unlistedTools: 'deny', allowedTools: [] });
    const server = spawnChild(process.execPath, [scriptPath, 'app-server', '--listen', `unix://${socketPath}`,
      ...overrides.flatMap(override => ['-c', override])], { cwd: testDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    server.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    try {
      await waitFor(() => {
        if (server.exitCode !== null) throw new Error(`Fake app-server exited ${server.exitCode}: ${stderr}`);
        return existsSync(socketPath);
      }, { failFast: true, context: 'fake native Unix control socket' });
      for (const transport of ['unix', 'proxy'] as const) {
        const connection = transport === 'unix'
          ? await connectManagedJsonRpcTestClient({ cwd: testDir, socketPath })
          : await createManagedJsonRpcTestClient({ cwd: testDir, command: process.execPath,
            args: [scriptPath, 'app-server', 'proxy', '--sock', socketPath] });
        try {
          expect(await connection.client.request('initialize', {})).toMatchObject({ userAgent: expect.stringMatching(/^codex-cli\/\d+\.\d+\.\d+$/) });
          await connection.client.notify('initialized');
          expect(await connection.client.request('config/read', { includeLayers: false })).toMatchObject({
            config: { features: { code_mode: { excluded_tool_namespaces: ['functions'] } }, mcp_servers: {} },
          });
          expect(await connection.client.request('thread/start', {})).toMatchObject({ threadId: 'thread-started' });
          expect(await connection.client.request('turn/start', { threadId: 'thread-started', input: [{ type: 'text', text: 'explain' }] }))
            .toMatchObject({ turn: { id: expect.stringMatching(/^turn-/) } });
        } finally { await connection.dispose(); }
      }
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit');
        server.kill();
        await exited;
      }
    }
  });

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
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited.catch(() => {});
      }
      lines.close();
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
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited.catch(() => {});
      }
      lines.close();
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
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited.catch(() => {});
      }
      lines.close();
    }
  });

});
