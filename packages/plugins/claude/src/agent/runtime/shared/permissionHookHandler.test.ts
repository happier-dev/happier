import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agents/runtime';

import { createClaudePermissionHookHandler } from './permissionHookHandler.js';
import type { PermissionHookData, SessionHookData } from '../../hooks/protocol.js';

describe('Claude permission hook delivery', () => {
  const nativeLocations = { question: 'app_and_terminal', permission: 'app_and_terminal' } as const;
  const question: PermissionHookData = {
    hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_exact_question',
    tool_input: { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Blue' }], multiSelect: false }] },
  };

  function fixture(overrides: Partial<NonNullable<Parameters<typeof createClaudePermissionHookHandler>[1]>> = {}) {
    const nativePrompts: SessionHookData[] = [];
    const lifecycle: SessionHookData[] = [];
    const requestDecision = vi.fn(async () => ({ decision: 'approved' as const }));
    const before = vi.fn<AgentSessionHostServices['toolExecution']['before']>(async (request) => ({
      status: 'continue' as const, input: request.input,
    }));
    const handler = createClaudePermissionHookHandler({
      agentRuntime: { toolExecution: { before } },
      sessions: { current: { permissions: { requestDecision } } },
    }, {
      unifiedTerminalActive: true,
      responseLocations: nativeLocations,
      onNativePrompt: data => { nativePrompts.push(data); },
      onPermissionLifecycle: data => { lifecycle.push(data); },
      ...overrides,
    });
    return { handler, nativePrompts, lifecycle, requestDecision, before };
  }

  it.each(['app_and_terminal', 'terminal_only'] as const)('returns native questions immediately for %s after host interception', async (location) => {
    const f = fixture({ responseLocations: { question: location, permission: 'app_only' } });
    const transformedInput = { ...question.tool_input as Record<string, unknown>, intercepted: true };
    f.before.mockResolvedValueOnce({ status: 'continue', input: transformedInput });
    const response = await f.handler(question);

    expect(response.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', updatedInput: transformedInput });
    expect(f.nativePrompts).toEqual([{
      ...question, tool_input: transformedInput, toolInput: transformedInput,
      hook_event_name: 'ClaudeNativePrompt', hookEventName: 'ClaudeNativePrompt', happierResponseLocation: location,
    }]);
    expect(f.requestDecision).not.toHaveBeenCalled();
    expect(f.lifecycle).toEqual([]);
  });

  it('uses the independent native permission location and does not emit duplicate native questions', async () => {
    const f = fixture({ responseLocations: { question: 'app_and_terminal', permission: 'terminal_only' } });
    const data = { hookEventName: 'PermissionRequest', toolName: 'Bash', toolUseId: 'toolu_exact_permission', toolInput: { command: 'pwd' } };
    await expect(f.handler(data)).resolves.toMatchObject({ hookSpecificOutput: { hookEventName: 'PermissionRequest' } });
    await f.handler({ ...question, hook_event_name: 'PermissionRequest' });
    expect(f.nativePrompts).toEqual([expect.objectContaining({
      hook_event_name: 'ClaudeNativePrompt', toolUseId: 'toolu_exact_permission', happierResponseLocation: 'terminal_only',
    })]);
    expect(f.requestDecision).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'app only', ingress: { responseLocations: { question: 'app_only', permission: 'app_only' } as const }, data: question },
    { name: 'headless', ingress: { unifiedTerminalActive: false }, data: question },
    { name: 'subagent', ingress: {}, data: { ...question, agent_id: 'child' } },
    { name: 'terminal-only subagent', ingress: { responseLocations: { question: 'terminal_only', permission: 'terminal_only' } as const }, data: { ...question, agentId: 'child' } },
    { name: 'confined', ingress: { unlistedTools: 'deny' as const }, data: { ...question, tool_name: 'Read', tool_input: { file_path: '/secret' } } },
  ])('retains the permission authority for $name', async ({ ingress, data }) => {
    const f = fixture(ingress);
    await expect(f.handler(data)).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(f.nativePrompts).toEqual([]);
    expect(f.requestDecision).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'toolu_exact_question' }), expect.any(Object));
    expect(f.lifecycle.map(row => row.hook_event_name)).toEqual(['PermissionRequest', 'PermissionRequestCompleted']);
  });

  it('never exposes a native prompt when host tool interception rejects it', async () => {
    const f = fixture();
    // The host boundary can reject an otherwise well-formed Claude native tool.
    f.before.mockResolvedValueOnce({ status: 'rejected', code: 'policy_denied', message: 'Denied by host' });
    await expect(f.handler(question)).resolves.toMatchObject({ hookSpecificOutput: {
      decision: { behavior: 'deny', message: 'Denied by host' },
    } });
    expect(f.nativePrompts).toEqual([]);
    expect(f.requestDecision).not.toHaveBeenCalled();
  });

  it('retains the permission authority when a PermissionRequest input was rewritten by host interception', async () => {
    const f = fixture();
    f.before.mockResolvedValueOnce({ status: 'continue', input: { command: 'safe replacement' } });
    const response = await f.handler({ hook_event_name: 'PermissionRequest', tool_name: 'Bash',
      tool_use_id: 'intercepted-permission', tool_input: { command: 'original' } });
    expect(f.nativePrompts).toEqual([]);
    expect(f.requestDecision).toHaveBeenCalledWith(expect.objectContaining({ input: { command: 'safe replacement' } }), expect.any(Object));
    expect(response.hookSpecificOutput?.decision).toEqual({ behavior: 'allow', updatedInput: { command: 'safe replacement' } });
  });

  it('completes app permission lifecycle when its decision fails', async () => {
    const f = fixture({ responseLocations: { question: 'app_only', permission: 'app_only' } });
    f.requestDecision.mockRejectedValueOnce(new Error('permission unavailable'));
    await expect(f.handler(question)).rejects.toThrow('permission unavailable');
    expect(f.lifecycle.map(row => row.hook_event_name)).toEqual(['PermissionRequest', 'PermissionRequestCompleted']);
  });
});

describe('createClaudePermissionHookHandler Agent tool interception', () => {
  it.each(['PreToolUse', 'PermissionRequest'] as const)('preserves a transformed provider-native input through %s', async (hookEventName) => {
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
      hook_event_name: hookEventName,
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

  it('approves unchanged PermissionRequest input without a rewrite while retaining permission updates', async () => {
    const originalInput = { command: 'pwd', options: { paths: ['a', 'b'], verbose: false } };
    const approvedInput = { options: { verbose: false, paths: ['a', 'b'] }, command: 'pwd' };
    // Host JSON boundaries may return null-prototype records with different property order.
    Object.setPrototypeOf(approvedInput, null);
    Object.setPrototypeOf(approvedInput.options, null);
    const updatedPermissions = [{ type: 'setMode', mode: 'default' }];
    const handler = createClaudePermissionHookHandler({
      agentRuntime: { toolExecution: { before: async (request) => ({ status: 'continue', input: request.input }) } },
      sessions: { current: { permissions: {
        requestDecision: async () => ({ decision: 'approved', updatedInput: approvedInput, updatedPermissions }),
      } } },
    });

    const response = await handler({
      hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'original-call',
      tool_input: originalInput,
    });

    expect(response.hookSpecificOutput?.decision).toEqual({ behavior: 'allow', updatedPermissions });
    expect(response.hookSpecificOutput).not.toHaveProperty('updatedInput');
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
    });
  });
});
