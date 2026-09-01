import { describe, expect, it, vi } from 'vitest';

import { createClaudePermissionHookHandler } from './permissionHookHandler.js';

describe('createClaudePermissionHookHandler Agent tool interception', () => {
  it('feeds one transformed provider-native input into the existing permission engine', async () => {
    const before = vi.fn(async () => ({
      status: 'continue' as const,
      input: { command: 'pwd', intercepted: true },
    }));
    const requestDecision = vi.fn(async () => ({ decision: 'approved' }));
    const handler = createClaudePermissionHookHandler({
      agentRuntime: { toolExecution: { before } },
      sessions: { current: { permissions: { requestDecision } } },
    } as never);

    const response = await handler({
      hook_event_name: 'PreToolUse',
      session_id: 'provider-session-1',
      tool_name: 'Bash',
      tool_use_id: 'call-1',
      tool_input: { command: 'pwd' },
    });

    expect(before).toHaveBeenCalledOnce();
    expect(before).toHaveBeenCalledWith({
      callId: 'call-1',
      name: 'Bash',
      input: { command: 'pwd' },
    });
    expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 'call-1',
      input: { command: 'pwd', intercepted: true },
    }), expect.any(Object));
    expect(response.hookSpecificOutput?.decision).toEqual(expect.objectContaining({
      behavior: 'allow',
      updatedInput: { command: 'pwd', intercepted: true },
    }));
  });

  it('maps an explicit interception rejection to the existing provider-native denial', async () => {
    const requestDecision = vi.fn(async () => ({ decision: 'approved' }));
    const handler = createClaudePermissionHookHandler({
      agentRuntime: {
        toolExecution: {
          before: vi.fn(async () => ({
            status: 'rejected' as const,
            code: 'plugin_policy_denied',
            message: 'Denied by plugin policy',
          })),
        },
      },
      sessions: { current: { permissions: { requestDecision } } },
    } as never);

    const response = await handler({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'call-2',
      tool_input: { command: 'rm -rf build' },
    });

    expect(requestDecision).not.toHaveBeenCalled();
    expect(response.hookSpecificOutput?.decision).toEqual({
      behavior: 'deny',
      message: 'Denied by plugin policy',
      interrupt: true,
    });
  });
});
