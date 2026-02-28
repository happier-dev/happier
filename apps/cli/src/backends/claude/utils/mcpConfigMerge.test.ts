import { describe, expect, it } from 'vitest';

import { tryMergeUserMcpConfigArgsIntoHappierMcp } from './mcpConfigMerge';

describe('tryMergeUserMcpConfigArgsIntoHappierMcp', () => {
  it('merges user mcpServers from --mcp-config JSON and keeps base servers as last-write-wins', () => {
    const user = JSON.stringify({
      mcpServers: {
        userOne: { command: 'node', args: ['one'] },
        shared: { command: 'node', args: ['user'] },
      },
    });
    const result = tryMergeUserMcpConfigArgsIntoHappierMcp({
      baseMcpServers: {
        happier: { command: 'node', args: ['happier'] },
        shared: { command: 'node', args: ['base'] },
      },
      claudeArgs: ['--mcp-config', user, '--max-turns', '3'],
    });

    expect(result).toBeTruthy();
    expect(result?.filteredClaudeArgs).toEqual(['--max-turns', '3']);
    expect(result?.mergedMcpServers).toMatchObject({
      userOne: expect.anything(),
      happier: expect.anything(),
      shared: { command: 'node', args: ['base'] },
    });
  });

  it('rejects configs that include forbidden server names', () => {
    const bad = '{"mcpServers":{"__proto__":{"type":"http","url":"http://127.0.0.1:1"}}}';
    const result = tryMergeUserMcpConfigArgsIntoHappierMcp({
      baseMcpServers: {},
      claudeArgs: ['--mcp-config', bad],
    });
    expect(result).toBeNull();
  });
});
