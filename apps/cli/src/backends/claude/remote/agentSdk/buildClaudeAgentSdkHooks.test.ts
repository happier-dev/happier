import { describe, expect, it, vi } from 'vitest';

import type { EnhancedMode } from '../../loop';
import type { PermissionResult } from '../../sdk/types';
import { buildClaudeAgentSdkHooks } from './buildClaudeAgentSdkHooks';

const makeMode = (): EnhancedMode => ({
  permissionMode: 'default',
});

function buildHooks(
  canCallTool = vi.fn(async (): Promise<PermissionResult> => ({ behavior: 'deny', message: 'denied' })),
) {
  return buildClaudeAgentSdkHooks({
    cwd: '/tmp/project',
    claudeConfigDir: null,
    getMode: makeMode,
    onSessionFound: () => {},
    onSessionHook: () => {},
    canCallTool,
  });
}

describe('buildClaudeAgentSdkHooks', () => {
  it('preserves authoritative SessionStart source evidence for runtime-activity startup', async () => {
    const onSessionFound = vi.fn();
    const { hooks } = buildClaudeAgentSdkHooks({
      cwd: '/tmp/project',
      claudeConfigDir: null,
      getMode: makeMode,
      onSessionFound,
      onSessionHook: () => {},
      canCallTool: vi.fn(async (): Promise<PermissionResult> => ({ behavior: 'deny', message: 'denied' })),
    });
    const sessionStart = hooks.SessionStart as Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;

    await sessionStart[0]!.hooks[0]!({
      session_id: 'claude-new',
      transcript_path: '/tmp/claude-new.jsonl',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });

    expect(onSessionFound).toHaveBeenCalledWith('claude-new', {
      transcript_path: '/tmp/claude-new.jsonl',
      transcriptPath: '/tmp/claude-new.jsonl',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
  });

  it('registers direct Runtime Activity hooks and forwards their exact inputs', async () => {
    const onSessionHook = vi.fn();
    const { hooks } = buildClaudeAgentSdkHooks({
      cwd: '/tmp/project',
      claudeConfigDir: null,
      getMode: makeMode,
      onSessionFound: () => {},
      onSessionHook,
      canCallTool: vi.fn(async (): Promise<PermissionResult> => ({ behavior: 'deny', message: 'denied' })),
    });

    for (const hookName of ['PostToolUse', 'SubagentStart', 'SubagentStop'] as const) {
      const registrations = hooks[hookName] as Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
      expect(registrations).toHaveLength(1);
      const input = { hook_event_name: hookName, session_id: 'session-1' };
      await registrations[0]!.hooks[0]!(input);
      expect(onSessionHook).toHaveBeenCalledWith(input);
    }
  });

  it('registers PermissionRequest and AskUserQuestion hooks so Claude Auto remains the permission authority', () => {
    const { hooks } = buildHooks();

    expect(hooks.PermissionRequest).toEqual([
      expect.objectContaining({ matcher: '' }),
    ]);
    expect(hooks.PreToolUse).toEqual([
      expect.objectContaining({ matcher: 'AskUserQuestion' }),
    ]);
  });

  it('preserves permission metadata and provider updates through PermissionRequest hooks', async () => {
    const updatedInput = { file_path: '/tmp/file.txt' };
    const updatedPermissions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
    const suggestions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
    const canCallTool = vi.fn(async (): Promise<PermissionResult> => ({
      behavior: 'allow',
      updatedInput,
      updatedPermissions,
    }));
    const { hooks } = buildHooks(canCallTool);
    const signal = new AbortController().signal;
    const registrations = hooks.PermissionRequest as Array<{
      hooks: Array<(input: unknown, toolUseId: string, options: { signal: AbortSignal }) => Promise<unknown>>;
    }>;

    const output = await registrations[0]!.hooks[0]!({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/input.txt' },
      permission_suggestions: suggestions,
      blocked_path: '/tmp/blocked.txt',
      decision_reason: 'requires approval',
      agent_id: 'agent_456',
    }, 'toolu_123', { signal });

    expect(canCallTool).toHaveBeenCalledWith(
      'Read',
      { file_path: '/tmp/input.txt' },
      expect.anything(),
      expect.objectContaining({
        signal,
        toolUseId: 'toolu_123',
        agentId: 'agent_456',
        suggestions,
        blockedPath: '/tmp/blocked.txt',
        decisionReason: 'requires approval',
      }),
    );
    expect(output).toEqual({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput, updatedPermissions },
      },
    });
  });
});
