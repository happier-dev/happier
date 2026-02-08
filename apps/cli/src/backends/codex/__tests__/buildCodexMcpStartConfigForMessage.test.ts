import { describe, expect, it } from 'vitest';

import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';

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
      prompt: `Hello\n\n${CHANGE_TITLE_INSTRUCTION}`,
      model: 'gpt-5-codex-high',
    });
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
});
