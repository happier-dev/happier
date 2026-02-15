import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { randomUUID } from 'node:crypto';

import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { logger } from '@/ui/logger';

import { HAPPIER_MCP_TOOLS } from '@/mcp/happierMcpToolCatalog';
import { createActionSpecMcpTools } from '@/mcp/tools/actionSpecTools';
import { readDisabledActionIdsFromEnv, isActionEnabledByEnv } from '@/settings/actionsSettings';
import { createActionExecutor, getActionSpec, listActionSpecs, type ActionExecutorDeps } from '@happier-dev/protocol';
import { ExecutionRunIntentSchema } from '@happier-dev/protocol';
import { z } from 'zod';

export { HAPPIER_MCP_TOOL_NAMES } from '@/mcp/happierMcpToolCatalog';

export function createHappierMcpServer(client: HappyMcpSessionClient): { mcp: McpServer; toolNames: string[] } {
  const handler = async (title: string) => {
    logger.debug('[happierMCP] Changing title to:', title);
    try {
      client.sendClaudeSessionMessage({
        type: 'summary',
        summary: title,
        leafUuid: randomUUID(),
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  };

  const mcp = new McpServer({
    name: 'Happier MCP',
    version: '1.0.0',
  });

  const disabledActionIds = readDisabledActionIdsFromEnv();
  const disabledMcpToolNames = new Set<string>();
  for (const actionId of disabledActionIds) {
    try {
      const spec = getActionSpec(actionId as any);
      const mcpToolName = typeof spec.bindings?.mcpToolName === 'string' ? spec.bindings.mcpToolName.trim() : '';
      if (mcpToolName) disabledMcpToolNames.add(mcpToolName);
    } catch {
      // ignore
    }
  }

  const actionSpecTools = createActionSpecMcpTools({
    isActionEnabled: (id) => isActionEnabledByEnv(id),
  });

  const sessionScopedRpc = async (method: string, params: unknown) =>
    await client.rpcHandlerManager.invokeLocal(method, params);

  const deps: ActionExecutorDeps = {
    executionRunStart: async (_sessionId, request) => await sessionScopedRpc('execution.run.start', request),
    executionRunList: async (_sessionId, _request) => await sessionScopedRpc('execution.run.list', {}),
    executionRunGet: async (_sessionId, request) => await sessionScopedRpc('execution.run.get', request),
    executionRunSend: async (_sessionId, request) => await sessionScopedRpc('execution.run.send', request),
    executionRunStop: async (_sessionId, request) => await sessionScopedRpc('execution.run.stop', request),
    executionRunAction: async (_sessionId, request) => await sessionScopedRpc('execution.run.action', request),

    // Not exposed as MCP tools today; satisfy executor deps to keep a single shared implementation.
    sessionOpen: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.open' }),
    sessionSpawnNew: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.spawn_new' }),
    sessionSendMessage: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.message.send' }),
    sessionPermissionRespond: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.permission.respond' }),
    sessionTargetPrimarySet: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.target.primary.set' }),
    sessionTargetTrackedSet: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.target.tracked.set' }),
    sessionList: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' }),
    sessionActivityGet: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.activity.get' }),
    sessionRecentMessagesGet: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.messages.recent.get' }),
    resetGlobalVoiceAgent: async () => {},

    isActionEnabled: (id) => isActionEnabledByEnv(id),
  };

  const executor = createActionExecutor(deps);

  const actionToolNameToId = new Map<string, string>();
  for (const spec of listActionSpecs()) {
    if (spec.surfaces.mcp !== true) continue;
    const toolName = typeof spec.bindings?.mcpToolName === 'string' ? spec.bindings.mcpToolName.trim() : '';
    if (!toolName) continue;
    actionToolNameToId.set(toolName, spec.id);
  }

  const handlersByName: Record<string, (args: any) => Promise<any>> = {
    change_title: async (args: any) => {
      const title = typeof args?.title === 'string' ? args.title : '';
      const response = await handler(title);
      logger.debug('[happierMCP] Response:', response);

      if (response.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Successfully changed chat title to: "${title}"`,
            },
          ],
          isError: false as const,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
          },
        ],
        isError: true as const,
      };
    },

    action_spec_list: async (args: any) => actionSpecTools.action_spec_list.handler(args),
    action_spec_get: async (args: any) => actionSpecTools.action_spec_get.handler(args),

    execution_run_start: async (args: any) => {
      const schema = z.object({
        sessionId: z.string().min(1).optional(),
        intent: ExecutionRunIntentSchema,
        backendId: z.string().min(1),
        instructions: z.string().optional(),
        permissionMode: z.string().min(1).optional(),
        retentionPolicy: z.enum(['ephemeral', 'resumable']).optional(),
        runClass: z.enum(['bounded', 'long_lived']).optional(),
        ioMode: z.enum(['request_response', 'streaming']).optional(),
      }).passthrough();

      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ errorCode: 'execution_run_invalid_action_input', error: 'Invalid params' }) }],
          isError: true as const,
        };
      }

      // MCP server is session-scoped; reject any mismatched sessionId if caller provides one.
      if (typeof parsed.data.sessionId === 'string' && parsed.data.sessionId.trim() !== client.sessionId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ errorCode: 'execution_run_not_allowed', error: 'This MCP server is scoped to a different session' }) }],
          isError: true as const,
        };
      }

      const res = await sessionScopedRpc('execution.run.start', {
        intent: parsed.data.intent,
        backendId: parsed.data.backendId,
        instructions: parsed.data.instructions,
        permissionMode: parsed.data.permissionMode ?? 'read_only',
        retentionPolicy: parsed.data.retentionPolicy ?? 'ephemeral',
        runClass: parsed.data.runClass ?? 'bounded',
        ioMode: parsed.data.ioMode ?? 'request_response',
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(res) }],
        isError: false as const,
      };
    },
  };

  const enabledTools = HAPPIER_MCP_TOOLS.filter((tool) => {
    if (tool.name === 'change_title') return true;
    if (tool.name === 'action_spec_list' || tool.name === 'action_spec_get') return true;
    if (disabledMcpToolNames.has(tool.name)) return false;
    return true;
  });

  for (const tool of enabledTools) {
    const handlerFn = handlersByName[tool.name];
    const actionId = actionToolNameToId.get(tool.name);

    const handler = handlerFn ?? (async (args: any) => {
          if (!actionId) {
            throw new Error(`Missing handler for MCP tool: ${tool.name}`);
          }

          // MCP server is session-scoped; reject any mismatched sessionId if caller provides one.
          const provided = args && typeof args === 'object' && !Array.isArray(args) ? (args as any).sessionId : undefined;
          if (provided !== undefined) {
            if (typeof provided !== 'string' || provided.trim().length === 0) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ errorCode: 'execution_run_invalid_action_input', error: 'Invalid sessionId' }) }],
                isError: true as const,
              };
            }
            if (provided.trim() !== client.sessionId) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ errorCode: 'execution_run_not_allowed', error: 'This MCP server is scoped to a different session' }) }],
                isError: true as const,
              };
            }
          }

          const res = await executor.execute(actionId as any, args, { defaultSessionId: client.sessionId });
          if (!res.ok) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ errorCode: res.errorCode, error: res.error }) }],
              isError: true as const,
            };
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(res.result) }],
            isError: false as const,
          };
        });

    mcp.registerTool(
      tool.name,
      {
        description: tool.description,
        title: tool.title,
        inputSchema: tool.inputSchema,
      } as any,
      handler,
    );
  }

  return {
    mcp,
    toolNames: enabledTools.map((t) => t.name),
  };
}
