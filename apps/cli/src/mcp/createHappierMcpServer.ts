import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { logger } from '@/ui/logger';
import type { Metadata } from '@/api/types';

import { registerHappierMcpResources } from '@/mcp/resources/registerHappierMcpResources';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from '@/agent/tools/happierTools/createChangeTitleToolHandler';
import { normalizeExecutionRunRpcPayload } from '@/session/services/executionRuns';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonPluginActionExecutor } from '@/session/actions/createDaemonPluginActionExecutor';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permissions/modeFromMetadata';
import {
  PromptRegistryInstallRequestV1Schema,
  PromptRegistryInstallResponseV1Schema,
  type ActionId,
  type AccountSettings,
  type ActionExecutorDeps,
  type BackendTargetRefV2,
  getActionSpec,
  isActionSpecSurfacedOn,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MemorySearchResultV1Schema, MemoryWindowV1Schema, type MemorySearchResultV1, type MemoryWindowV1, type SessionStateCapabilitiesV1 } from '@happier-dev/protocol';
import { createSessionStateSyncEngine } from '@happier-dev/agents';
import {
  createMcpActionApprovalRequirement,
  createMcpActionEnablement,
  createMcpActionSettingsProvider,
} from '@/mcp/server/createMcpActionEnablement';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

const MCP_SESSION_STATE_CAPABILITIES: SessionStateCapabilitiesV1 = {
  display: {
    title: {
      supported: true,
      happierToProvider: { supported: false },
      providerToHappier: { supported: false },
    },
  },
};

function resolveLiveClientPermissionMode(client: HappyMcpSessionClient): string | null {
  const mode = client.getPermissionMode?.();
  return typeof mode === 'string' && mode.trim().length > 0 ? mode.trim() : null;
}

/**
 * The active-turn witness is host-owned. Preserve its raw value through the
 * host-only Action context so the canonical strict parser can reject malformed
 * authority rather than treating it as absent and broadening a call.
 */
function resolveLiveClientCausalPermissionAuthority(client: HappyMcpSessionClient): unknown {
  try {
    return client.getActiveTurnCausalPermissionAuthority?.() ?? null;
  } catch {
    return null;
  }
}

function resolveLiveClientBackendTarget(client: HappyMcpSessionClient): BackendTargetRefV2 | null {
  return client.getBackendTarget?.() ?? null;
}

function resolveLiveClientLocation(client: HappyMcpSessionClient): Readonly<{
  path?: string | null;
  host?: string | null;
  machineId?: string | null;
}> | null {
  return client.getCurrentSessionLocation?.() ?? null;
}

async function writeMcpSessionTitleMetadata(params: Readonly<{
  client: HappyMcpSessionClient;
  title: string;
  metadataReason: string;
}>): Promise<boolean> {
  const engine = createSessionStateSyncEngine({
    capabilities: MCP_SESSION_STATE_CAPABILITIES,
    facet: null,
    metadataPort: {
      update: async (_sessionId, updater) => {
        await Promise.resolve(params.client.updateMetadata((metadata) => updater(metadata) as Metadata));
        return { ok: true, version: 0 };
      },
    },
  });
  const result = await engine.writeHappierField({
    sessionId: params.client.sessionId,
    fieldId: 'display.title',
    value: {
      title: params.title,
      staleBehavior: 'bump-if-value-changed',
    },
    reason: 'user-mutation',
    metadataReason: params.metadataReason,
    mirrorToProvider: false,
  });
  return result.ok;
}

