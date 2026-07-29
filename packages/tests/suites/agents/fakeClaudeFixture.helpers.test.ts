import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  mergeMcpServers,
  parseHookForwarderCommand,
  parseMcpConfigs,
  runHookForwarder,
} from '../../src/fixtures/fake-claude-code-cli.helpers.cjs';
import {
  countFakeClaudeEventsAfterCurrentRunSentinel,
  fakeClaudeFixturePath,
  waitForFakeClaudeUserText,
} from '../../src/testkit/fakeClaude';
import { withTempDir } from '../../src/testkit/fs/tempDir';

const execFileAsync = promisify(execFile);

async function readJsonFileEventually(filePath: string): Promise<unknown> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

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
      const secretPath = join(dir, 'session-hook-secret');
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
        secretFile: '/tmp/session-hook-secret',
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
        '/tmp/session-hook-secret',
      ],
    }]);
  });

  it('reads SessionStart hooks from --plugin-dir in the fake Claude executable', async () => {
    await withTempDir({ prefix: 'fake-claude-fixture-' }, async ({ path: dir }) => {
      const pluginDir = join(dir, 'plugin');
      const hooksDir = join(pluginDir, 'hooks');
      const forwarderPath = join(dir, 'capture-forwarder.cjs');
      const capturePath = join(dir, 'forwarder-capture.json');
      const secretPath = join(dir, 'session-hook-secret');
      await mkdir(hooksDir, { recursive: true });
      await writeFile(secretPath, 'fixture-secret', 'utf8');
      await writeFile(
        forwarderPath,
        [
          'const fs = require("node:fs");',
          'const chunks = [];',
          'process.stdin.on("data", (chunk) => chunks.push(chunk));',
          'process.stdin.on("end", () => {',
          '  fs.writeFileSync(process.env.FORWARDER_CAPTURE_PATH, JSON.stringify({',
          '    argv: process.argv.slice(2),',
          '    payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),',
          '  }));',
          '});',
          'process.stdin.resume();',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(hooksDir, 'hooks.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [{
              hooks: [{
                command: `node "${forwarderPath}" 8123 "SessionStart" --secret-file "${secretPath}"`,
              }],
            }],
          },
        }),
        'utf8',
      );

      await execFileAsync(
        process.execPath,
        [
          fakeClaudeFixturePath(),
          '--plugin-dir',
          pluginDir,
          '--output-format',
          'stream-json',
          '--print',
        ],
        {
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
            FORWARDER_CAPTURE_PATH: capturePath,
            HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: 'fake-session-plugin-hooks',
            HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: 'fake-invocation-plugin-hooks',
          },
        },
      );

      const capture = await readJsonFileEventually(capturePath);
      expect(capture).toEqual({
        argv: ['8123', 'SessionStart', '--secret-file', secretPath],
        payload: expect.objectContaining({
          session_id: 'fake-session-plugin-hooks',
        }),
      });
    });
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

  it('waits for user text from the requested fake Claude invocation only', async () => {
    await withTempDir({ prefix: 'fake-claude-fixture-' }, async ({ path: dir }) => {
      const logPath = join(dir, 'fixture-log.jsonl');
      const sentinel = 'UNIQUE_FIRST_PROMPT';
      const staleText = `stale host context ${sentinel} stale suffix`;
      const currentText = `current host context ${sentinel} current suffix`;
      await writeFile(
        logPath,
        `${JSON.stringify({
          type: 'sdk_stdin', invocationId: 'inv-stale', hasUserText: true, userText: staleText,
        })}\n`
        + `${JSON.stringify({
          type: 'sdk_stdin', invocationId: 'inv-current', hasUserText: true, userText: currentText,
        })}\n`,
        'utf8',
      );

      await expect(waitForFakeClaudeUserText(
        logPath,
        (text) => text.includes(sentinel),
        { invocationId: 'inv-current', timeoutMs: 100, pollMs: 5 },
      )).resolves.toBe(currentText);
    });
  });

  it('returns the fake Claude JavaScript wrapper entrypoint path', () => {
    const fixturePath = fakeClaudeFixturePath();
    expect(fixturePath.endsWith('fake-claude-code-cli.js')).toBe(true);
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
            if (/>\s*Try\s+"/.test(output)) {
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

        expect(stdout).toMatch(/>\s*Try\s+"/);
      } finally {
        child.kill('SIGTERM');
      }
    });
  });
});
