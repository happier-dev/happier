import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getActionSpec, isActionSpecSurfacedOn, type ActionId } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { registerHappierMcpResources } from '@/mcp/resources/registerHappierMcpResources';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from '@/agent/tools/happierTools/createChangeTitleToolHandler';
import { isActionEnabledByEnv, readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { createDaemonPluginActionExecutor } from '@/session/actions/createDaemonPluginActionExecutor';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function readSessionIdFromToolArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const sessionId = normalizeId((args as any).sessionId);
  return sessionId || null;
}

export function createExternalMcpServer(params: Readonly<{
  credentials: StoredCredentials;
  defaultSessionId?: string | null;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): Readonly<{ mcp: McpServer; toolNames: string[] }> {
  const toolSurface = 'mcp' as const;

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials);
  const cryptoContext = ctx
    ? { mode: 'e2ee' as const, ctx }
    : { mode: 'plain' as const, ctx: null };
  let defaultSessionId: string | null = normalizeId(params.defaultSessionId) || null;

  const { executor: baseExecutor } = createCliActionExecutorHarness(
    {
      ...cryptoContext,
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId: 'cli-global',
    },
    {
      sessionTargetPrimarySet: async ({ sessionId }) => {
        const normalized = typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;
        defaultSessionId = normalized;
        return { ok: true, sessionId: normalized };
      },
      sessionTargetTrackedSet: async ({ sessionIds }) => {
        const trackedSessionIds = Array.isArray(sessionIds)
          ? sessionIds.map((id) => String(id ?? '').trim()).filter(Boolean)
          : [];
        return { ok: true, sessionIds: trackedSessionIds };
      },
    },
  );
  const executor = createDaemonPluginActionExecutor({ base: baseExecutor });

  const mcp = new McpServer({
    name: 'Happier MCP',
    version: '1.0.0',
  });

  registerHappierMcpResources(mcp as any, {
    surface: toolSurface,
    isActionEnabled: (id) => isActionEnabledByEnv(id as any, { surface: toolSurface }),
  });

  const actionsSettings = readActionsSettingsFromEnv();
  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    isActionEnabled: (id) => {
      const spec = getActionSpec(id as any);
      return isActionSpecSurfacedOn(spec, toolSurface) && isActionEnabledByEnv(id as any, { surface: toolSurface });
    },
    surface: toolSurface,
    actionsSettings,
    pluginToolCatalog: params.pluginToolCatalog,
  });

  const { toolNames } = registerHappierMcpBuiltInTools(mcp as any, {
    sessionId: 'cli-global',
    surface: toolSurface,
    actionsSettings,
    pluginToolCatalog: params.pluginToolCatalog,
    resolveSessionId: (toolArgs) => readSessionIdFromToolArgs(toolArgs) ?? defaultSessionId ?? 'cli-global',
    deps: {
      changeTitle: createChangeTitleToolHandler({
        executor,
        surface: toolSurface,
      }),
      executeActionByToolName: actionToolBridge.executeActionByToolName,
      resolveActionOptions: async (resolverArgs) =>
        await actionToolBridge.resolveActionOptions(
          resolverArgs,
          readSessionIdFromToolArgs(resolverArgs) ?? defaultSessionId ?? 'cli-global',
        ),
      isActionEnabled: actionToolBridge.isActionEnabled,
    },
  });

  return { mcp, toolNames };
}
