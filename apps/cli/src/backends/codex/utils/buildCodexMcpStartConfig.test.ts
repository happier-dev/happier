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

  it('includes an opaque model identifier without transforming its bytes', () => {
    const out = buildCodexMcpStartConfig({
      prompt: 'hi',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      model: '  gpt-5-codex-high  ',
    });

    expect(out.model).toBe('  gpt-5-codex-high  ');
  });

  it('writes the opaque model_reasoning_effort value without transforming its bytes', () => {
    const out = buildCodexMcpStartConfig({
      prompt: 'hi',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      model: 'gpt-5.5',
      modelReasoningEffort: '  high  ',
    });

    expect(out.config?.model_reasoning_effort).toBe('  high  ');
  });

  it('omits model_reasoning_effort when not provided', () => {
    const out = buildCodexMcpStartConfig({
      prompt: 'hi',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
    });

    expect(out.config?.model_reasoning_effort).toBeUndefined();
  });

  it.each(['auto', 'none', undefined] as const)('applies explicit reasoning summary %s without imposing a default', (reasoningSummary) => {
    const out = buildCodexMcpStartConfig({ prompt: 'hi', mcpServers: {}, ...{ reasoningSummary } });
    if (reasoningSummary === undefined) {
      expect(out.config).not.toHaveProperty('model_reasoning_summary');
    } else {
      expect(out.config?.model_reasoning_summary).toBe(reasoningSummary);
    }
  });

  it('includes cwd when provided', () => {
    const out = buildCodexMcpStartConfig({
      prompt: 'hi',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      cwd: '  /tmp/happier-review-worktree  ',
    });

    expect(out.cwd).toBe('/tmp/happier-review-worktree');
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

  it('omits sandbox + approval-policy when undefined so Codex honors ~/.codex/config.toml', () => {
    const out = buildCodexMcpStartConfig({
      prompt: 'hi',
      mcpServers: {},
      // Neither sandbox nor approvalPolicy provided: happens when Happier resolves to 'default'.
    });

    expect(out).not.toHaveProperty('sandbox');
    expect(out).not.toHaveProperty('approval-policy');
    expect(out.prompt).toBe('hi');
  });

  it('omits sandbox + approval-policy when null so Codex honors ~/.codex/config.toml', () => {
    const out = buildCodexMcpStartConfig({
      prompt: 'hi',
      mcpServers: {},
      sandbox: null,
      approvalPolicy: null,
    });

    expect(out).not.toHaveProperty('sandbox');
    expect(out).not.toHaveProperty('approval-policy');
  });
});
