import { describe, expect, it } from 'vitest';

import { normalizeAcpSessionMessageBody } from './sessionOutboundMessageNormalization';

describe('normalizeAcpSessionMessageBody', () => {
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
});
