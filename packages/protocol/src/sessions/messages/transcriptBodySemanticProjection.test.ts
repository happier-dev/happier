import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

describe('projectTranscriptBodySearchableText', () => {
  it('retains correlation evidence for native tool sends and accepted results without treating them as assistant text', () => {
    expect(protocol.projectTranscriptBodySemanticContent({ role: 'agent', content: {
      type: 'codex', data: { type: 'tool-call', callId: 'send-1', name: 'session_message_send', input: { sessionId: 'lead', message: 'final' } },
    } })).toMatchObject({ semanticRole: 'tool', toolCalls: [{ callId: 'send-1', name: 'session_message_send', input: { sessionId: 'lead', message: 'final' } }] });
    expect(protocol.projectTranscriptBodySemanticContent({ role: 'agent', content: {
      type: 'output', data: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'send-1', content: [{ type: 'text', text: '{"ok":true,"result":{"status":"accepted","localId":"input-1"}}' }] }] } },
    } })).toMatchObject({ semanticRole: 'tool', toolResults: [{ callId: 'send-1', isError: false }] });
  });
  it('retains failed Claude result correlation when the durable shell has no output body', () => {
    const content = {
      type: 'output',
      data: {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cli-1', is_error: true }] },
      },
    };
    expect(protocol.projectTranscriptBodySemanticContent({ role: 'agent', content })).toMatchObject({
      semanticRole: 'tool',
      kind: 'tool_result',
      toolResults: [{ callId: 'cli-1', isError: true }],
    });
  });

  it('projects protocol-valid ACP tool-result content that transcript readers expose', () => {
    expect(protocol.projectTranscriptBodySearchableText({
      role: 'agent',
      content: {
        type: 'acp',
        agentId: 'opencode',
        data: {
          type: 'tool-result',
          callId: 'call-1',
          id: 'tool-result-1',
          output: [{ type: 'text', text: 'protocol visible tool evidence' }],
        },
      },
    })).toBe('Tool result: protocol visible tool evidence');
  });

  it('projects output-wrapper assistant text and ignores unsupported system text', () => {
    expect(protocol.projectTranscriptBodySearchableText({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'nested assistant text' }],
          },
        },
      },
    })).toBe('nested assistant text');
    expect(protocol.projectTranscriptBodySearchableText({
      role: 'agent',
      content: { type: 'acp', data: { type: 'text', role: 'system', text: 'hidden system prompt' } },
    })).toBe('');
  });
});
