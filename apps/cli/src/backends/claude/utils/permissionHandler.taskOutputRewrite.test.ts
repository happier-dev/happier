import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SDKAssistantMessage, SDKUserMessage } from '../sdk';
import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';
import { reloadConfiguration } from '@/configuration';

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

function taskToolUseMessage(): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool_task_1', name: 'Task', input: { prompt: 'do work' } }],
    },
  };
}

function taskToolResultMessage(content: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool_task_1', content }],
    },
  };
}

function taskOutputToolUseMessage(input: Record<string, unknown>): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool_taskoutput_1', name: 'TaskOutput', input }],
    },
  };
}

const defaultMode = { permissionMode: 'default' } as EnhancedMode;

describe('PermissionHandler (TaskOutput rewrite)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HAPPIER_STACK_TOOL_TRACE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_DIR;
    delete process.env.HAPPIER_CLAUDE_TASK_ALLOW_RUN_IN_BACKGROUND;
    reloadConfiguration();
  });

  it('rewrites TaskOutput task_id from Task tool_result taskId -> agentId mapping', async () => {
    const { session } = createPermissionHandlerSessionStub('s1');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(taskToolUseMessage());
    handler.onMessage(taskToolResultMessage('agentId: aa5e728\ntask_id: b072e5e'));

    const taskOutputInput = { task_id: 'b072e5e', block: true };
    handler.onMessage(taskOutputToolUseMessage(taskOutputInput));

    const resultPromise = handler.handleToolCall('TaskOutput', taskOutputInput, defaultMode, {
      signal: new AbortController().signal,
    });

    handler.approveToolCall('tool_taskoutput_1');
    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { task_id: 'aa5e728', block: true },
    });
  });

  it('forces Task tool run_in_background=false by default (prevents async subagent launches)', async () => {
    const { session } = createPermissionHandlerSessionStub('s1');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const taskInput = { prompt: 'do work', run_in_background: true };
    handler.onMessage({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_task_1', name: 'Task', input: taskInput }],
      },
    });

    const resultPromise = handler.handleToolCall('Task', taskInput, defaultMode, {
      signal: new AbortController().signal,
    });

    handler.approveToolCall('tool_task_1');
    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { prompt: 'do work', run_in_background: false },
    });
  });
});
