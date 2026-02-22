import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadClaudeMcpServers, loadCodexMcpServers } from './loadUserMcpServers';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe('loadClaudeMcpServers', () => {
  it('returns servers from ~/.claude/mcp_servers.json shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-claude-mcp-'));
    writeFileSync(
      join(root, 'mcp_servers.json'),
      JSON.stringify({
        mcpServers: {
          foo: { command: 'node', args: ['-v'] },
          bar: { command: 'python', args: ['--version'] },
        },
      }),
    );

    const servers = loadClaudeMcpServers(root);
    expect(Object.keys(servers).sort()).toEqual(['bar', 'foo']);
    expect((servers.foo as any).command).toBe('node');
  });

  it('returns {} when file is missing or invalid', () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'happier-claude-mcp-missing-'));
    expect(loadClaudeMcpServers(missingRoot)).toEqual({});

    const invalidRoot = mkdtempSync(join(tmpdir(), 'happier-claude-mcp-invalid-'));
    writeFileSync(join(invalidRoot, 'mcp_servers.json'), '{not json');
    expect(loadClaudeMcpServers(invalidRoot)).toEqual({});

    const wrongShapeRoot = mkdtempSync(join(tmpdir(), 'happier-claude-mcp-wrong-shape-'));
    writeFileSync(join(wrongShapeRoot, 'mcp_servers.json'), JSON.stringify({ nope: true }));
    expect(loadClaudeMcpServers(wrongShapeRoot)).toEqual({});
  });
});

describe('loadCodexMcpServers', () => {
  it('parses [mcp_servers.*] sections with command + args', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-codex-mcp-'));
    process.env.CODEX_HOME = root;

    writeFileSync(
      join(root, 'config.toml'),
      [
        '[mcp_servers.foo]',
        'command = "node"',
        'args = ["-e", "console.log(1)"]',
        '',
        '[mcp_servers.bar]',
        'command = "python"',
        'args = ["--version"]',
        '',
      ].join('\n'),
    );

    const servers = loadCodexMcpServers();
    expect(Object.keys(servers).sort()).toEqual(['bar', 'foo']);
    expect((servers.foo as any).command).toBe('node');
    expect((servers.foo as any).args).toEqual(['-e', 'console.log(1)']);
  });

  it('ignores sections without a command', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-codex-mcp-no-command-'));
    process.env.CODEX_HOME = root;

    writeFileSync(
      join(root, 'config.toml'),
      [
        '[mcp_servers.foo]',
        'args = ["--version"]',
        '',
      ].join('\n'),
    );

    expect(loadCodexMcpServers()).toEqual({});
  });

  it('unescapes common TOML escape sequences in command and args', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-codex-mcp-escapes-'));
    process.env.CODEX_HOME = root;

    writeFileSync(
      join(root, 'config.toml'),
      [
        '[mcp_servers.foo]',
        // includes \\ and \" and \n
        'command = "echo\\n\\\"hi\\\"\\\\"',
        'args = ["a\\t", "b\\r"]',
        '',
      ].join('\n'),
    );

    const servers = loadCodexMcpServers();
    expect((servers.foo as any).command).toBe('echo\n"hi"\\');
    expect((servers.foo as any).args).toEqual(['a\t', 'b\r']);
  });

  it('returns {} when file is missing or invalid', () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'happier-codex-mcp-missing-'));
    process.env.CODEX_HOME = missingRoot;
    expect(loadCodexMcpServers()).toEqual({});

    const invalidRoot = mkdtempSync(join(tmpdir(), 'happier-codex-mcp-invalid-'));
    process.env.CODEX_HOME = invalidRoot;
    writeFileSync(join(invalidRoot, 'config.toml'), '[[[ not toml');
    // parser should fail safe
    expect(loadCodexMcpServers()).toEqual({});
  });
});
