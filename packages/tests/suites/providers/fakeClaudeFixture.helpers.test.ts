import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  mergeMcpServers,
  parseHookForwarderCommand,
  parseMcpConfigs,
  runHookForwarder,
} from '../../src/fixtures/fake-claude-code-cli.helpers.cjs';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-claude-fixture-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    await withTempDir(async (dir) => {
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
      expect(hook).toEqual({ type: 'node', scriptPath, port: 7123 });
    });
  });

  it('records skipped raw hook commands', async () => {
    await withTempDir(async (dir) => {
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
});
