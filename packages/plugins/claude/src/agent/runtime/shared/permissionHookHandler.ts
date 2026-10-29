import { isDeepStrictEqual } from 'node:util';

import {
  buildDefaultPermissionHookResponse,
  readPermissionHookEventName,
  type PermissionHookData,
  type PermissionHookResponse,
  type SessionHookData,
} from '../../hooks/protocol.js';
import { isSidechainSessionHook } from '../../hooks/sidechain.js';
import { isAskUserQuestionToolName } from '../../permissions/askUserQuestion.js';
import type { ClaudeUnifiedTerminalResponseLocation } from '@happier-dev/protocol/agents/claude/settings-policy';
import {
  createClaudePermissionEngine,
  type ClaudePermissionContext,
} from '../../permissions/createClaudePermissionEngine.js';
import type { PermissionResult } from '../../sdk/types.js';
import {
  AgentRuntimeJsonValueSchema,
  type AgentSessionHostServices,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';

type ClaudeToolExecutionContext = (ClaudePermissionContext | Readonly<{ permissionEngine: ReturnType<typeof createClaudePermissionEngine> }>) & Readonly<{
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
    // Both records use the same strict JSON normalization, including object prototypes.
    // PermissionRequest rewrites trigger Claude's rule recheck; an approval of unchanged
    // input must not claim a rewrite. PreToolUse keeps its interaction-answer contract.
    const shouldIncludeUpdatedInput = hookEventName === 'PreToolUse'
      || !isDeepStrictEqual(
        readToolInputRecord(result.updatedInput),
        readToolInputRecord(readToolInput(data)),
      );
    const updatedInput = shouldIncludeUpdatedInput ? { updatedInput: result.updatedInput } : {};
    return {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName,
        permissionDecision: 'allow',
        ...updatedInput,
        decision: {
          behavior: 'allow',
          ...updatedInput,
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

export type ClaudePermissionHookIngress = Readonly<{
  unifiedTerminalActive: boolean;
  responseLocations: Readonly<{
    question: ClaudeUnifiedTerminalResponseLocation;
    permission: ClaudeUnifiedTerminalResponseLocation;
  }>;
  unlistedTools?: 'ask' | 'deny';
  resolveToolUseId?(data: PermissionHookData): string | null | Promise<string | null>;
  onNativePrompt(data: SessionHookData): void | Promise<void>;
  onPermissionLifecycle?(data: SessionHookData): void | Promise<void>;
}>;

export function createClaudePermissionHookHandler(
  ctx: ClaudeToolExecutionContext,
  ingress?: ClaudePermissionHookIngress,
): (data: PermissionHookData, options?: Readonly<{ signal?: AbortSignal }>) => Promise<PermissionHookResponse> {
  const permissionEngine = 'permissionEngine' in ctx ? ctx.permissionEngine : createClaudePermissionEngine(ctx);
  return async (data, options) => {
    const toolName = readToolName(data);
    if (!toolName) return buildDefaultPermissionHookResponse(data);

    const toolUseId = readToolUseId(data) ?? await ingress?.resolveToolUseId?.(data) ?? null;
    if (toolUseId) data = { ...data, tool_use_id: toolUseId };
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
    const question = isAskUserQuestionToolName(toolName);
    const location = ingress?.responseLocations[question ? 'question' : 'permission'];
    const hookEventName = readPermissionHookEventName(data);
    const inputChanged = !isDeepStrictEqual(input, transformedInput);
    // Confined calls must reach the existing host permission authority: its policy
    // decides allowedTools/unlistedTools. Native passthrough cannot enforce it.
    const native = ingress?.unifiedTerminalActive === true
      && ingress.unlistedTools !== 'deny'
      && location !== 'app_only'
      // PermissionRequest applies rewrites only with an explicit allow decision.
      // Preserve the host rewrite through that owner instead of native passthrough.
      && (hookEventName === 'PreToolUse' || !inputChanged)
      && !isSidechainSessionHook(data);
    if (native) {
      // AskUserQuestion emits both hooks; only PreToolUse has its exact tool-use ID.
      if (!question || hookEventName === 'PreToolUse') {
        await ingress.onNativePrompt({
          ...data,
          tool_input: transformedInput,
          toolInput: transformedInput,
          hook_event_name: 'ClaudeNativePrompt',
          hookEventName: 'ClaudeNativePrompt',
          happierResponseLocation: location,
        });
      }
      const response = buildDefaultPermissionHookResponse(data);
      if (inputChanged) {
        response.hookSpecificOutput = { ...response.hookSpecificOutput, updatedInput: transformedInput };
      }
      return response;
    }
    const publish = async (hookEventName: string): Promise<void> => {
      await ingress?.onPermissionLifecycle?.({ ...data, hook_event_name: hookEventName, hookEventName });
    };
    await publish('PermissionRequest');
    try {
      const result = await permissionEngine.canCallTool(toolName, transformedInput, {
        requestId: toolUseId,
        toolUseId,
        signal: options?.signal,
      });
      return buildPermissionResponse(data, result);
    } finally {
      await publish('PermissionRequestCompleted');
    }
  };
}
