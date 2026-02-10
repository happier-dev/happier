import { describe, expect, it, vi } from 'vitest';

import type { AgentMessage, ToolCallMessage, ToolResultMessage } from '@/agent/core/AgentMessage';
import { createAcpRuntime, type AcpRuntimeBackend } from '../createAcpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  createApprovedPermissionHandler,
  createDeferred,
  createFakeAcpRuntimeBackend,
  createSessionClientWithMetadata,
} from '../createAcpRuntime.testkit';

describe('createAcpRuntime (sidechain import)', () => {
  it('imports Task sub-session replay as sidechain messages when tool-result includes sessionId metadata', async () => {
    const mainBackend = createFakeAcpRuntimeBackend();
    const replayBackend = createFakeAcpRuntimeBackend();
    replayBackend.loadSessionWithReplayCapture = async (_id: string) => ({
      sessionId: 'ses_123',
      replay: [
        { type: 'message', role: 'agent', text: 'SUBTASK says hello' },
        { type: 'tool_call', toolCallId: 't1', kind: 'execute', rawInput: { command: 'echo hi' } },
        { type: 'tool_result', toolCallId: 't1', status: 'success', rawOutput: { stdout: 'hi' } },
      ],
    });

    const importedSidechain = createDeferred<void>();
    const { session, committed } = createSessionClientWithMetadata({
      onSendAgentMessageCommitted: (body) => {
        if (body.sidechainId === 'tool_task_1') importedSidechain.resolve(undefined);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => mainBackend,
      createReplayBackend: async () => replayBackend,
    });

    await runtime.startOrLoad({ resumeId: null });

    // Simulate Task tool-call and tool-result coming from the main ACP backend.
    const taskCall: ToolCallMessage = { type: 'tool-call', toolName: 'Task', args: { prompt: 'do work' }, callId: 'tool_task_1' };
    mainBackend.emit(taskCall);
    const taskResult: ToolResultMessage = {
      type: 'tool-result',
      toolName: 'Task',
      callId: 'tool_task_1',
      result: { output: 'SUBTASK_OK', metadata: { sessionId: 'ses_123' } },
    };
    mainBackend.emit(taskResult);

    await importedSidechain.promise;
    expect(committed.some((body) => body.sidechainId === 'tool_task_1')).toBe(true);
  });

  it('falls back to importing Task output as a sidechain message when replay capture is empty', async () => {
    const mainBackend = createFakeAcpRuntimeBackend();
    const replayBackend = createFakeAcpRuntimeBackend();
    replayBackend.loadSessionWithReplayCapture = async (_id: string) => ({ sessionId: 'ses_123', replay: [] });

    const importedSidechain = createDeferred<void>();
    const { session, committed } = createSessionClientWithMetadata({
      onSendAgentMessageCommitted: (body) => {
        if (body.sidechainId === 'tool_task_1' && body.type === 'message') importedSidechain.resolve(undefined);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => mainBackend,
      createReplayBackend: async () => replayBackend,
    });

    await runtime.startOrLoad({ resumeId: null });

    const taskCall: ToolCallMessage = { type: 'tool-call', toolName: 'Task', args: { prompt: 'do work' }, callId: 'tool_task_1' };
    mainBackend.emit(taskCall);
    const taskResult: ToolResultMessage = {
      type: 'tool-result',
      toolName: 'Task',
      callId: 'tool_task_1',
      result: { output: 'SUBTASK_OK', metadata: { sessionId: 'ses_123' } },
    };
    mainBackend.emit(taskResult);

    await importedSidechain.promise;
    expect(committed.some((body) => body.sidechainId === 'tool_task_1' && body.type === 'message')).toBe(true);
  });

  it('falls back to importing Task output as a sidechain message when replay capture throws', async () => {
    const mainBackend = createFakeAcpRuntimeBackend();
    const replayBackend = createFakeAcpRuntimeBackend();
    replayBackend.loadSessionWithReplayCapture = async (_id: string) => {
      throw new Error('Replay not supported');
    };

    const importedSidechain = createDeferred<void>();
    const { session, committed } = createSessionClientWithMetadata({
      onSendAgentMessageCommitted: (body) => {
        if (body.sidechainId === 'tool_task_1' && body.type === 'message') importedSidechain.resolve(undefined);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => mainBackend,
      createReplayBackend: async () => replayBackend,
    });

    await runtime.startOrLoad({ resumeId: null });

    const taskCall: ToolCallMessage = { type: 'tool-call', toolName: 'Task', args: { prompt: 'do work' }, callId: 'tool_task_1' };
    mainBackend.emit(taskCall);
    const taskResult: ToolResultMessage = {
      type: 'tool-result',
      toolName: 'Task',
      callId: 'tool_task_1',
      result: { output: 'SUBTASK_OK', metadata: { sessionId: 'ses_123' } },
    };
    mainBackend.emit(taskResult);

    await importedSidechain.promise;
    expect(committed.some((body) => body.sidechainId === 'tool_task_1' && body.type === 'message')).toBe(true);
  });

  it('evicts tool-call name cache when maxEntries is exceeded', async () => {
    const mainBackend = createFakeAcpRuntimeBackend();
    const replayBackend = createFakeAcpRuntimeBackend();

    let replayLoadCount = 0;
    replayBackend.loadSessionWithReplayCapture = async (_id: string) => {
      replayLoadCount += 1;
      return {
        sessionId: 'ses_123',
        replay: [
          { type: 'message', role: 'agent', text: 'SUBTASK says hello' },
        ],
      };
    };

    const { session, committed } = createSessionClientWithMetadata();
    const createReplayBackend = vi.fn(async () => replayBackend);

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => mainBackend,
      createReplayBackend,
      toolCallCache: { maxEntries: 1, ttlMs: 60_000 },
    });

    await runtime.startOrLoad({ resumeId: null });

    // Record a Task tool-call, then push another tool-call to evict it from the bounded cache.
    mainBackend.emit({ type: 'tool-call', toolName: 'Task', args: { prompt: 'do work' }, callId: 'tool_task_old' });
    mainBackend.emit({ type: 'tool-call', toolName: 'OtherTool', args: { foo: 'bar' }, callId: 'tool_other_new' });

    // Now emit a tool-result for the evicted callId, with a non-Task toolName.
    // If eviction happened, origin toolName should *not* resolve to Task and sidechain import should not run.
    mainBackend.emit({
      type: 'tool-result',
      toolName: '???',
      callId: 'tool_task_old',
      result: { output: 'SUBTASK_OK', metadata: { sessionId: 'ses_123' } },
    });

    expect(createReplayBackend).not.toHaveBeenCalled();
    expect(replayLoadCount).toBe(0);
    expect(committed.some((b) => b.sidechainId === 'tool_task_old')).toBe(false);
  });

  it('clears tool-call name cache on cancel to avoid leaking callIds', async () => {
    const mainBackend = createFakeAcpRuntimeBackend();
    const replayBackend = createFakeAcpRuntimeBackend();

    let replayLoadCount = 0;
    replayBackend.loadSessionWithReplayCapture = async (_id: string) => {
      replayLoadCount += 1;
      return {
        sessionId: 'ses_123',
        replay: [
          { type: 'message', role: 'agent', text: 'SUBTASK says hello' },
        ],
      };
    };

    const { session, committed } = createSessionClientWithMetadata();
    const createReplayBackend = vi.fn(async () => replayBackend);

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => mainBackend,
      createReplayBackend,
      toolCallCache: { maxEntries: 100, ttlMs: 60_000 },
    });

    await runtime.startOrLoad({ resumeId: null });

    mainBackend.emit({ type: 'tool-call', toolName: 'Task', args: { prompt: 'do work' }, callId: 'tool_task_1' });

    await runtime.cancel();

    mainBackend.emit({
      type: 'tool-result',
      toolName: '???',
      callId: 'tool_task_1',
      result: { output: 'SUBTASK_OK', metadata: { sessionId: 'ses_123' } },
    });

    expect(createReplayBackend).not.toHaveBeenCalled();
    expect(replayLoadCount).toBe(0);
    expect(committed.some((b) => b.sidechainId === 'tool_task_1')).toBe(false);
  });
});
