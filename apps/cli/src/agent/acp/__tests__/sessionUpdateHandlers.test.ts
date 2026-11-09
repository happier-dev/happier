import { describe, expect, it, vi } from 'vitest';

import { DefaultTransport } from '@/agent/transport';
import { createAcpTransportHandlerFromDefinition } from '../runtime/definition/transport';
import type { AgentMessage } from '@/agent/core';
import { normalizeToolCallV2 } from '@/agent/tools/normalization';
import {
  handleToolCall,
  handleToolCallUpdate,
  markToolCallRunningAfterPermission,
  markToolCallWaitingForPermission,
} from '../sessionUpdateHandlers';
import { createLegacyHandlerContextFixture } from './legacyToolRuntimeFixture';
import { resolveCodeBuddyAcpToolName } from '../../../../../../packages/plugins/codebuddy/src/agent/runtime/factory';

describe('legacy ACP session tool handlers', () => {
  it('uses the plugin-resolved input and tool identity together', () => {
    const emitted: AgentMessage[] = [];
    const transport = createAcpTransportHandlerFromDefinition({ backendId: 'fixture', callbacks: {
      toolNameResolver: ({ toolName, input }) => toolName === 'other'
        ? { toolName: 'Bash', input: { command: input.params } }
        : null,
    } });
    const ctx = createLegacyHandlerContextFixture({ transport, emit: message => emitted.push(message) });
    handleToolCall({ sessionUpdate: 'tool_call', toolCallId: 'projected-call', kind: 'other',
      title: 'Native wrapper', rawInput: { params: 'echo projected' } }, ctx);
    expect(emitted.find(message => message.type === 'tool-call')).toMatchObject({
      toolName: 'Bash', args: { command: 'echo projected' },
    });
    handleToolCallUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'projected-call', kind: 'other',
      rawInput: { params: 'echo changed' } }, ctx);
    expect(emitted.filter(message => message.type === 'tool-call').at(-1)).toMatchObject({
      toolName: 'Bash', args: { command: 'echo changed' },
    });
  });

  it('routes create/update/terminal observations through one stable lifecycle identity', () => {
    const emitted: any[] = [];
    const ctx = createLegacyHandlerContextFixture({ emit: (message) => emitted.push(message) });

    handleToolCall({
      sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read', kind: 'read', status: 'pending',
    }, ctx);
    handleToolCallUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress', rawInput: { path: 'a.ts' },
    }, ctx);
    handleToolCallUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: { text: 'ok' },
    }, ctx);

    const calls = emitted.filter((message) => message.type === 'tool-call');
    expect(new Set(calls.map((message) => message.localId)).size).toBe(1);
    expect(calls.at(-1)).toMatchObject({ toolName: 'read', args: { path: 'a.ts' } });
    expect(emitted.filter((message) => message.type === 'tool-result')).toHaveLength(1);
    expect(ctx.toolCalls.activeCalls()).toEqual([]);
  });

  it.each([undefined, null, ''])(
    'does not promote a user-owned deferred wrapper title when the ACP title is %s',
    (title) => {
      const emitted: AgentMessage[] = [];
      const ctx = createLegacyHandlerContextFixture({ emit: (message) => emitted.push(message),
        transport: createAcpTransportHandlerFromDefinition({ backendId: 'fixture',
          callbacks: { toolNameResolver: resolveCodeBuddyAcpToolName } }),
      });
      const rawInput = {
        toolName: 'Bash',
        params: { command: 'echo user-owned-data' },
        _acp: { kind: 'other', title: 'DeferExecuteTool' },
      };

      handleToolCallUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_user_owned_title',
        status: 'completed',
        kind: 'other',
        title,
        rawInput,
      }, ctx);

      const toolCall = emitted.find((message) => message.type === 'tool-call');
      if (toolCall?.type !== 'tool-call') throw new Error('expected tool-call');
      const normalized = normalizeToolCallV2({
        source: { protocol: 'acp', agent: { pluginId: 'happier.agent.codebuddy', localId: 'codebuddy' } },
        toolName: toolCall.toolName,
        rawInput: toolCall.args,
      });
      expect(normalized.canonicalToolName).toBe('other');
      expect(normalized.input).toMatchObject({ toolName: 'Bash', params: rawInput.params });
    },
  );

  it('keeps a permission-gated call running after approval until the real result', () => {
    vi.useFakeTimers();
    try {
      const emitted: AgentMessage[] = [];
      const transport = new DefaultTransport('test');
      const ctx = createLegacyHandlerContextFixture({ transport, emit: (message) => emitted.push(message) });
      ctx.toolCalls.observePermission({ toolCallId: 'permission-call', toolName: 'execute', input: { command: 'pwd' } });
      markToolCallWaitingForPermission('permission-call', ctx);
      handleToolCallUpdate({
        sessionUpdate: 'tool_call_update', toolCallId: 'permission-call', status: 'in_progress',
      }, ctx);
      vi.advanceTimersByTime(20);
      expect(emitted.filter((message) => message.type === 'tool-result')).toHaveLength(0);

      markToolCallRunningAfterPermission('permission-call', ctx);
      vi.advanceTimersByTime(180_000);
      expect(ctx.toolCalls.readCall('permission-call')?.status).toBe('running');
      expect(emitted.filter((message) => message.type === 'tool-result')).toHaveLength(0);

      handleToolCallUpdate({
        sessionUpdate: 'tool_call_update', toolCallId: 'permission-call', status: 'completed',
        rawOutput: { output: '/workspace' },
      }, ctx);
      expect(emitted.filter((message) => message.type === 'tool-result')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves exact opaque ids and provider-owned semantic naming', () => {
    const emitted: any[] = [];
    const transport = new DefaultTransport('test');
    transport.determineToolName = (_name, _id, input) => input.command ? 'execute' : 'other';
    const ctx = createLegacyHandlerContextFixture({ transport, emit: (message) => emitted.push(message) });
    const exactId = ' call\n\0id ';

    handleToolCall({
      sessionUpdate: 'tool_call', toolCallId: exactId, title: 'Command', kind: 'other', rawInput: { command: 'pwd' },
    }, ctx);

    expect(emitted.at(-1)).toMatchObject({ callId: exactId, toolName: 'execute' });
    expect(emitted.at(-1).localId.length).toBeLessThan(200);
  });
});
