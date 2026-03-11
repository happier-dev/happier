import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { randomUUID } from 'node:crypto';

import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { logger } from '@/ui/logger';

import { registerHappierMcpResources } from '@/mcp/resources/registerHappierMcpResources';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import { createActionExecutor, getActionSpec, isActionSpecSurfacedOn, type ActionExecutorDeps } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MemorySearchResultV1Schema, MemoryWindowV1Schema, type MemorySearchResultV1, type MemoryWindowV1 } from '@happier-dev/protocol';

export function createHappierMcpServer(client: HappyMcpSessionClient): { mcp: McpServer; toolNames: string[] } {
  const changeTitleHandler = async (title: string) => {
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

  const sessionScopedRpc = async (method: string, params: unknown) =>
    await client.rpcHandlerManager.invokeLocal(method, params);

  const deps: ActionExecutorDeps = {
    executionRunStart: async (_sessionId, request) => await sessionScopedRpc('execution.run.start', request),
    executionRunList: async (_sessionId, _request) => await sessionScopedRpc('execution.run.list', {}),
    executionRunGet: async (_sessionId, request) => await sessionScopedRpc('execution.run.get', request),
    executionRunSend: async (_sessionId, request) => await sessionScopedRpc('execution.run.send', request),
    executionRunStop: async (_sessionId, request) => await sessionScopedRpc('execution.run.stop', request),
    executionRunAction: async (_sessionId, request) => await sessionScopedRpc('execution.run.action', request),

    daemonMemorySearch: async ({ query }): Promise<MemorySearchResultV1> => {
      const res = await sessionScopedRpc(RPC_METHODS.DAEMON_MEMORY_SEARCH, query);
      return MemorySearchResultV1Schema.parse(res);
    },
    daemonMemoryGetWindow: async ({ sessionId, seqFrom, seqTo }): Promise<MemoryWindowV1> => {
      const res = await sessionScopedRpc(RPC_METHODS.DAEMON_MEMORY_GET_WINDOW, { v: 1, sessionId, seqFrom, seqTo });
      return MemoryWindowV1Schema.parse(res);
    },
    daemonMemoryEnsureUpToDate: async ({ sessionId }) =>
      await sessionScopedRpc(RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE, sessionId ? { sessionId } : {}),

    // Not exposed as MCP tools today; satisfy executor deps to keep a single shared implementation.
    sessionOpen: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.open' }),
    sessionFork: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.fork' }),
    sessionSpawnNew: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.spawn_new' }),
    sessionSpawnPicker: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.spawn_picker' }),
    workspacesListRecent: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspaces.list_recent' }),
    pathsListRecent: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:paths.list_recent' }),
    machinesList: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:machines.list' }),
    serversList: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:servers.list' }),
    reviewEnginesList: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:review.engines.list' }),
    agentsBackendsList: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.backends.list' }),
    agentsModelsList: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.models.list' }),
    sessionSendMessage: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.message.send' }),
    sessionPermissionRespond: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.permission.respond' }),
    sessionUserActionAnswer: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.user_action.answer' }),
    sessionModeSet: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.mode.set' }),
    sessionModesList: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.modes.list' }),
    sessionTargetPrimarySet: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.target.primary.set' }),
    sessionTargetTrackedSet: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.target.tracked.set' }),
    sessionList: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' }),
    sessionActivityGet: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.activity.get' }),
    sessionRecentMessagesGet: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.messages.recent.get' }),
    resetGlobalVoiceAgent: async () => {},

    isActionEnabled: (id, ctx) => isActionEnabledByEnv(id, { surface: ctx.surface ?? 'mcp', placement: ctx.placement ?? null }),
  };

  const executor = createActionExecutor(deps);

  const enabledTools = listBuiltInHappierTools();

  registerHappierMcpResources(mcp as any, {
    isActionEnabled: (id) => isActionEnabledByEnv(id, { surface: 'mcp' }),
  });

  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    isActionEnabled: (id) => {
      const spec = getActionSpec(id as any);
      return isActionSpecSurfacedOn(spec, 'mcp') && isActionEnabledByEnv(id as any, { surface: 'mcp' });
    },
  });

  for (const tool of enabledTools) {
    const handler = async (args: any) => {
      const result = await dispatchBuiltInHappierTool({
        toolName: tool.name,
        args,
        sessionId: client.sessionId,
        deps: {
          changeTitle: async (_sessionId, title) => {
            const response = await changeTitleHandler(title);
            logger.debug('[happierMCP] Response:', response);
            return response;
          },
          startExecutionRun: async (_sessionId, request) => ({
            ok: true,
            result: await sessionScopedRpc('execution.run.start', request),
          }),
          executeActionByToolName: actionToolBridge.executeActionByToolName,
          resolveActionOptions: (args) => actionToolBridge.resolveActionOptions(args, client.sessionId),
          isActionEnabled: actionToolBridge.isActionEnabled,
        },
      });

      return result.ok
        ? {
            content: [{ type: 'text' as const, text: JSON.stringify(result.result) }],
            isError: false as const,
          }
        : {
            content: [{ type: 'text' as const, text: JSON.stringify({ errorCode: result.errorCode, error: result.error }) }],
            isError: true as const,
          };
    };

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
