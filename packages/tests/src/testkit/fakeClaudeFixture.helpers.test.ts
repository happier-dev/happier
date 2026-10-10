import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  mergeMcpServers,
  parseHookForwarderCommand,
  parseMcpConfigs,
  runHookForwarder,
} from '../../src/fixtures/fake-claude-code-cli.helpers.cjs';
import {
  countFakeClaudeEventsAfterCurrentRunSentinel,
  fakeClaudeEchoResponseText,
  fakeClaudeFixturePath,
} from '../../src/testkit/fakeClaude';
import { withTempDir } from '../../src/testkit/fs/tempDir';

describe('fake Claude fixture helpers', () => {
  it('parses mcp config args and parse errors', () => {
    const configs = parseMcpConfigs([
      '--mcp-config',
      '{"mcpServers":{"a":{"type":"stdio"}}}',
      '--other',
      'x',
      '--mcp-config',
      '{"broken"',
    ]);

    expect(configs).toHaveLength(2);
    expect(configs[0]).toEqual({ mcpServers: { a: { type: 'stdio' } } });
    expect(configs[1]).toEqual({ _parseError: true, raw: '{"broken"' });
  });

  it('merges mcp server maps with last-write-wins', () => {
    const merged = mergeMcpServers([
      { mcpServers: { one: { command: 'a' }, two: { command: 'b' } } },
      { mcpServers: { two: { command: 'override' } } },
    ]);

    expect(merged).toEqual({
      one: { command: 'a' },
      two: { command: 'override' },
    });
  });

  it('parses SessionStart hook command from settings file', async () => {
    await withTempDir({ prefix: 'fake-claude-fixture-' }, async ({ path: dir }) => {
      const settingsPath = join(dir, 'settings.json');
      const scriptPath = join(dir, 'forwarder.js');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ command: `node "${scriptPath}" 7123` }] }] },
        }),
        'utf8',
      );

      const hook = parseHookForwarderCommand(settingsPath);
      expect(hook).toEqual({ type: 'node', runtimeExecutable: 'node', scriptPath, port: 7123 });
    });
  });

  it('parses SessionStart hook command when the runtime executable path is quoted', async () => {
    await withTempDir({ prefix: 'fake-claude-fixture-' }, async ({ path: dir }) => {
      const settingsPath = join(dir, 'settings.json');
      const runtimePath = join(dir, 'managed node');
      const scriptPath = join(dir, 'forwarder.js');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ command: `${JSON.stringify(runtimePath)} ${JSON.stringify(scriptPath)} 7123` }] }] },
        }),
        'utf8',
      );

      const hook = parseHookForwarderCommand(settingsPath);
      expect(hook).toEqual({ type: 'node', runtimeExecutable: runtimePath, scriptPath, port: 7123 });
    });
  });

  it('parses SessionStart hook command from plugin hooks file before settings fallback', async () => {
    await withTempDir({ prefix: 'fake-claude-fixture-' }, async ({ path: dir }) => {
      const settingsPath = join(dir, 'settings.json');
      const pluginDir = join(dir, 'plugin');
      const hooksDir = join(pluginDir, 'hooks');
      const scriptPath = join(dir, 'forwarder.js');
      await mkdir(hooksDir, { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ command: 'echo should-not-win' }] }] },
        }),
        'utf8',
      );
      await writeFile(
        join(hooksDir, 'hooks.json'),
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ command: `node "${scriptPath}" 7123 "SessionStart"` }] }] },
        }),
        'utf8',
      );

      const hook = parseHookForwarderCommand(settingsPath, pluginDir);
      expect(hook).toEqual({ type: 'node', runtimeExecutable: 'node', scriptPath, port: 7123, hookEventName: 'SessionStart' });
    });
  });

  it('parses SessionStart hook command with a secret-file argument', async () => {
    await withTempDir({ prefix: 'fake-claude-fixture-' }, async ({ path: dir }) => {
      const settingsPath = join(dir, 'settings.json');
      const runtimePath = join(dir, 'managed node');
      const scriptPath = join(dir, 'session_hook_forwarder.cjs');
      const secretPath = join(dir, 'permission-hook-secret');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{
              hooks: [{
                command: `${JSON.stringify(runtimePath)} ${JSON.stringify(scriptPath)} 7123 "SessionStart" --secret-file ${JSON.stringify(secretPath)}`,
              }],
            }],
          },
        }),
        'utf8',
      );

      const hook = parseHookForwarderCommand(settingsPath);
      expect(hook).toEqual({
        type: 'node',
        runtimeExecutable: runtimePath,
        scriptPath,
        port: 7123,
        hookEventName: 'SessionStart',
        secretFile: secretPath,
      });
    });
  });

  it('records skipped raw hook commands', async () => {
    await withTempDir({ prefix: 'fake-claude-fixture-' }, async ({ path: dir }) => {
      const logPath = join(dir, 'fixture-log.jsonl');
      await runHookForwarder({
        hook: { type: 'raw', command: 'echo unsafe' },
        payload: { ok: true },
        logPath,
        invocationId: 'inv-1',
      });

      const raw = await readFile(logPath, 'utf8');
      const rows = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'hook_skipped',
        invocationId: 'inv-1',
        reason: 'unparseable_command',
        command: 'echo unsafe',
      });
    });
  });

  it('passes secret-file arguments to the SessionStart hook forwarder', async () => {
    const spawned: Array<{ command: string; args: string[] }> = [];
    await runHookForwarder({
      hook: {
        type: 'node',
        runtimeExecutable: '/opt/happier/managed-node',
        scriptPath: '/tmp/session_hook_forwarder.cjs',
        port: 7123,
        hookEventName: 'SessionStart',
        secretFile: '/tmp/permission-hook-secret',
      },
      payload: { ok: true },
      logPath: '',
      invocationId: 'inv-secret',
      spawnImpl: ((command: string, args: string[]) => {
        spawned.push({ command, args });
        return {
          on(event: string, handler: (code?: number, signal?: string | null) => void) {
            if (event === 'exit') queueMicrotask(() => handler(0, null));
            return this;
          },
          stdin: {
            write() {},
            end() {},
          },
        };
      }) as never,
    });

    expect(spawned).toEqual([{
      command: '/opt/happier/managed-node',
      args: [
        '/tmp/session_hook_forwarder.cjs',
        '7123',
        'SessionStart',
        '--secret-file',
        '/tmp/permission-hook-secret',
      ],
    }]);
  });

  it('does not treat missing fake Claude logs as zero matching events', async () => {
    await withTempDir({ prefix: 'fake-claude-fixture-' }, async ({ path: dir }) => {
      await expect(countFakeClaudeEventsAfterCurrentRunSentinel({
        logPath: join(dir, 'missing.jsonl'),
        sinceMs: 1_000,
        predicate: (event) => event.type === 'local_stdin_turn_completed',
      })).rejects.toThrow(/Expected readable fake Claude log/);
    });
  });

  it('allows zero matching events only after a current-run fake Claude sentinel is readable', async () => {
    await withTempDir({ prefix: 'fake-claude-fixture-' }, async ({ path: dir }) => {
      const logPath = join(dir, 'fixture-log.jsonl');
      await writeFile(
        logPath,
        `${JSON.stringify({ type: 'invocation', invocationId: 'inv-current', ts: 900 })}\n`
        + `${JSON.stringify({ type: 'local_turn_started', invocationId: 'inv-current', ts: 950 })}\n`,
        'utf8',
      );

      await expect(countFakeClaudeEventsAfterCurrentRunSentinel({
        logPath,
        sinceMs: 1_000,
        predicate: (event) => event.type === 'local_stdin_turn_completed',
      })).resolves.toBe(0);
    });
  });

  it('returns the fake Claude JavaScript wrapper entrypoint path', () => {
    const fixturePath = fakeClaudeFixturePath();
    expect(fixturePath.endsWith('fake-claude-code-cli.js')).toBe(true);
  });

  it.each([false, true])('settles the SDK continuation signal wait (signal arrives=%s)', async (releaseSignal) => {
    await withTempDir({ prefix: 'fake-claude-continuation-' }, async ({ path: dir }) => {
      const logPath = join(dir, 'claude.jsonl');
      const signalPath = join(dir, 'accept');
      // Seed the prior rejection: this process represents the continuation SDK child.
      await writeFile(logPath, `${JSON.stringify({ type: 'sdk_usage_limit' })}\n`);
      const child = spawn(process.execPath, [fakeClaudeFixturePath(), '--output-format', 'stream-json', '--input-format', 'stream-json'], {
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'usage-limit-once',
          HAPPIER_E2E_FAKE_CLAUDE_CONTINUATION_ACCEPT_SIGNAL: signalPath,
          HAPPIER_E2E_FAKE_CLAUDE_CONTINUATION_ACCEPT_TIMEOUT_MS: '500',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      child.stdout.once('data', () => {
        // A valid signal may arrive well after a short polling interval.
        if (releaseSignal) releaseTimer = setTimeout(() => { void writeFile(signalPath, 'accept\n'); }, 150);
      });
      child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Continue' }] } })}\n`);
      const code = await new Promise<number | null>((resolve, reject) => {
        let timedOut = false;
        const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 2_000);
        child.once('error', (error) => { clearTimeout(guard); reject(error); });
        child.once('close', (exitCode) => {
          clearTimeout(guard);
          if (timedOut) reject(new Error('Fixture did not settle its configured signal deadline'));
          else resolve(exitCode);
        });
      }).finally(() => { if (releaseTimer) clearTimeout(releaseTimer); });
      expect(code).toBe(releaseSignal ? 0 : 1);
      const log = await readFile(logPath, 'utf8');
      expect(log.includes('sdk_continuation_accepted')).toBe(releaseSignal);
      if (!releaseSignal) expect(stderr).toContain('continuation_accept_signal_timeout');
    });
  });

  it('can correlate SDK responses to prompts across separate provider processes', async () => {
    async function runEchoProcess(prompt: string): Promise<string[]> {
      const child = spawn(
        process.execPath,
        [fakeClaudeFixturePath(), '--output-format', 'stream-json', '--input-format', 'stream-json'],
        {
          env: {
            ...process.env,
            HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'echo-user-text',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );

      const stdoutChunks: string[] = [];
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => stdoutChunks.push(chunk));
      child.stdin.end(`${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      })}\n`);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`Timed out waiting for fake Claude echo response for ${JSON.stringify(prompt)}`));
        }, 2_000);
        child.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.on('exit', (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(`fake Claude echo process exited with code ${code}`));
            return;
          }
          resolve();
        });
      });

      return stdoutChunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .flatMap((event) => Array.isArray(event?.message?.content) ? event.message.content : [])
        .filter((part) => part?.type === 'text')
        .map((part) => String(part.text));
    }

    await expect(runEchoProcess('first resumed prompt')).resolves.toContain(fakeClaudeEchoResponseText('first resumed prompt'));
    await expect(runEchoProcess('second resumed prompt')).resolves.toContain(fakeClaudeEchoResponseText('second resumed prompt'));
  });

  it('answers the installed-runtime help probe and exits instead of entering interactive mode', async () => {
    await withTempDir({ prefix: 'fake-claude-help-probe-' }, async ({ path: dir }) => {
      const child = spawn(process.execPath, [fakeClaudeFixturePath(), '--help'], {
        cwd: dir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        let stdout = '';
        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`Timed out waiting for fake Claude --help; stdout=${JSON.stringify(stdout)}`));
        }, 2_000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.on('exit', (code) => {
          clearTimeout(timeout);
          resolve({ code, stdout });
        });
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('--input-format');
    });
  });

  it('renders an idle local composer so unified-terminal startup readiness can inject prompts', async () => {
    await withTempDir({ prefix: 'fake-claude-local-readiness-' }, async ({ path: dir }) => {
      const logPath = join(dir, 'fake-claude.jsonl');
      const child = spawn(process.execPath, [fakeClaudeFixturePath()], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        const stdout = await new Promise<string>((resolve, reject) => {
          let output = '';
          const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for fake Claude local composer output; stdout=${JSON.stringify(output)}`));
          }, 2_000);
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => {
            output += chunk;
            if (/\n❯ $/.test(output)) {
              clearTimeout(timeout);
              resolve(output);
            }
          });
          child.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.on('exit', (code, signal) => {
            clearTimeout(timeout);
            reject(new Error(`fake Claude exited before composer output (code=${code}, signal=${signal})`));
          });
        });

        expect(stdout).toMatch(/\n❯ $/);
      } finally {
        child.kill('SIGTERM');
      }
    });
  });
});
