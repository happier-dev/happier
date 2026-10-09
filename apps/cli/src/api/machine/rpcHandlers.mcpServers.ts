import { randomUUID } from 'node:crypto';

import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonMcpServersDetectRequestSchema, DaemonMcpServersTestRequestSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { DaemonMcpServersPreviewRequestSchema } from '@happier-dev/protocol/mcp/servers/previewV1';
import { listMcpServerCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { DaemonMcpServersPreviewResponse, DaemonMcpServersTestErrorCode, DaemonMcpServersDetectResponse, DaemonMcpServersDetectWarningV1, DaemonMcpServersTestRequest, DaemonMcpServersTestResponse, McpServerBindingV1, McpServersSettingsV1, ResolveEffectiveServersV1Result } from '@happier-dev/protocol';

import type { McpServerConfig } from '@/agent';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext, type AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { loadFreshMcpAccountSettingsContext } from '@/cli/commands/mcp/loadFreshMcpAccountSettingsContext';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { resolveEffectiveMcpServersForDirectory } from '@/mcp/servers/resolveEffectiveMcpServersForDirectory';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { createInvocationSavedSecretOperationContextV1, refreshSavedSecretCatalogForOperation, type SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { probeMcpStdioServerTools } from '@/mcp/servers/probeMcpStdioServerTools';
import { redactMcpServerProbeError } from '@/mcp/servers/redactMcpServerProbeError';
import { detectProviderMcpServers } from '@/mcp/providerDetection/detectProviderMcpServers';
import { resolveSessionMcpPreview } from '@/mcp/preview/resolveSessionMcpPreview';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

function redactErrorText(raw: unknown): string {
  return redactMcpServerProbeError(raw);
}

function nowMs(depsNowMs: (() => number) | undefined): number {
  if (typeof depsNowMs === 'function') return depsNowMs();
  return Date.now();
}

function implicitBindingForMachine(params: Readonly<{ serverId: string; machineId: string; nowMs: number }>): McpServerBindingV1 {
  return {
    id: `implicit_${randomUUID()}`,
    serverId: params.serverId,
    enabled: true,
    target: { t: 'machine', machineId: params.machineId },
    createdAt: params.nowMs,
    updatedAt: params.nowMs,
  };
}

function resolveServerForTestRequest(params: Readonly<{
  request: DaemonMcpServersTestRequest;
  accountMcpSettings?: McpServersSettingsV1;
}>): { ok: true; serverName: string; resolved: ResolveEffectiveServersV1Result } | { ok: false; errorCode: DaemonMcpServersTestErrorCode; error: string } {
  const req = params.request;

  if (req.t === 'draft') {
    const binding =
      req.binding && req.binding.serverId === req.server.id
        ? req.binding
        : req.binding
          ? null
          : implicitBindingForMachine({ serverId: req.server.id, machineId: req.machineId, nowMs: Date.now() });

    if (!binding) {
      return { ok: false, errorCode: 'binding_not_found', error: 'Draft binding does not match the draft server.' };
    }

    const settings: McpServersSettingsV1 = {
      v: 1,
      strictMode: true,
      servers: [req.server],
      bindings: [binding],
    };

    const resolved = resolveEffectiveMcpServersForDirectory({
      settings,
      machineId: req.machineId,
      directory: req.directory,
    });

    const item = resolved.serversByName[req.server.name];
    if (!item) return { ok: false, errorCode: 'server_not_found', error: 'Server not found after resolution.' };
    if (item.enabled !== true) return { ok: false, errorCode: 'server_disabled', error: 'Server is not enabled for this target.' };

    return { ok: true, serverName: req.server.name, resolved: { directory: req.directory, strictMode: true, serversByName: { [req.server.name]: item } } };
  }

  const accountMcpSettings = params.accountMcpSettings;
  if (!accountMcpSettings) return { ok: false, errorCode: 'materialization_failed', error: 'mcp_catalog_unavailable' };
  const server = accountMcpSettings.servers.find((s) => s.id === req.serverId) ?? null;
  if (!server) return { ok: false, errorCode: 'server_not_found', error: 'Server id not found.' };

  if (req.bindingId) {
    const binding = accountMcpSettings.bindings.find((b) => b.id === req.bindingId) ?? null;
    if (!binding) return { ok: false, errorCode: 'binding_not_found', error: 'Binding id not found.' };
    if (binding.serverId !== server.id) {
      return { ok: false, errorCode: 'binding_not_found', error: 'Binding does not belong to the selected server.' };
    }
    const settings: McpServersSettingsV1 = {
      v: 1,
      strictMode: true,
      servers: [server],
      bindings: [binding],
    };
    const resolved = resolveEffectiveMcpServersForDirectory({
      settings,
      machineId: req.machineId,
      directory: req.directory,
    });
    const item = resolved.serversByName[server.name];
    if (!item) return { ok: false, errorCode: 'server_not_found', error: 'Server not found after resolution.' };
    if (item.enabled !== true) return { ok: false, errorCode: 'server_disabled', error: 'Server is not enabled for this target.' };
    return { ok: true, serverName: server.name, resolved: { directory: req.directory, strictMode: true, serversByName: { [server.name]: item } } };
  }

  const resolved = resolveEffectiveMcpServersForDirectory({
    settings: accountMcpSettings,
    machineId: req.machineId,
    directory: req.directory,
  });
  const item = resolved.serversByName[server.name];
  if (!item) return { ok: false, errorCode: 'server_not_found', error: 'Server not found after resolution.' };
  if (item.enabled !== true) return { ok: false, errorCode: 'server_disabled', error: 'Server is not enabled for this target.' };
  return { ok: true, serverName: server.name, resolved: { directory: req.directory, strictMode: true, serversByName: { [server.name]: item } } };
}

export function registerMachineMcpServersRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  deps?: Readonly<{
    env?: NodeJS.ProcessEnv;
    nowMs?: () => number;
    readCredentials?: () => Promise<StoredCredentials | null>;
    bootstrapAccountSettingsContext?: typeof bootstrapAccountSettingsContext;
    detectProviderMcpServers?: typeof detectProviderMcpServers;
    probeMcpStdioServerTools?: typeof probeMcpStdioServerTools;
  }>;
}>): void {
  const { rpcHandlerManager } = params;
  const depsEnv = params.deps?.env ?? process.env;
  const readCredentialsImpl = params.deps?.readCredentials ?? readStoredCredentials;
  const bootstrapAccountSettingsContextImpl = params.deps?.bootstrapAccountSettingsContext ?? bootstrapAccountSettingsContext;
  const detectProviderMcpServersImpl = params.deps?.detectProviderMcpServers ?? detectProviderMcpServers;
  const probeMcpStdioServerToolsImpl = params.deps?.probeMcpStdioServerTools ?? probeMcpStdioServerTools;

  rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_MCP_SERVERS_TEST,
    async (raw: unknown): Promise<DaemonMcpServersTestResponse> => {
      const parsed = DaemonMcpServersTestRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, errorCode: 'invalid_request', error: 'invalid_request', durationMs: 0 };
      }

      const startedAt = nowMs(params.deps?.nowMs);

      const credentials = await readCredentialsImpl().catch(() => null);
      if (!credentials) {
        const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
        return { ok: false, errorCode: 'missing_credentials', error: 'missing_credentials', durationMs };
      }

      let accountSettingsContext: AccountSettingsContext;
      let resolution: ReturnType<typeof resolveServerForTestRequest>;
      let operationContext: SavedSecretOperationContextV1 | null = null;
      try {
        // A complete caller-owned draft does not depend on stored MCP facts.
        // Stored ids must capture the current admitted Account catalog.
        if (parsed.data.t === 'draft') {
          accountSettingsContext = await bootstrapAccountSettingsContextImpl({ credentials, mode: 'blocking', refresh: 'force' });
        } else {
          const captured = await loadFreshMcpAccountSettingsContext(credentials, { bootstrapAccountSettingsContext: bootstrapAccountSettingsContextImpl });
          accountSettingsContext = captured;
          operationContext = captured.operationContext;
          if (!await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
        }
        resolution = resolveServerForTestRequest({ request: parsed.data,
          ...(parsed.data.t === 'draft' ? {} : { accountMcpSettings: readMcpServersSettingsFromAccountSettings(accountSettingsContext) }) });
      } catch (error) {
        return { ok: false, errorCode: 'materialization_failed', error: redactErrorText(error),
          durationMs: Math.max(0, nowMs(params.deps?.nowMs) - startedAt) };
      }
      if (!resolution.ok) {
        const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
        return { ok: false, errorCode: resolution.errorCode, error: resolution.error, durationMs };
      }

      let materialSnapshot: ActiveAccountSettingsSnapshot = accountSettingsContext;
      const references = [...new Set(listMcpServerCatalogSavedSecretRefsV1({ v: 1, bindings: [],
        servers: Object.values(resolution.resolved.serversByName).filter(server => server.enabled === true).map(server => server.config),
      }).map(ref => ref.secretId))].map(ref => ({ ref }));
      if (references.length > 0 || parsed.data.t === 'byId') {
        try {
          const scopeKey = resolveAccountSettingsScopeKeyForToken(credentials.token);
          if (!operationContext) {
            const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
            operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot: accountSettingsContext,
              serverHttpBaseUrl: resolveServerHttpBaseUrl(),
              isCurrent: async () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
                && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken });
          }
          const capturedSnapshot = operationContext.readSnapshot();
          if (!capturedSnapshot) throw new McpServerCatalogUnavailableError('scope-retired');
          materialSnapshot = capturedSnapshot;
          if (references.length > 0) {
            const admitted = await refreshSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey, references, operationContext });
            materialSnapshot = admitted;
          }
        } catch (error) {
          const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
          return { ok: false, errorCode: 'materialization_failed', error: redactErrorText(error), durationMs };
        }
      }
      const savedSecretMaterializer = createSavedSecretMaterializerFromSnapshotV1(materialSnapshot, {
        isCurrent: () => operationContext !== null && operationContext.readSnapshot() === materialSnapshot,
      });

      let mcpConfig: { serverName: string; config: McpServerConfig; cleanup: () => void };
      try {
        const materialized = await materializeMcpServerConfigRecord({
          resolved: resolution.resolved,
          savedSecretMaterializer,
          processEnv: depsEnv,
          tmpDir: null,
          strictMode: true,
        });
        const config = materialized.mcpServers[resolution.serverName];
        if (!config) {
          materialized.cleanup();
          throw new Error('materialize_missing_config');
        }
        if (operationContext && !await operationContext.isCurrent()) {
          materialized.cleanup();
          throw new McpServerCatalogUnavailableError('scope-retired');
        }
        mcpConfig = { serverName: resolution.serverName, config, cleanup: materialized.cleanup };
      } catch (error) {
        const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
        return { ok: false, errorCode: 'materialization_failed', error: redactErrorText(error), durationMs };
      }

      try {
        const tools = await probeMcpStdioServerToolsImpl({ config: mcpConfig.config, baseEnv: depsEnv });
        if (operationContext && !await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
        const toolNames = tools.map((t) => t.name);
        const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
        return {
          ok: true,
          toolCount: toolNames.length,
          toolNamesSample: toolNames.slice(0, 20),
          durationMs,
        };
      } catch (error) {
        const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
        const message = redactErrorText(error);
        const code =
          message.includes('mcp_connect_timeout')
            ? 'mcp_connect_failed'
            : message.includes('mcp_list_tools_timeout')
              ? 'mcp_list_tools_failed'
              : 'mcp_list_tools_failed';
        return { ok: false, errorCode: code, error: message, durationMs };
      } finally {
        mcpConfig.cleanup();
      }
    },
  );

  rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_MCP_SERVERS_DETECT,
    async (raw: unknown): Promise<DaemonMcpServersDetectResponse> => {
      const parsed = DaemonMcpServersDetectRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
      }

      try {
        const detected = await detectProviderMcpServersImpl({
          directory: parsed.data.directory ?? null,
          providers: parsed.data.providers,
          env: depsEnv,
        });

        const warnings: DaemonMcpServersDetectWarningV1[] = [...detected.warnings];
        return {
          ok: true,
          servers: [...detected.servers],
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      } catch (error) {
        return { ok: false, errorCode: 'internal_error', error: redactErrorText(error) };
      }
    },
  );

  rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW,
    async (raw: unknown): Promise<DaemonMcpServersPreviewResponse> => {
      const parsed = DaemonMcpServersPreviewRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
      }

      const credentials = await readCredentialsImpl().catch(() => null);
      if (!credentials) {
        return { ok: false, errorCode: 'internal_error', error: 'missing_credentials' };
      }

      try {
        const accountSettingsContext = await loadFreshMcpAccountSettingsContext(credentials, {
          bootstrapAccountSettingsContext: bootstrapAccountSettingsContextImpl,
        });
        const accountMcpSettings = readMcpServersSettingsFromAccountSettings(accountSettingsContext);
        const operationContext = accountSettingsContext.operationContext;
        const detected = await detectProviderMcpServersImpl({
          directory: parsed.data.directory,
          providers: undefined,
          env: depsEnv,
        });
        if (!await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');

        return resolveSessionMcpPreview({
          settings: accountMcpSettings,
          machineId: parsed.data.machineId,
          directory: parsed.data.directory,
          agentId: parsed.data.agentId,
          selection: parsed.data.selection ?? null,
          detectedServers: detected.servers,
          detectedWarnings: detected.warnings,
        });
      } catch (error) {
        return { ok: false, errorCode: 'internal_error', error: redactErrorText(error) };
      }
    },
  );
}