export function createHappierMcpServer(
  client: HappyMcpSessionClient,
  opts?: Readonly<{
    credentials?: StoredCredentials | null;
    accountSettings?: AccountSettings | null;
    getAccountSettings?: (() => AccountSettings | null) | null;
    pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  }>,
): { mcp: McpServer; toolNames: string[] } {
  // This server is the per-session MCP bridge that a running session agent uses.
  // It must use the `agent` surface so action enablement + approvals can be
  // configured separately from the external MCP surface (`mcp`).
  const toolSurface = 'agent' as const;
  const credentials = opts?.credentials ?? null;
  const actionSettingsProvider = createMcpActionSettingsProvider({
    accountSettings: opts?.accountSettings ?? null,
    getAccountSettings: opts?.getAccountSettings ?? null,
  });
  const readActionsSettings = () => actionSettingsProvider.getActionsSettings();
  const readSessionAgentSpawnPolicyV1 = () =>
    actionSettingsProvider.getAccountSettings()?.sessionAgentSpawnPolicyV1;
  const isActionEnabled = createMcpActionEnablement({
    actionSettingsProvider,
    surface: toolSurface,
  });
  const isActionApprovalRequired = createMcpActionApprovalRequirement({
    actionSettingsProvider,
    surface: toolSurface,
  });
  const ctx = credentials
    ? resolveSessionEncryptionContextFromCredentials(credentials)
    : null;
  const cryptoContext = ctx
    ? { mode: 'e2ee' as const, ctx }
    : { mode: 'plain' as const, ctx: null };

  const mcp = new McpServer({
    name: 'Happier MCP',
    version: '1.0.0',
  });

  // Only the host-only Action-context arm supplies options; every other method
  // keeps the plain two-argument local invocation it has always used rather than
  // widening the call with an absent third argument.
  const sessionScopedRpc = async (
    method: string,
    params: unknown,
    options?: Parameters<HappyMcpSessionClient['rpcHandlerManager']['invokeLocal']>[2],
  ) => await (options === undefined
    ? client.rpcHandlerManager.invokeLocal(method, params)
    : client.rpcHandlerManager.invokeLocal(method, params, options));
  const resolveAgentCallerPermissionMode = () => resolveLiveClientPermissionMode(client)
    ?? resolvePermissionIntentFromMetadataSnapshot({
      metadata: client.getMetadataSnapshot?.() ?? null,
    })?.intent
    ?? null;
  const sessionMetadataSnapshot = client.getMetadataSnapshot?.() ?? null;
  const sessionLocation = resolveLiveClientLocation(client);
  const rawSession = sessionMetadataSnapshot || sessionLocation
    ? {
        ...(sessionMetadataSnapshot ? { metadata: sessionMetadataSnapshot } : {}),
        ...(typeof sessionLocation?.path === 'string' ? { path: sessionLocation.path } : {}),
        ...(typeof sessionLocation?.host === 'string' ? { host: sessionLocation.host } : {}),
        ...(typeof sessionLocation?.machineId === 'string' ? { machineId: sessionLocation.machineId } : {}),
      }
    : null;
  const executionRuns = {
    start: async (
      request: unknown,
      localActionContext?: Readonly<{
        surface: 'agent';
        callerPermissionMode: string | null;
        causalPermissionAuthority: unknown;
      }>,
    ) =>
      normalizeExecutionRunRpcPayload(
        await (localActionContext
          ? sessionScopedRpc('execution.run.start', request, { localActionContext })
          : client.executionRuns?.start?.(request) ?? sessionScopedRpc('execution.run.start', request)),
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
  const executionRunStartRpc = async (
    _sessionId: string | null,
    request: unknown,
    actionOptions?: Parameters<ActionExecutorDeps['executionRunStart']>[2],
  ) => {
    const hasCausalPermissionAuthority = Boolean(
      actionOptions
      && Object.prototype.hasOwnProperty.call(actionOptions, 'causalPermissionAuthority'),
    );
    return await executionRuns.start(
      request,
      hasCausalPermissionAuthority
        ? {
            surface: toolSurface,
            callerPermissionMode: resolveAgentCallerPermissionMode(),
            causalPermissionAuthority: actionOptions?.causalPermissionAuthority ?? null,
          }
        : undefined,
    );
  };

  const harness = createCliActionExecutorHarness(
    {
      token: credentials?.token ?? '',
      ...(credentials ? { credentials } : {}),
      sessionId: client.sessionId,
      ...cryptoContext,
      rawSession,
      getCallerPermissionMode: () => resolveLiveClientPermissionMode(client),
      getCurrentSessionBackendTarget: () => resolveLiveClientBackendTarget(client),
    },
    {
      sessionTitleSet: async ({ sessionId, title }) => {
        const normalizedSessionId = String(sessionId ?? '').trim();
        if (!normalizedSessionId) {
          return { ok: false as const, errorCode: 'invalid_parameters' as const, error: 'invalid_parameters' as const };
        }
        const normalizedTitle = String(title ?? '').trim();
        if (!normalizedTitle) {
          return { ok: false as const, errorCode: 'invalid_parameters' as const, error: 'invalid_parameters' as const };
        }
        if (normalizedSessionId !== client.sessionId) {
          return { ok: false as const, errorCode: 'not_authenticated' as const, error: 'not_authenticated' as const };
        }

        try {
          const ok = await writeMcpSessionTitleMetadata({
            client,
            title: normalizedTitle,
            metadataReason: 'mcp-session-title-set',
          });
          if (!ok) {
            return { ok: false as const, errorCode: 'metadata_update_failed' as const, error: 'metadata_update_failed' as const };
          }
        } catch (error) {
          logger.debug('[mcp] Failed to update title metadata via session-scoped bridge', {
            sessionId: normalizedSessionId,
            error,
          });
          return { ok: false as const, errorCode: 'metadata_update_failed' as const, error: 'metadata_update_failed' as const };
        }

        return {
          ok: true as const,
          sessionId: normalizedSessionId,
          title: normalizedTitle,
          metadataUpdated: true as const,
        };
      },
      executionRunStart: executionRunStartRpc,
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
      isActionEnabled: (id) => isActionEnabled(id),
      isActionApprovalRequired: (id) => isActionApprovalRequired(id),
    },
  );

  const executor = createDaemonPluginActionExecutor({ base: harness.executor });

  registerHappierMcpResources(mcp as any, {
    surface: toolSurface,
    isActionEnabled,
  });

  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    isActionEnabled: (id) => {
      const spec = getActionSpec(id as any);
      return isActionSpecSurfacedOn(spec, toolSurface) && isActionEnabled(id as any);
    },
    surface: toolSurface,
    actionsSettings: readActionsSettings(),
    getActionsSettings: readActionsSettings,
    resolveCallerPermissionMode: resolveAgentCallerPermissionMode,
    resolveCausalPermissionAuthority: () => resolveLiveClientCausalPermissionAuthority(client),
    sessionAgentSpawnPolicyV1: readSessionAgentSpawnPolicyV1(),
    getSessionAgentSpawnPolicyV1: readSessionAgentSpawnPolicyV1,
    pluginToolCatalog: opts?.pluginToolCatalog,
  });

  const { toolNames } = registerHappierMcpBuiltInTools(mcp as any, {
    sessionId: client.sessionId,
    surface: toolSurface,
    actionsSettings: readActionsSettings(),
    getActionsSettings: readActionsSettings,
    pluginToolCatalog: opts?.pluginToolCatalog,
    deps: {
      changeTitle: createChangeTitleToolHandler({
        executor,
        surface: toolSurface,
      }),
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
