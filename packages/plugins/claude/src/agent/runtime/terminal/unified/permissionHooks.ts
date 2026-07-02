import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import {
  buildDefaultPermissionHookResponse,
  readPermissionHookEventName,
  type PermissionHookData,
  type PermissionHookResponse,
} from '../../../hooks/protocol.js';
import { createClaudePermissionEngine } from '../../../permissions/createClaudePermissionEngine.js';
import type { PermissionResult } from '../../../sdk/types.js';

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
  ctx: PluginContextV1,
): (data: PermissionHookData) => Promise<PermissionHookResponse> {
  const permissionEngine = createClaudePermissionEngine(ctx);
  return async (data) => {
    const toolName = readToolName(data);
    if (!toolName) return buildDefaultPermissionHookResponse(data);

    const toolUseId = readToolUseId(data);
    const result = await permissionEngine.canCallTool(toolName, readToolInput(data), {
      requestId: toolUseId,
      toolUseId,
    });
    return buildPermissionResponse(data, result);
  };
}
