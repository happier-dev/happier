import { describe, expect, it, vi } from 'vitest';

import type { HandlerContext, SessionUpdate } from '../sessionUpdateHandlers';
import { handleToolCall, handleToolCallUpdate } from '../sessionUpdateHandlers';
import { DefaultTransport, defaultTransport } from '../../transport';
import { CodexAcpTransport } from '@/backends/codex/acp/transport';
import { GeminiTransport } from '@/backends/gemini/acp/transport';
import { KimiTransport } from '@/backends/kimi/acp/transport';

function createCtx(opts?: { transport?: HandlerContext['transport'] }): HandlerContext & {
  emitted: any[];
  toolCallLifecycleStates: Map<string, string>;
} {
  const emitted: any[] = [];
  return {
    transport: opts?.transport ?? defaultTransport,
    activeToolCalls: new Set(),
    finalizedToolCalls: new Set(),
    toolCallLifecycleStates: new Map(),
    toolCallStartTimes: new Map(),
    toolCallTimeouts: new Map(),
    toolCallIdToNameMap: new Map(),
    toolCallIdToInputMap: new Map(),
    idleTimeout: null,
    recentPromptHadChangeTitle: false,
    toolCallCountSincePrompt: 0,
    emit: (msg) => emitted.push(msg),
    emitIdleStatus: () => emitted.push({ type: 'status', status: 'idle' }),
    clearIdleTimeout: () => {},
    setIdleTimeout: () => {},
    emitted,
  };
}

