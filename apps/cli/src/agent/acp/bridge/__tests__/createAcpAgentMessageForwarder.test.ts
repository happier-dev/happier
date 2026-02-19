import { describe, expect, it, vi } from 'vitest';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { createAcpAgentMessageForwarder } from '../createAcpAgentMessageForwarder';

describe('createAcpAgentMessageForwarder', () => {
  it('does not forward event messages', () => {
    const sendAcp = vi.fn();
    const forwarder = createAcpAgentMessageForwarder({
      sendAcp,
      provider: 'claude' as any,
      makeId: () => 'id_1',
    });

    forwarder.forward({ type: 'event', name: 'available_commands_update', payload: {} } as any);

    expect(sendAcp).toHaveBeenCalledTimes(0);
  });

  it('namespaces tool-call ids into a sidechain', () => {
    const sent: ACPMessageData[] = [];
    const sendAcp = vi.fn((_provider: any, body: ACPMessageData) => {
      sent.push(body);
    });

    const forwarder = createAcpAgentMessageForwarder({
      sendAcp,
      provider: 'claude' as any,
      sidechainId: 'call_parent_1',
      makeId: () => 'id_1',
    });

    forwarder.forward({ type: 'tool-call', callId: 'tool_1', toolName: 'read_file', args: { path: 'x' } } as any);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'tool-call',
      callId: 'sc:call_parent_1:tool_1',
      name: 'read_file',
      sidechainId: 'call_parent_1',
    });
  });

  it('emits one synthetic terminal tool-call and reuses its callId', () => {
    const sent: ACPMessageData[] = [];
    const sendAcp = vi.fn((_provider: any, body: ACPMessageData) => {
      sent.push(body);
    });

    const ids = ['id_1', 'id_2', 'id_3'];
    const forwarder = createAcpAgentMessageForwarder({
      sendAcp,
      provider: 'claude' as any,
      sidechainId: 'call_parent_1',
      makeId: () => ids.shift() ?? 'id_x',
    });

    forwarder.forward({ type: 'terminal-output', data: 'hello' } as any);
    forwarder.forward({ type: 'terminal-output', data: 'world' } as any);

    // tool-call + 2 terminal-output messages
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({
      type: 'tool-call',
      name: 'terminal-output',
      callId: 'sc:call_parent_1:happier:terminal-output',
      sidechainId: 'call_parent_1',
    });

    expect(sent[1]).toMatchObject({
      type: 'terminal-output',
      data: 'hello',
      callId: 'sc:call_parent_1:happier:terminal-output',
      sidechainId: 'call_parent_1',
    });

    expect(sent[2]).toMatchObject({
      type: 'terminal-output',
      data: 'world',
      callId: 'sc:call_parent_1:happier:terminal-output',
      sidechainId: 'call_parent_1',
    });
  });

  it('forwards tool-result isError when provided', () => {
    const sent: ACPMessageData[] = [];
    const sendAcp = vi.fn((_provider: any, body: ACPMessageData) => {
      sent.push(body);
    });

    const forwarder = createAcpAgentMessageForwarder({
      sendAcp,
      provider: 'claude' as any,
      makeId: () => 'id_1',
    });

    forwarder.forward({ type: 'tool-result', callId: 'tool_1', toolName: 'read', result: { ok: false }, isError: true } as any);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'tool-result',
      callId: 'tool_1',
      isError: true,
    });
  });

  it('converts think tool calls into ACP thinking messages (suppressing tool-call + tool-result)', () => {
    const sent: ACPMessageData[] = [];
    const sendAcp = vi.fn((_provider: any, body: ACPMessageData) => {
      sent.push(body);
    });

    const forwarder = createAcpAgentMessageForwarder({
      sendAcp,
      provider: 'opencode' as any,
      makeId: () => 'id_1',
    });

    forwarder.forward({ type: 'tool-call', callId: 't1', toolName: 'think', args: { thinking: 'Hello world' } } as any);
    forwarder.forward({ type: 'tool-result', callId: 't1', toolName: 'think', result: { ok: true } } as any);

    expect(sent).toEqual([{ type: 'thinking', text: 'Hello world' }]);
  });
});
