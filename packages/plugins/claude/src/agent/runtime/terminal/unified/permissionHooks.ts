import {
  buildDefaultPermissionHookResponse,
  readPermissionHookEventName,
  type PermissionHookData,
  type PermissionHookResponse,
} from '../../../hooks/protocol.js';
import {
  createClaudePermissionEngine,
  type ClaudePermissionContext,
} from '../../../permissions/createClaudePermissionEngine.js';
import type { PermissionResult } from '../../../sdk/types.js';
import {
  AgentRuntimeJsonValueSchema,
  type AgentSessionHostServices,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';

type ClaudeToolExecutionContext = ClaudePermissionContext & Readonly<{
  agentRuntime: Readonly<{
    toolExecution: AgentSessionHostServices['toolExecution'];
  }>;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readToolName(data: PermissionHookData): string | null {
  return readString(data.tool_name) ?? readString(data.toolName);
}

function readToolUseId(data: PermissionHookData): string | null {
  return readString(data.tool_use_id) ?? readString(data.toolUseId);
}

function readToolInput(data: PermissionHookData): unknown {
  return data.tool_input ?? data.toolInput ?? {};
}

function readToolInputRecord(value: unknown): Readonly<Record<string, JsonValue>> | null {
  const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
  return parsed.success && parsed.data !== null && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data as Readonly<Record<string, JsonValue>>
    : null;
}

function deniedToolInterception(message: string): PermissionResult {
  return { behavior: 'deny', message, interrupt: true };
}

function buildPermissionResponse(
  data: PermissionHookData,
  result: PermissionResult,
): PermissionHookResponse {
  const hookEventName = readPermissionHookEventName(data);
  if (result.behavior === 'allow') {
    return {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName,
        permissionDecision: 'allow',
        updatedInput: result.updatedInput,
        decision: {
          behavior: 'allow',
          updatedInput: result.updatedInput,
          ...(result.updatedPermissions ? { updatedPermissions: result.updatedPermissions } : {}),
        },
      },
    };
  }

  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: 'deny',
      decision: {
        behavior: 'deny',
        message: result.message,
        ...(result.interrupt === true ? { interrupt: true } : {}),
      },
    },
  };
}

export function createClaudeUnifiedPermissionHookHandler(
  ctx: ClaudeToolExecutionContext,
): (data: PermissionHookData) => Promise<PermissionHookResponse> {
  const permissionEngine = createClaudePermissionEngine(ctx);
  return async (data) => {
    const toolName = readToolName(data);
    if (!toolName) return buildDefaultPermissionHookResponse(data);

    const toolUseId = readToolUseId(data);
    const input = readToolInputRecord(readToolInput(data));
    if (!input) {
      return buildPermissionResponse(data, deniedToolInterception('Claude supplied invalid tool input.'));
    }
    let interception: Awaited<ReturnType<AgentSessionHostServices['toolExecution']['before']>>;
    try {
      interception = await ctx.agentRuntime.toolExecution.before({
        callId: toolUseId ?? `claude:${toolName}:${Date.now().toString(36)}`,
        name: toolName,
        input,
      });
    } catch {
      return buildPermissionResponse(data, deniedToolInterception('Tool interception failed.'));
    }
    if (interception.status === 'rejected') {
      return buildPermissionResponse(
        data,
        deniedToolInterception(interception.message ?? 'Tool execution was rejected.'),
      );
    }
    if (interception.status === 'failed') {
      return buildPermissionResponse(data, deniedToolInterception('Tool interception failed.'));
    }
    const transformedInput = readToolInputRecord(interception.input);
    if (!transformedInput) {
      return buildPermissionResponse(data, deniedToolInterception('Tool interception returned invalid input.'));
    }
    const result = await permissionEngine.canCallTool(toolName, transformedInput, {
      requestId: toolUseId,
      toolUseId,
    });
    return buildPermissionResponse(data, result);
  };
}