describe('sessionUpdateHandlers tool call tracking', () => {
  it('does not treat update.title as the tool name', () => {
    const ctx = createCtx();

    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_test_1',
      status: 'in_progress',
      kind: 'execute',
      title: 'Run echo hello',
      content: { command: ['/bin/zsh', '-lc', 'echo hello'] },
    };

    handleToolCall(update, ctx);

    const toolCall = ctx.emitted.find((m) => m.type === 'tool-call');
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe('execute');
    expect(toolCall.args?._acp?.title).toBe('Run echo hello');
  });

  it('passes recent prompt context into tool name resolution for opaque tool calls', () => {
    class ContextAwareTransport extends DefaultTransport {
      override determineToolName(
        toolName: string,
        _toolCallId: string,
        _input: Record<string, unknown>,
        context: { recentPromptHadChangeTitle: boolean; toolCallCountSincePrompt: number },
      ): string {
        if (
          toolName === 'unknown' &&
          context.recentPromptHadChangeTitle &&
          context.toolCallCountSincePrompt === 0
        ) {
          return 'change_title';
        }
        return toolName;
      }
    }

    const ctx = createCtx({ transport: new ContextAwareTransport('ctx-aware') });
    ctx.recentPromptHadChangeTitle = true;

    handleToolCall(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_context_1',
        status: 'in_progress',
      },
      ctx,
    );

    const toolCall = ctx.emitted.find((m) => m.type === 'tool-call' && m.callId === 'call_context_1');
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe('change_title');
  });

  it('attaches minimal _acp metadata and default locations for tool calls that omit input', () => {
    const ctx = createCtx();

    handleToolCall(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_minimal',
        status: 'in_progress',
        kind: 'execute',
      },
      ctx,
    );

    const toolCall = ctx.emitted.find((m) => m.type === 'tool-call' && m.callId === 'call_minimal');
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe('execute');
    expect(toolCall.args).toMatchObject({
      locations: [],
      _acp: { kind: 'execute' },
    });
  });

  it('includes _acp metadata on successful tool results even when output is a primitive', () => {
    const ctx = createCtx();

    handleToolCall(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_primitive_output',
        status: 'in_progress',
        kind: 'execute',
      },
      ctx,
    );

    handleToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_primitive_output',
        status: 'completed',
        kind: 'execute',
        content: 'TRACE_OK\n',
        meta: {},
      },
      ctx,
    );

    const toolResult = ctx.emitted.find(
      (m) => m.type === 'tool-result' && m.callId === 'call_primitive_output',
    );
    expect(toolResult).toBeTruthy();
    expect(toolResult.toolName).toBe('execute');
    expect(toolResult.result).toMatchObject({
      _acp: { kind: 'execute' },
    });
  });

  it('does not start an execution timeout while status is pending, but arms timeout when in_progress arrives', () => {
    vi.useFakeTimers();
    const ctx = createCtx();

    const pendingUpdate: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_test_pending',
      status: 'pending',
      kind: 'read',
      title: 'Read /etc/hosts',
      content: { filePath: '/etc/hosts' },
    };

    handleToolCall(pendingUpdate, ctx);
    expect(ctx.activeToolCalls.has('call_test_pending')).toBe(true);
    expect(ctx.toolCallTimeouts.has('call_test_pending')).toBe(false);

    const inProgressUpdate: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_test_pending',
      status: 'in_progress',
      kind: 'read',
      title: 'Read /etc/hosts',
      content: { filePath: '/etc/hosts' },
      meta: {},
    };

    handleToolCallUpdate(inProgressUpdate, ctx);
    expect(ctx.toolCallTimeouts.has('call_test_pending')).toBe(true);

    vi.useRealTimers();
  });

  it('treats status-less tool_call messages as waiting for permission when lifecycle state is already permission-pending', () => {
    vi.useFakeTimers();
    class ShortTimeoutTransport extends DefaultTransport {
      getToolCallTimeout(): number {
        return 10;
      }
    }

    const ctx = createCtx({
      transport: new ShortTimeoutTransport(defaultTransport.agentName),
    });
    ctx.toolCallLifecycleStates.set('call_waiting_1', 'waiting_for_permission');

    handleToolCall(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_waiting_1',
        kind: 'edit',
        title: 'Edit file',
        content: { filePath: '/tmp/a.txt', oldText: 'a', newText: 'b' },
      },
      ctx,
    );

    expect(ctx.activeToolCalls.has('call_waiting_1')).toBe(true);
    expect(ctx.toolCallTimeouts.has('call_waiting_1')).toBe(false);
    expect(ctx.toolCallLifecycleStates.get('call_waiting_1')).toBe('waiting_for_permission');

    vi.advanceTimersByTime(11);
    const timedOut = ctx.emitted.filter(
      (m) => m.type === 'tool-result' && m.callId === 'call_waiting_1' && m.result?.status === 'timeout',
    );
    expect(timedOut).toHaveLength(0);

    handleToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_waiting_1',
        status: 'in_progress',
        kind: 'edit',
        title: 'Edit file',
        content: { filePath: '/tmp/a.txt', oldText: 'a', newText: 'b' },
        meta: {},
      },
      ctx,
    );

    expect(ctx.toolCallTimeouts.has('call_waiting_1')).toBe(true);
    expect(ctx.toolCallLifecycleStates.get('call_waiting_1')).toBe('running');

    vi.useRealTimers();
  });

  it('infers tool kind/name for terminal tool_call_update events when kind/start are missing (Gemini)', () => {
    vi.useFakeTimers();
    const ctx = createCtx({ transport: new GeminiTransport() });

    const failedUpdate: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read_file-1',
      status: 'failed',
      title: 'Read /etc/hosts',
      locations: [{ path: '/etc/hosts' }],
      content: { filePath: '/etc/hosts' },
      meta: {},
    };

    handleToolCallUpdate(failedUpdate, ctx);

    const toolCall = ctx.emitted.find((m) => m.type === 'tool-call' && m.callId === 'read_file-1');
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe('read');

    const toolResult = ctx.emitted.find((m) => m.type === 'tool-result' && m.callId === 'read_file-1');
    expect(toolResult).toBeTruthy();
    expect(toolResult.toolName).toBe('read');
    expect(toolResult.isError).toBe(true);
    expect(toolResult.result?._acp?.kind).toBe('read');

    expect(ctx.toolCallTimeouts.size).toBe(0);
    vi.useRealTimers();
  });

  it('emits a terminal tool-result error when an in-progress tool call times out', () => {
    vi.useFakeTimers();
    class ShortTimeoutTransport extends DefaultTransport {
      getToolCallTimeout(): number {
        return 10;
      }
    }
    const ctx = createCtx({
      transport: new ShortTimeoutTransport(defaultTransport.agentName),
    });

    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_timeout_1',
      status: 'in_progress',
      kind: 'write',
      title: 'Write file',
      content: { filePath: '/tmp/a.txt', content: 'hi' },
    };

    handleToolCall(update, ctx);

    const toolCall = ctx.emitted.find((m) => m.type === 'tool-call' && m.callId === 'call_timeout_1');
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe('write');

    vi.advanceTimersByTime(11);

    const toolResult = ctx.emitted.find((m) => m.type === 'tool-result' && m.callId === 'call_timeout_1');
    expect(toolResult).toBeTruthy();
    expect(toolResult.toolName).toBe('write');
    expect(toolResult.isError).toBe(true);
    expect(toolResult.result).toMatchObject({ status: 'timeout' });

    vi.useRealTimers();
  });

  it('does not emit duplicate tool results if a terminal tool_call_update arrives after a timeout', () => {
    vi.useFakeTimers();
    class ShortTimeoutTransport extends DefaultTransport {
      getToolCallTimeout(): number {
        return 10;
      }
    }
    const ctx = createCtx({
      transport: new ShortTimeoutTransport(defaultTransport.agentName),
    });

    handleToolCall(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_timeout_2',
        status: 'in_progress',
        kind: 'read',
        title: 'Read /etc/hosts',
        content: { filePath: '/etc/hosts' },
      },
      ctx,
    );

    vi.advanceTimersByTime(11);

    const toolResultsAfterTimeout = ctx.emitted.filter(
      (m) => m.type === 'tool-result' && m.callId === 'call_timeout_2',
    );
    expect(toolResultsAfterTimeout).toHaveLength(1);
    expect(toolResultsAfterTimeout[0].isError).toBe(true);

    handleToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_timeout_2',
        status: 'completed',
        kind: 'read',
        title: 'Read /etc/hosts',
        content: { ok: true },
        meta: {},
      },
      ctx,
    );

    const toolResultsAfterLateTerminal = ctx.emitted.filter(
      (m) => m.type === 'tool-result' && m.callId === 'call_timeout_2',
    );
    expect(toolResultsAfterLateTerminal).toHaveLength(1);

    vi.useRealTimers();
  });

  it('resets tool-call timeout on subsequent in_progress updates (inactivity watchdog)', () => {
    vi.useFakeTimers();
    class ShortTimeoutTransport extends DefaultTransport {
      getToolCallTimeout(): number {
        return 10;
      }
    }
    const ctx = createCtx({
      transport: new ShortTimeoutTransport(defaultTransport.agentName),
    });

    handleToolCall(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_timeout_bump_1',
        status: 'in_progress',
        kind: 'write',
        title: 'Write file',
        content: { filePath: '/tmp/a.txt', content: 'hi' },
      },
      ctx,
    );

    vi.advanceTimersByTime(6);

    // Provider emits another in_progress update while the tool is still running.
    handleToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_timeout_bump_1',
        status: 'in_progress',
        kind: 'write',
        title: 'Write file',
        content: { filePath: '/tmp/a.txt', content: 'hi' },
        meta: {},
      },
      ctx,
    );

    // If we treat the timeout as "inactivity since last update", we should not have timed out yet.
    vi.advanceTimersByTime(6);
    const toolResultsBeforeInactivity = ctx.emitted.filter(
      (m) => m.type === 'tool-result' && m.callId === 'call_timeout_bump_1',
    );
    expect(toolResultsBeforeInactivity).toHaveLength(0);

    // Now exceed inactivity budget after the last in_progress update.
    vi.advanceTimersByTime(5);
    const toolResultsAfterInactivity = ctx.emitted.filter(
      (m) => m.type === 'tool-result' && m.callId === 'call_timeout_bump_1',
    );
    expect(toolResultsAfterInactivity).toHaveLength(1);
    expect(toolResultsAfterInactivity[0].isError).toBe(true);
    expect(toolResultsAfterInactivity[0].result).toMatchObject({ status: 'timeout' });

    vi.useRealTimers();
  });

  it('treats status-less tool_call_update events as in_progress for active tool calls (Codex)', () => {
    vi.useFakeTimers();
    class ShortTimeoutTransport extends DefaultTransport {
      getToolCallTimeout(): number {
        return 10;
      }
    }
    const ctx = createCtx({
      transport: new ShortTimeoutTransport(defaultTransport.agentName),
    });

    handleToolCall(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_timeout_bump_2',
        status: 'in_progress',
        kind: 'execute',
        title: 'Run long command',
        content: { command: ['/bin/zsh', '-lc', 'sleep 30'] },
      },
      ctx,
    );

    vi.advanceTimersByTime(6);

    // Codex ACP can emit tool_call_update events without an explicit status while a tool is running.
    // We should treat these as liveness and bump the inactivity watchdog.
    handleToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_timeout_bump_2',
        kind: 'execute',
        title: 'Run long command',
        content: { command: ['/bin/zsh', '-lc', 'sleep 30'] },
        meta: {},
      },
      ctx,
    );

    // No timeout yet: we bumped liveness at ~t=6ms.
    vi.advanceTimersByTime(6);
    const toolResultsBeforeInactivity = ctx.emitted.filter(
      (m) => m.type === 'tool-result' && m.callId === 'call_timeout_bump_2',
    );
    expect(toolResultsBeforeInactivity).toHaveLength(0);

    // Now exceed inactivity budget after the last status-less update.
    vi.advanceTimersByTime(5);
    const toolResultsAfterInactivity = ctx.emitted.filter(
      (m) => m.type === 'tool-result' && m.callId === 'call_timeout_bump_2',
    );
    expect(toolResultsAfterInactivity).toHaveLength(1);
    expect(toolResultsAfterInactivity[0].isError).toBe(true);
    expect(toolResultsAfterInactivity[0].result).toMatchObject({ status: 'timeout' });

    vi.useRealTimers();
  });

  it('infers tool name from title when ACP tool kind and id are opaque (Kimi)', () => {
    const ctx = createCtx({ transport: new KimiTransport() });

    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'opaque-tool-id',
      status: 'in_progress',
      title: 'ReadFile',
      content: {},
    };

    handleToolCall(update, ctx);

    const toolCall = ctx.emitted.find((m) => m.type === 'tool-call' && m.callId === 'opaque-tool-id');
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe('read');
    expect(ctx.toolCallIdToNameMap.get('opaque-tool-id')).toBe('read');
  });

  it('extracts tool output from update.result when output/rawOutput/content are absent', () => {
    const ctx = createCtx();

    const completedUpdate: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read_file-1',
      status: 'completed',
      kind: 'read',
      title: 'Read /tmp/a.txt',
      // Gemini-style: result may be carried in a non-standard field.
      result: { content: 'hello' },
    };

    handleToolCallUpdate(completedUpdate, ctx);

    const toolResult = ctx.emitted.find((m) => m.type === 'tool-result' && m.callId === 'read_file-1');
    expect(toolResult).toBeTruthy();
    expect(toolResult.result).toMatchObject({ content: 'hello' });
  });

  it('merges existing _acp metadata when attaching ACP fields', () => {
    const ctx = createCtx();

    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_test_1',
      status: 'in_progress',
      kind: 'execute',
      title: 'Run echo hello',
      content: { command: ['/bin/zsh', '-lc', 'echo hello'], _acp: { custom: true } },
    };

    handleToolCall(update, ctx);

    const toolCall = ctx.emitted.find((m) => m.type === 'tool-call');
    expect(toolCall).toBeTruthy();
    expect(toolCall.args?._acp?.custom).toBe(true);

    handleToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_test_1',
        status: 'in_progress',
        kind: 'execute',
        title: 'Run echo hello again',
        content: { command: ['/bin/zsh', '-lc', 'echo hello'], _acp: { custom: true } },
        meta: {},
      },
      ctx,
    );

    const refreshed = ctx.emitted
      .filter((m) => m.type === 'tool-call' && m.callId === 'call_test_1')
      .slice(-1)[0];

    expect(refreshed).toBeTruthy();
    expect(refreshed.args?._acp?.custom).toBe(true);
    expect(refreshed.args?._acp?.kind).toBe('execute');
  });

  it('emits a synthetic tool-call when a terminal tool_call_update arrives first but toolCallId->name was seeded (permission flow)', () => {
    const ctx = createCtx();

    // Simulate permission handler seeding the tool name before any tool_call/tool_call_update in_progress.
    ctx.toolCallIdToNameMap.set('call_perm_1', 'execute');

    const completedUpdate: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_perm_1',
      status: 'completed',
      // Some providers omit kind on terminal tool updates.
      title: 'Terminal',
      content: { output: 'ok' },
      meta: {},
    };

    handleToolCallUpdate(completedUpdate, ctx);

    const toolCall = ctx.emitted.find((m) => m.type === 'tool-call' && m.callId === 'call_perm_1');
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe('execute');

    const toolResult = ctx.emitted.find((m) => m.type === 'tool-result' && m.callId === 'call_perm_1');
    expect(toolResult).toBeTruthy();
    expect(toolResult.toolName).toBe('execute');
  });

  it('backfills tool-call args from cached input when tool_call_update lacks rawInput/content (permission flow)', () => {
    const ctx = createCtx();

    // Simulate permission request seeding real tool input before any tool_call/tool_call_update payload includes it.
    ctx.toolCallIdToNameMap.set('call_perm_args_1', 'execute');
    ctx.toolCallIdToInputMap.set('call_perm_args_1', {
      command: ['/bin/zsh', '-lc', 'echo hi'],
    });

    const pendingUpdate: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_perm_args_1',
      status: 'pending',
      kind: 'execute',
      title: 'Run echo hi',
      meta: {},
      // Intentionally no content/rawInput/input.
    };

    handleToolCallUpdate(pendingUpdate, ctx);

    const toolCall = ctx.emitted.find((m) => m.type === 'tool-call' && m.callId === 'call_perm_args_1');
    expect(toolCall).toBeTruthy();
    expect(toolCall.args).toMatchObject({
      command: ['/bin/zsh', '-lc', 'echo hi'],
    });
  });

  it('re-resolves unknown tool names from a completed update payload and emits the corrected tool name', () => {
    class TitleAwareUnknownTransport extends DefaultTransport {
      override determineToolName(toolName: string, _toolCallId: string, input: Record<string, unknown>): string {
        if (
          toolName === 'unknown' &&
          typeof input.title === 'string' &&
          input.title.trim().length > 0
        ) {
          return 'change_title';
        }
        return toolName;
      }
    }

    const ctx = createCtx({ transport: new TitleAwareUnknownTransport('title-aware-unknown') });

    handleToolCall(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_change_title_missing_kind',
        status: 'in_progress',
      },
      ctx,
    );

    const initialToolCall = ctx.emitted.find(
      (m) => m.type === 'tool-call' && m.callId === 'call_change_title_missing_kind',
    );
    expect(initialToolCall).toBeTruthy();
    expect(initialToolCall.toolName).toBe('unknown');

    handleToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_change_title_missing_kind',
        status: 'completed',
        content: { title: 'QA Tools Check' },
        meta: {},
      },
      ctx,
    );

    const refreshedToolCall = ctx.emitted
      .filter((m) => m.type === 'tool-call' && m.callId === 'call_change_title_missing_kind')
      .slice(-1)[0];
    expect(refreshedToolCall).toBeTruthy();
    expect(refreshedToolCall.toolName).toBe('change_title');

    const toolResult = ctx.emitted.find(
      (m) => m.type === 'tool-result' && m.callId === 'call_change_title_missing_kind',
    );
    expect(toolResult).toBeTruthy();
    expect(toolResult.toolName).toBe('change_title');
    expect(toolResult.result).toMatchObject({
      title: 'QA Tools Check',
      _acp: { kind: 'unknown' },
    });
  });

  it('keeps opaque Codex custom MCP tools out of change_title when ACP only provides a provider tool title wrapper', () => {
    const ctx = createCtx({ transport: new CodexAcpTransport(180_000, 1_000) });

    handleToolCall(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_codex_custom_mcp_1',
        status: 'in_progress',
        title: 'Tool: qa_marker_stdio_20260306/get_marker',
      },
      ctx,
    );

    const toolCall = ctx.emitted.find(
      (m) => m.type === 'tool-call' && m.callId === 'call_codex_custom_mcp_1',
    );
    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe('mcp__qa_marker_stdio_20260306__get_marker');
    expect(ctx.toolCallIdToNameMap.get('call_codex_custom_mcp_1')).toBe(
      'mcp__qa_marker_stdio_20260306__get_marker',
    );
  });
});
