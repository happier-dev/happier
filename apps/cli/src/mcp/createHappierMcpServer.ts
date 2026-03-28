import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { logger } from '@/ui/logger';

import { registerHappierMcpResources } from '@/mcp/resources/registerHappierMcpResources';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from '@/agent/tools/happierTools/createChangeTitleToolHandler';
import { createStartExecutionRunToolHandler } from '@/agent/tools/happierTools/createStartExecutionRunToolHandler';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import { normalizeExecutionRunRpcPayload } from '@/session/services/executionRuns';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import type { Credentials } from '@/persistence';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  PromptRegistryInstallRequestV1Schema,
  PromptRegistryInstallResponseV1Schema,
  type ActionId,
  getActionSpec,
  isActionSpecSurfacedOn,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MemorySearchResultV1Schema, MemoryWindowV1Schema, type MemorySearchResultV1, type MemoryWindowV1 } from '@happier-dev/protocol';

export function createHappierMcpServer(
  client: HappyMcpSessionClient,
  opts?: Readonly<{ credentials?: Credentials | null }>,
): { mcp: McpServer; toolNames: string[] } {
  // This server is used as the HTTP MCP backend for provider bridges (e.g. Claude Code via stdio).
  // Those clients expect the `mcp` surface, not `session_agent` (which is fail-closed for
  // session-control actions by default via account settings).
  const toolSurface = 'mcp' as const;
  const credentials = opts?.credentials ?? null;
  const ctx = credentials
    ? resolveSessionEncryptionContextFromCredentials(credentials)
    : { encryptionKey: new Uint8Array(0), encryptionVariant: 'legacy' as const };

  const mcp = new McpServer({
    name: 'Happier MCP',
    version: '1.0.0',
  });

  const sessionScopedRpc = async (method: string, params: unknown) =>
    await client.rpcHandlerManager.invokeLocal(method, params);
  const sessionMetadataSnapshot = client.getMetadataSnapshot?.() ?? null;
  const rawSession = sessionMetadataSnapshot ? { metadata: sessionMetadataSnapshot } : null;
  const executionRuns = {
    start: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.start?.(request) ?? sessionScopedRpc('execution.run.start', request)),
      ),
    list: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.list?.(request) ?? sessionScopedRpc('execution.run.list', request)),
      ),
    get: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.get?.(request) ?? sessionScopedRpc('execution.run.get', request)),
      ),
    send: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.send?.(request) ?? sessionScopedRpc('execution.run.send', request)),
      ),
    stop: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.stop?.(request) ?? sessionScopedRpc('execution.run.stop', request)),
      ),
    action: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.action?.(request) ?? sessionScopedRpc('execution.run.action', request)),
      ),
    wait: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.wait?.(request) ?? sessionScopedRpc('execution.run.wait', request)),
      ),
  };

  const harness = createCliActionExecutorHarness(
    {
      token: credentials?.token ?? '',
      ...(credentials ? { credentials } : {}),
      sessionId: client.sessionId,
      ctx,
      rawSession,
    },
    {
      executionRunStart: async (_sessionId, request) => await executionRuns.start(request),
      executionRunList: async (_sessionId, request) => await executionRuns.list(request),
      executionRunGet: async (_sessionId, request) => await executionRuns.get(request),
      executionRunSend: async (_sessionId, request) => await executionRuns.send(request),
      executionRunStop: async (_sessionId, request) => await executionRuns.stop(request),
      executionRunAction: async (_sessionId, request) => await executionRuns.action(request),
      executionRunWait: async (_sessionId, request) => await executionRuns.wait(request),

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

      promptRegistryInstall: async (args) => {
        if (!args.installTarget) {
          return { ok: false as const, errorCode: 'invalid_request' as const, error: 'installTarget is required' };
        }

        const request = PromptRegistryInstallRequestV1Schema.parse({
          sourceId: args.sourceId,
          itemId: args.itemId,
          configuredSources: args.configuredSources ?? [],
          installTarget: args.installTarget,
        });
        const res = await sessionScopedRpc(RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL, request);
        return PromptRegistryInstallResponseV1Schema.parse(res);
      },

      resetGlobalVoiceAgent: async () => {},
    },
  );

  const executor = harness.executor;

  registerHappierMcpResources(mcp as any, {
    surface: toolSurface,
    isActionEnabled: (id) => isActionEnabledByEnv(id, { surface: toolSurface }),
  });

  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    isActionEnabled: (id) => {
      const spec = getActionSpec(id as any);
      return isActionSpecSurfacedOn(spec, toolSurface) && isActionEnabledByEnv(id as any, { surface: toolSurface });
    },
    surface: toolSurface,
  });

  const { toolNames } = registerHappierMcpBuiltInTools(mcp as any, {
    sessionId: client.sessionId,
    surface: toolSurface,
    deps: {
      changeTitle: createChangeTitleToolHandler({
        executor,
        surface: toolSurface,
        afterCommit: async ({ title }) => {
          // Keep the in-memory session metadata snapshot in sync so the UI / session agent
          // can reflect the new title immediately (without requiring a full server refresh).
          await Promise.resolve(client.updateMetadata((current) => ({
            ...current,
            summary: {
              text: title,
              updatedAt: Date.now(),
            },
          })));
        },
      }),
      startExecutionRun: createStartExecutionRunToolHandler({ executor, surface: toolSurface }),
      executeActionByToolName: actionToolBridge.executeActionByToolName,
      resolveActionOptions: (args) => actionToolBridge.resolveActionOptions(args, client.sessionId),
      isActionEnabled: actionToolBridge.isActionEnabled,
    },
  });

  return {
    mcp,
    toolNames,
  };
}
