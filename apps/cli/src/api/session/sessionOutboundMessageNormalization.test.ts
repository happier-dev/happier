import { describe, expect, it, vi } from 'vitest';

import {
  normalizeAcpSessionMessageBody,
  normalizeCodexSessionMessageBody,
} from './sessionOutboundMessageNormalization';

describe('normalizeAcpSessionMessageBody', () => {
  it('projects a failed title Action as a typed error instead of treating a JSON key as the title', () => {
    const caches = {
      toolCallCanonicalNameByProviderAndId: new Map<string, { rawToolName: string; canonicalToolName: string }>(),
      permissionToolCallRawInputByProviderAndId: new Map<string, unknown>(),
      toolCallInputByProviderAndId: new Map<string, unknown>(),
    };
    normalizeAcpSessionMessageBody({ ...caches, provider: 'claude', body: {
      type: 'tool-call', callId: 'title', name: 'mcp__happier__change_title',
      input: { title: 'Explore project directory' }, id: 'title-call',
    } });
    const failure = JSON.stringify({ errorCode: 'change_title_failed', error: 'target_unavailable' });
    const result = normalizeAcpSessionMessageBody({ ...caches, provider: 'claude', body: {
      type: 'tool-result', callId: 'title', id: 'title-result', isError: true,
      output: { content: failure, tool_use_result: `Error: ${failure}` },
    } });
    if (result.type !== 'tool-result') throw new Error('expected tool-result');
    expect(result.isError).toBe(true);
    expect(result.output).toMatchObject({ success: false, errorCode: 'change_title_failed', errorMessage: 'target_unavailable' });
    expect(result.output).not.toHaveProperty('title');
    expect(result.output).not.toHaveProperty('content');
    expect(result.output).not.toHaveProperty('tool_use_result');
  });

  it.each([
    { content: '/workspace/package.json\n', isError: false },
    { content: 'Exit code 127\nls: command not found', isError: true },
  ])('retains native shell report text in the canonical streams ($isError)', ({ content, isError }) => {
    const caches = {
      toolCallCanonicalNameByProviderAndId: new Map<string, { rawToolName: string; canonicalToolName: string }>(),
      permissionToolCallRawInputByProviderAndId: new Map<string, unknown>(),
      toolCallInputByProviderAndId: new Map<string, unknown>(),
    };
    normalizeAcpSessionMessageBody({ ...caches, provider: 'claude', body: {
      type: 'tool-call', callId: 'shell', name: 'Bash', input: { command: 'find /workspace -type f' }, id: 'shell-call',
    } });
    const result = normalizeAcpSessionMessageBody({ ...caches, provider: 'claude', body: {
      type: 'tool-result', callId: 'shell', id: 'shell-result', isError,
      output: { content, tool_use_result: isError ? `Error: ${content}` : { stdout: content, stderr: '' } },
    } });
    if (result.type !== 'tool-result') throw new Error('expected tool-result');
    expect(result.output).toMatchObject({ stdout: content });
  });

  it('diagnoses an unmatched Codex tool result at the normalization owner', () => {
    const debug = vi.fn();

    normalizeCodexSessionMessageBody({
      body: { type: 'tool-call-result', callId: 'call-missing', output: { stdout: 'x' }, id: 'msg-1' },
      toolCallCanonicalNameByProviderAndId: new Map(),
      debug,
    });

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('tool-call-result without prior tool-call'),
      expect.objectContaining({ callId: 'call-missing' }),
    );
  });

  it('ensures ACP tool-call input includes opaque _acp and locations keys (even when provider omits them)', () => {
    const toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    const permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    const toolCallInputByProviderAndId = new Map<string, unknown>();

    const normalized = normalizeAcpSessionMessageBody({
      provider: 'opencode',
      body: { type: 'tool-call', callId: 'call_1', name: 'bash', input: {}, id: 'msg_1' },
      toolCallCanonicalNameByProviderAndId,
      permissionToolCallRawInputByProviderAndId,
      toolCallInputByProviderAndId,
    });

    expect(normalized.type).toBe('tool-call');
    if (normalized.type !== 'tool-call') throw new Error('expected tool-call');
    expect(normalized.name).toBe('Bash');
    expect(normalized.input).toMatchObject({
      locations: [],
      _acp: expect.anything(),
      _happier: expect.objectContaining({
        protocol: 'acp',
        provider: 'opencode',
        rawToolName: 'bash',
        canonicalToolName: 'Bash',
      }),
    });
  });

  it('ensures ACP tool-result output includes opaque _acp key (even when provider omits it)', () => {
    const toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    const permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    const toolCallInputByProviderAndId = new Map<string, unknown>();

    normalizeAcpSessionMessageBody({
      provider: 'opencode',
      body: { type: 'tool-call', callId: 'call_1', name: 'bash', input: {}, id: 'msg_1' },
      toolCallCanonicalNameByProviderAndId,
      permissionToolCallRawInputByProviderAndId,
      toolCallInputByProviderAndId,
    });

    const normalized = normalizeAcpSessionMessageBody({
      provider: 'opencode',
      body: {
        type: 'tool-result',
        callId: 'call_1',
        output: {
          output: 'TRACE_OK\n',
          title: 'Echo TRACE_OK',
          metadata: { output: 'TRACE_OK\n', exit: 0, description: 'Echo TRACE_OK', truncated: false },
        },
        id: 'msg_2',
      } as any,
      toolCallCanonicalNameByProviderAndId,
      permissionToolCallRawInputByProviderAndId,
      toolCallInputByProviderAndId,
    });

    expect(normalized.type).toBe('tool-result');
    if (normalized.type !== 'tool-result') throw new Error('expected tool-result');
    expect(normalized.output).toMatchObject({
      _acp: expect.anything(),
      _happier: expect.objectContaining({
        protocol: 'acp',
        provider: 'opencode',
        rawToolName: 'bash',
        canonicalToolName: 'Bash',
      }),
    });
  });

  it('marks bash tool results as errors when the normalized exit code is non-zero', () => {
    const toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    const permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    const toolCallInputByProviderAndId = new Map<string, unknown>();

    normalizeAcpSessionMessageBody({
      provider: 'copilot',
      body: {
        type: 'tool-call',
        callId: 'call_1',
        name: 'bash',
        input: {
          command: `happier tools call --source happier --tool change_title --args-json '{"title":"QA"}' --json`,
        },
        id: 'msg_1',
      } as any,
      toolCallCanonicalNameByProviderAndId,
      permissionToolCallRawInputByProviderAndId,
      toolCallInputByProviderAndId,
    });

    const normalized = normalizeAcpSessionMessageBody({
      provider: 'copilot',
      body: {
        type: 'tool-result',
        callId: 'call_1',
        output: {
          stdout: 'SyntaxError: missing export\n<exited with exit code 1>',
          exit_code: 1,
        },
        id: 'msg_2',
      } as any,
      toolCallCanonicalNameByProviderAndId,
      permissionToolCallRawInputByProviderAndId,
      toolCallInputByProviderAndId,
    });

    expect(normalized.type).toBe('tool-result');
    if (normalized.type !== 'tool-result') throw new Error('expected tool-result');
    expect(normalized.isError).toBe(true);
    expect(normalized.output).toMatchObject({
      exit_code: 1,
      errorMessage: 'SyntaxError: missing export\n<exited with exit code 1>',
      _happier: expect.objectContaining({
        canonicalToolName: 'change_title',
      }),
    });
  });
});
