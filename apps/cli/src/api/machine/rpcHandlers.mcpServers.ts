import { randomUUID } from 'node:crypto';

import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonMcpServersDetectRequestSchema, DaemonMcpServersTestRequestSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { DaemonMcpServersPreviewRequestSchema } from '@happier-dev/protocol/mcp/servers/previewV1';
import type { DaemonMcpServersPreviewResponse, DaemonMcpServersTestErrorCode, DaemonMcpServersDetectResponse, DaemonMcpServersDetectWarningV1, DaemonMcpServersTestRequest, DaemonMcpServersTestResponse, McpServerBindingV1, McpServerCatalogEntryV1, McpServersSettingsV1, ResolveEffectiveServersV1Result } from '@happier-dev/protocol';
import { isSharedSavedSecretReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import type { McpServerConfig } from '@/agent';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { resolveEffectiveMcpServersForDirectory } from '@/mcp/servers/resolveEffectiveMcpServersForDirectory';
import {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/mcp/servers/resolveMcpValueRefPlaintext';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
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

/**
 * The shared Saved Secret references this test would materialize. A test is a
 * new operation, so these are admitted against the Home's current catalog
 * before use rather than read from a snapshot a missed change hint left behind.
 */
function listTestSharedSavedSecretReferences(resolved: ResolveEffectiveServersV1Result): Array<{ ref: string }> {
  const refs = new Set<string>();
  for (const item of Object.values(resolved.serversByName)) {
    if (item.enabled !== true) continue;
    const valueRefs = [
      ...Object.values(item.config.env),
      ...Object.values(item.config.remote?.headers ?? {}),
    ];
    for (const valueRef of valueRefs) {
      if (valueRef.t === 'savedSecret' && isSharedSavedSecretReferenceV1(valueRef.secretId)) refs.add(valueRef.secretId);
    }
  }
  return [...refs].map((ref) => ({ ref }));
}

function resolveServerForTestRequest(params: Readonly<{
  request: DaemonMcpServersTestRequest;
  accountMcpSettings: McpServersSettingsV1;
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

  const server = params.accountMcpSettings.servers.find((s) => s.id === req.serverId) ?? null;
  if (!server) return { ok: false, errorCode: 'server_not_found', error: 'Server id not found.' };

  if (req.bindingId) {
    const binding = params.accountMcpSettings.bindings.find((b) => b.id === req.bindingId) ?? null;
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
    settings: params.accountMcpSettings,
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

      const accountSettingsContext = await bootstrapAccountSettingsContextImpl({
        credentials,
        mode: 'blocking',
        refresh: 'force',
      }).catch(() => null);

      const settingsObj = accountSettingsContext?.settings ?? {};
      const accountMcpSettings = readMcpServersSettingsFromAccountSettings(settingsObj);

      const resolution = resolveServerForTestRequest({ request: parsed.data as DaemonMcpServersTestRequest, accountMcpSettings });
      if (!resolution.ok) {
        const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
        return { ok: false, errorCode: resolution.errorCode, error: resolution.error, durationMs };
      }

      const settingsSecretsKey = credentials.encryption
        ? deriveSettingsSecretsKeyForCredentials(credentials)
        : null;
      const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(credentials);
      let sharedCatalog = {
        resources: accountSettingsContext?.savedSecretResources,
        state: accountSettingsContext?.savedSecretCatalogState,
      };
      const sharedReferences = listTestSharedSavedSecretReferences(resolution.resolved);
      if (sharedReferences.length > 0) {
        try {
          const admitted = await refreshSavedSecretCatalogForOperation({
            expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
            references: sharedReferences,
          });
          sharedCatalog = { resources: admitted.savedSecretResources, state: admitted.savedSecretCatalogState };
        } catch (error) {
          const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
          return { ok: false, errorCode: 'materialization_failed', error: redactErrorText(error), durationMs };
        }
      }
      const savedSecretMaterializer = createSavedSecretMaterializerV1({
        accountSettings: settingsObj,
        settingsSecretsReadKeys,
        resources: sharedCatalog.resources,
        resourceCatalogState: sharedCatalog.state,
      });

      let mcpConfig: { serverName: string; config: McpServerConfig; cleanup: () => void };
      try {
        const materialized = await materializeMcpServerConfigRecord({
          resolved: resolution.resolved,
          savedSecretsById: new Map(),
          savedSecretMaterializer,
          settingsSecretsKey,
          settingsSecretsReadKeys,
          processEnv: depsEnv,
          tmpDir: null,
          strictMode: true,
        });
        const config = materialized.mcpServers[resolution.serverName];
        if (!config) {
          materialized.cleanup();
          throw new Error('materialize_missing_config');
        }
        mcpConfig = { serverName: resolution.serverName, config, cleanup: materialized.cleanup };
      } catch (error) {
        const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
        return { ok: false, errorCode: 'materialization_failed', error: redactErrorText(error), durationMs };
      }

      try {
        const tools = await probeMcpStdioServerToolsImpl({ config: mcpConfig.config, baseEnv: depsEnv });
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
        const accountSettingsContext = await bootstrapAccountSettingsContextImpl({
          credentials,
          mode: 'blocking',
          refresh: 'force',
        });
        const settingsObj = accountSettingsContext?.settings ?? {};
        const accountMcpSettings = readMcpServersSettingsFromAccountSettings(settingsObj);
        const detected = await detectProviderMcpServersImpl({
          directory: parsed.data.directory,
          providers: undefined,
          env: depsEnv,
        });

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
