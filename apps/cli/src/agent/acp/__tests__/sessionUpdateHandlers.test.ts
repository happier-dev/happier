import { describe, expect, it, vi } from 'vitest';

import type { HandlerContext, SessionUpdate } from '../sessionUpdateHandlers';
import { handleToolCall, handleToolCallUpdate } from '../sessionUpdateHandlers';
import { DefaultTransport, defaultTransport } from '../../transport';
import { GeminiTransport } from '@/backends/gemini/acp/transport';
import { KimiTransport } from '@/backends/kimi/acp/transport';

function createCtx(opts?: { transport?: HandlerContext['transport'] }): HandlerContext & { emitted: any[] } {
  const emitted: any[] = [];
  return {
    transport: opts?.transport ?? defaultTransport,
    activeToolCalls: new Set(),
    finalizedToolCalls: new Set(),
    toolCallStartTimes: new Map(),
    toolCallTimeouts: new Map(),
    toolCallIdToNameMap: new Map(),
    toolCallIdToInputMap: new Map(),
    idleTimeout: null,
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
});
