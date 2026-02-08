import { describe, expect, it } from 'vitest';

import { buildCodexMcpStartConfig } from './buildCodexMcpStartConfig';

describe('buildCodexMcpStartConfig (canonical suite)', () => {
  it('builds base config and omits model when not provided', () => {
    const mcpServers = { happy: { command: 'happy', args: [] as string[] } };
    const out = buildCodexMcpStartConfig({
      prompt: 'hi',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers,
    });

    expect(out).toEqual({
      prompt: 'hi',
      sandbox: 'workspace-write',
      'approval-policy': 'untrusted',
      config: { mcp_servers: mcpServers },
    });
    expect(out.model).toBeUndefined();
  });

  it('includes trimmed model when provided', () => {
    const out = buildCodexMcpStartConfig({
      prompt: 'hi',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      model: '  gpt-5-codex-high  ',
    });

    expect(out.model).toBe('gpt-5-codex-high');
  });

  it('omits model when provided as whitespace', () => {
    const out = buildCodexMcpStartConfig({
      prompt: 'hi',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      model: '    ',
    });

    expect(out.model).toBeUndefined();
  });

  it('omits model when provided as null', () => {
    const out = buildCodexMcpStartConfig({
      prompt: 'hi',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      model: null,
    });

    expect(out.model).toBeUndefined();
  });
});
