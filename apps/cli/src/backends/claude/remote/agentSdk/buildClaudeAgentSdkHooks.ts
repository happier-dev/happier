import { join } from 'node:path';

import { getProjectPath } from '@/backends/claude/utils/path';
import type { EnhancedMode } from '@/backends/claude/loop';
import type { PermissionResult } from '@/backends/claude/sdk/types';
import { resolveClaudePermissionHookTimeoutSeconds } from '@/backends/claude/utils/permissionHookTimeout';

function toPermissionRequestHookResult(result: PermissionResult): Record<string, unknown> {
  if (result.behavior === 'allow') {
    return {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: result.updatedInput,
          ...(typeof result.updatedPermissions !== 'undefined' ? { updatedPermissions: result.updatedPermissions } : {}),
        },
      },
    };
  }

  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: result.message,
        ...(result.interrupt !== undefined ? { interrupt: result.interrupt } : {}),
      },
    },
    ...(result.message ? { systemMessage: result.message } : {}),
  };
}

function toPreToolUseHookResult(result: PermissionResult): Record<string, unknown> {
  if (result.behavior === 'allow') {
    return {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: result.updatedInput,
      },
    };
  }

  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      ...(result.message ? { permissionDecisionReason: result.message } : {}),
    },
    ...(result.message ? { systemMessage: result.message } : {}),
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function buildClaudeAgentSdkHooks(params: Readonly<{
  cwd: string;
  claudeConfigDir: string | null;
  getMode: () => EnhancedMode;
  onSessionFound: (sessionId: string, data: {
    transcript_path: string;
    transcriptPath: string;
    hook_event_name?: string;
    source?: string;
  }) => void;
  onSessionHook: (data: Record<string, unknown>) => void;
  canCallTool: (
    toolName: string,
    input: unknown,
    mode: EnhancedMode,
    options: {
      signal: AbortSignal;
      toolUseId?: string | null;
      agentId?: string | null;
      suggestions?: unknown;
      blockedPath?: string | null;
      decisionReason?: string | null;
    },
  ) => Promise<PermissionResult>;
}>): Readonly<{
  hooks: Record<string, unknown>;
}> {
  const buildObservationHook = () => ({
    hooks: [
      async (input: any) => {
        if (input && typeof input === 'object' && !Array.isArray(input)) {
          params.onSessionHook(input as Record<string, unknown>);
        }
        return { continue: true, suppressOutput: true };
      },
    ],
  });
  const permissionHookTimeoutSeconds = resolveClaudePermissionHookTimeoutSeconds();
  const buildPermissionHook = (hookEventName: 'PermissionRequest' | 'PreToolUse') =>
    async (input: unknown, toolUseId: string | undefined, options: { signal?: AbortSignal } | undefined) => {
      const payload = readRecord(input);
      const toolName = readString(payload.tool_name) ?? readString(payload.toolName) ?? 'unknown_tool';
      const toolInput = payload.tool_input ?? payload.toolInput ?? {};
      const result = await params.canCallTool(toolName, toolInput, params.getMode(), {
        signal: options?.signal ?? new AbortController().signal,
        toolUseId: readString(toolUseId) ?? readString(payload.tool_use_id) ?? readString(payload.toolUseId),
        agentId: readString(payload.agent_id) ?? readString(payload.agentId),
        suggestions: payload.permission_suggestions ?? payload.permissionSuggestions,
        blockedPath: readString(payload.blocked_path) ?? readString(payload.blockedPath),
        decisionReason: readString(payload.decision_reason) ?? readString(payload.decisionReason),
      });
      return hookEventName === 'PreToolUse'
        ? toPreToolUseHookResult(result)
        : toPermissionRequestHookResult(result);
    };
  const hooks = {
    SessionStart: [
      {
        hooks: [
          async (input: any) => {
            const sessionId =
              input && typeof input.session_id === 'string'
                ? input.session_id
                : input && typeof input.sessionId === 'string'
                  ? input.sessionId
                  : undefined;
            if (sessionId) {
              const transcriptRaw =
                typeof input.transcript_path === 'string'
                  ? input.transcript_path
                  : typeof input.transcriptPath === 'string'
                    ? input.transcriptPath
                    : undefined;
              const transcriptPathFallback =
                transcriptRaw ?? join(getProjectPath(params.cwd, params.claudeConfigDir), `${sessionId}.jsonl`);
              const hookEventName = typeof input.hook_event_name === 'string'
                ? input.hook_event_name
                : typeof input.hookEventName === 'string'
                  ? input.hookEventName
                  : undefined;
              const source = typeof input.source === 'string' ? input.source : undefined;
              params.onSessionFound(sessionId, {
                transcript_path: transcriptPathFallback,
                transcriptPath: transcriptPathFallback,
                ...(hookEventName ? { hook_event_name: hookEventName } : {}),
                ...(source ? { source } : {}),
              });
            }
            return { continue: true };
          },
        ],
      },
    ],
    PostToolUse: [buildObservationHook()],
    SubagentStart: [buildObservationHook()],
    SubagentStop: [buildObservationHook()],
    PermissionRequest: [{
      matcher: '',
      hooks: [buildPermissionHook('PermissionRequest')],
      timeout: permissionHookTimeoutSeconds,
    }],
    PreToolUse: [{
      matcher: 'AskUserQuestion',
      hooks: [buildPermissionHook('PreToolUse')],
      timeout: permissionHookTimeoutSeconds,
    }],
  };

  return { hooks };
}
