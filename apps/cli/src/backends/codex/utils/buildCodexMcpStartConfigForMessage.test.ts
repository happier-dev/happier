import { describe, expect, it } from 'vitest';

import { buildCodexMcpStartConfigForMessage } from '../utils/buildCodexMcpStartConfigForMessage';

describe('buildCodexMcpStartConfigForMessage', () => {
  it('threads model override into the start config', () => {
    const config = buildCodexMcpStartConfigForMessage({
      message: 'Hello',
      first: true,
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      mode: { model: 'gpt-5-codex-high' },
    });

    expect(config).toMatchObject({
      prompt: 'Hello',
      model: 'gpt-5-codex-high',
    });
    expect(Object.prototype.hasOwnProperty.call(config, 'base-instructions')).toBe(false);
  });

  it('uses the resolved system prompt as base-instructions when provided', () => {
    const config = buildCodexMcpStartConfigForMessage({
      message: 'Hello',
      first: true,
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      mode: {},
      systemPromptText: 'SYSTEM',
    });

    expect(config).toMatchObject({
      prompt: 'Hello',
      'base-instructions': 'SYSTEM',
    });
  });

  it('omits base-instructions when the resolved system prompt is absent', () => {
    const config = buildCodexMcpStartConfigForMessage({
      message: 'Hello',
      first: true,
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      mode: {},
      systemPromptText: undefined,
    });

    expect(Object.prototype.hasOwnProperty.call(config, 'base-instructions')).toBe(false);
  });

  it('does not append title instruction for non-first messages', () => {
    const config = buildCodexMcpStartConfigForMessage({
      message: 'Hello',
      first: false,
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      mode: {},
    });

    expect(config.prompt).toBe('Hello');
    expect(config['base-instructions']).toBeUndefined();
  });

  it('omits model when mode.model is nullish or whitespace', () => {
    const nullModel = buildCodexMcpStartConfigForMessage({
      message: 'Hello',
      first: true,
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      mode: { model: null },
    });

    const whitespaceModel = buildCodexMcpStartConfigForMessage({
      message: 'Hello',
      first: true,
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      mode: { model: '   ' },
    });

    expect(nullModel.model).toBeUndefined();
    expect(whitespaceModel.model).toBeUndefined();
  });

  it('threads the resolved workspace directory into the start config', () => {
    const config = buildCodexMcpStartConfigForMessage({
      message: 'Hello',
      first: true,
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
      mcpServers: {},
      mode: {},
      cwd: '/repo',
    });

    expect(config.cwd).toBe('/repo');
  });
});
