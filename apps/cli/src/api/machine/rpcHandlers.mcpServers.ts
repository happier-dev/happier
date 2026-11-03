import { randomUUID } from 'node:crypto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonMcpServersDetectRequestSchema, DaemonMcpServersTestRequestSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { DaemonMcpServersPreviewRequestSchema } from '@happier-dev/protocol/mcp/servers/previewV1';
import { listMcpServerCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { estimateTokensV1 } from '@happier-dev/protocol/capabilities/estimateTokensV1';
import { isMcpPluginItemIdV1, type McpPluginItemV1, type McpServerToolsSnapshotV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { DaemonMcpServersPreviewResponse, DaemonMcpServersTestErrorCode, DaemonMcpServersDetectResponse, DaemonMcpServersDetectWarningV1, DaemonMcpServersTestRequest, DaemonMcpServersTestResponse, McpServersSettingsV1, McpServerMaterializationV1 } from '@happier-dev/protocol';

import type { McpServerConfig } from '@/agent';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext, type AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { loadFreshMcpAccountSettingsContext } from '@/cli/commands/mcp/loadFreshMcpAccountSettingsContext';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { resolveSessionCapabilitiesForDirectory } from '@/mcp/servers/resolveSessionCapabilitiesForDirectory';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { refreshSavedSecretCatalogForOperation } from "@/settings/secrets/hydrateSavedSecretCatalog";
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { McpServerProbeError, probeMcpStdioServerTools } from '@/mcp/servers/probeMcpStdioServerTools';
import { createCliMcpServerStoreForOperation } from '@/settings/mcp/mcpServerStore';
import { redactMcpServerProbeError } from '@/mcp/servers/redactMcpServerProbeError';
import { detectProviderMcpServers } from '@/mcp/providerDetection/detectProviderMcpServers';
import { resolveSessionMcpPreview } from '@/mcp/preview/resolveSessionMcpPreview';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readSkillLibraryInventory } from '@/prompts/skills/library/readSkillLibraryContent';
import { readAccountPluginSkills } from '@/prompts/skills/library/readAccountPluginSkills';
import { readAvailablePluginSkillItemsV1 } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView, readSessionOwnerLocality } from '@/session/transport/encryption/sessionEncryptionContext';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcHandlerContext } from '../rpc/types';
import type { IssueMcpTestRequestAuth, McpTestRequestAuthAttachment } from '@/daemon/connectedServices/requestAuth/createDaemonMcpRequestAuthForTest';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';

function redactErrorText(raw: unknown): string {
  return redactMcpServerProbeError(raw);
}

function nowMs(depsNowMs: (() => number) | undefined): number {
  if (typeof depsNowMs === 'function') return depsNowMs();
  return Date.now();
}

function resolveServerForTestRequest(params: Readonly<{
  request: DaemonMcpServersTestRequest;
  accountMcpSettings?: McpServersSettingsV1;
  mcpPluginItems?: readonly McpPluginItemV1[];
}>): { ok: true; serverName: string; resolved: McpServerMaterializationV1 } | { ok: false; errorCode: DaemonMcpServersTestErrorCode; error: string } {
  const req = params.request;
  const settings: McpServersSettingsV1 | undefined = req.t === 'draft'
    ? { v: 1, strictMode: true, servers: [req.server], bindings: req.binding ? [req.binding] : [] }
    : params.accountMcpSettings;
  if (!settings) return { ok: false, errorCode: 'materialization_failed', error: 'mcp_catalog_unavailable' };
  const server = req.t === 'draft' ? req.server : settings.servers.find((s) => s.id === req.serverId)
    ?? params.mcpPluginItems?.find(item => item.itemId === req.serverId)?.config;
  if (!server) return { ok: false, errorCode: 'server_not_found', error: 'Server id not found.' };
  const binding = req.t === 'draft' ? req.binding : req.bindingId ? settings.bindings.find((b) => b.id === req.bindingId) : undefined;
  if ((req.t === 'byId' && req.bindingId && !binding) || (binding && binding.serverId !== server.id)) {
    return { ok: false, errorCode: 'binding_not_found', error: 'Binding does not belong to the selected server.' };
  }
  // Test is an explicit one-server operation. Reach rules decide Session defaults,
  // not whether the person can check an Off server before adding it to a Session.
  const resolved = resolveSessionCapabilitiesForDirectory({
    settings,
    mcpPluginItems: params.mcpPluginItems,
    machineId: req.machineId,
    directory: req.directory,
    selection: { mcp: { v: 1, managedServersEnabled: false,
      forceIncludeServerIds: [server.id], forceExcludeServerIds: [] } },
  });
  const item = Object.values(resolved.selectedServersByName).find(item => item.serverId === server.id);
  if (!item) return { ok: false, errorCode: 'server_not_found', error: 'Server not found after resolution.' };
  if (item.enabled !== true) return { ok: false, errorCode: 'server_disabled', error: 'Server is not enabled for this target.' };
  return { ok: true, serverName: item.name, resolved: { directory: req.directory, strictMode: true, serversByName: { [item.name]: item } } };
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
    issueRequestAuth?: IssueMcpTestRequestAuth;
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
    async (raw: unknown, context?: RpcHandlerContext): Promise<DaemonMcpServersTestResponse> => {
      context?.signal.throwIfAborted();
      const parsed = DaemonMcpServersTestRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, errorCode: 'invalid_request', error: 'invalid_request', durationMs: 0 };
      }

      const startedAt = nowMs(params.deps?.nowMs);
      let pluginLease: PluginRuntimeRegistryLease | undefined;
      const pluginAttachments: Readonly<{ dispose(): void | Promise<void> }>[] = [];
      try {

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
          const accountMcpSettings = parsed.data.t === 'byId' ? readMcpServersSettingsFromAccountSettings(accountSettingsContext) : undefined;
          let mcpPluginItems: readonly McpPluginItemV1[] | undefined;
          if (parsed.data.t === 'byId' && isMcpPluginItemIdV1(parsed.data.serverId)) {
            pluginLease = await acquireAuthoritativePluginRuntimeRegistryLease();
            mcpPluginItems = await pluginLease.registry.projectMcpServerItems?.(accountMcpSettings!) ?? [];
          }
          resolution = resolveServerForTestRequest({ request: parsed.data, accountMcpSettings, mcpPluginItems });
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

        let requestAuth: McpTestRequestAuthAttachment | undefined;
        let mcpConfig: { serverName: string; config: McpServerConfig; cleanup: () => Promise<void>;
          sanitizeDiagnosticText: (value: string) => string;
          createDiagnosticStreamingSanitizer: Awaited<ReturnType<typeof materializeMcpServerConfigRecord>>['createDiagnosticStreamingSanitizer'];
        };
        try {
          if (pluginLease?.registry.materializePluginMcpServers) {
            const testSessionId = `mcp-test:${context?.transportRequestId ?? randomUUID()}`;
            const attached = await pluginLease.registry.materializePluginMcpServers({
              scope: { kind: 'session', sessionId: testSessionId }, directory: parsed.data.directory,
              signal: context?.signal, addDisposable: attachment => pluginAttachments.push(attachment),
              servers: Object.values(resolution.resolved.serversByName).map(server => ({
                id: server.serverId, name: server.name, title: server.config.title,
                transport: server.config.remote ? { kind: server.config.transport === 'sse' ? 'sse' as const : 'http' as const, url: server.config.remote.url }
                  : { kind: 'stdio' as const }, scope: { sessionId: testSessionId, directory: parsed.data.directory },
              })),
            });
            const item = resolution.resolved.serversByName[resolution.serverName];
            const server = attached.find(server => server.id === item?.serverId);
            if (!server || !item) throw new Error('materialize_missing_config');
            if (server.transport.kind === 'http' || server.transport.kind === 'sse') {
              resolution = { ...resolution, resolved: { ...resolution.resolved, serversByName: {
                [resolution.serverName]: { ...item, config: { ...item.config, remote: { ...item.config.remote!, url: server.transport.url } } },
              } } };
            }
          }
          const selected = resolution.resolved.serversByName[resolution.serverName]?.config;
          const remote = selected?.remote;
          if (selected && selected.transport !== 'stdio' && remote?.auth?.kind === 'oauth'
            && params.deps?.issueRequestAuth) {
            requestAuth = await params.deps.issueRequestAuth({ serverId: selected.id,
              resource: canonicalMcpOAuthResourceUrlV1(remote.url), materializationId: randomUUID() }, operationContext, context);
          }
          const materialized = await materializeMcpServerConfigRecord({
            resolved: resolution.resolved,
            savedSecretMaterializer,
            processEnv: depsEnv,
            tmpDir: null,
            strictMode: true,
            ...(requestAuth && selected ? { requestAuthByServerId: { [selected.id]: requestAuth } } : {}),
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
          mcpConfig = { serverName: resolution.serverName, config, cleanup: async () => {
            try { materialized.cleanup(); } finally { await requestAuth?.cleanup(); }
          },
            sanitizeDiagnosticText: materialized.sanitizeDiagnosticText,
            createDiagnosticStreamingSanitizer: materialized.createDiagnosticStreamingSanitizer };
        } catch (error) {
          await requestAuth?.cleanup();
          const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
          return { ok: false, errorCode: 'materialization_failed', error: redactErrorText(error), durationMs };
        }

        let probeCompleted = false;
        try {
          const probe = await probeMcpStdioServerToolsImpl({ config: mcpConfig.config, baseEnv: depsEnv,
            signal: context?.signal,
            sanitizeDiagnosticText: mcpConfig.sanitizeDiagnosticText,
            createDiagnosticStreamingSanitizer: mcpConfig.createDiagnosticStreamingSanitizer });
          probeCompleted = true;
          if (operationContext && !await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
          const { stderrTail, tools: definitions, ...metadata } = probe;
          const tools = definitions.map(({ inputSchema, ...tool }) => ({ ...tool,
            tokens: estimateTokensV1(tool.name + (tool.description ?? '') + JSON.stringify(inputSchema)) }));
          const toolsSnapshot: McpServerToolsSnapshotV1 = { ...metadata, tools,
            checkedAt: nowMs(params.deps?.nowMs), machineId: parsed.data.machineId };
          if (parsed.data.t === 'byId') {
            const capturedCatalog = accountSettingsContext.mcpServerCatalog;
            const serverId = parsed.data.serverId;
            if (!operationContext || capturedCatalog?.status !== 'ready' || capturedCatalog.revision === 'absent') {
              return { ok: false, errorCode: 'materialization_failed', error: 'mcp_catalog_unavailable',
                durationMs: Math.max(0, nowMs(params.deps?.nowMs) - startedAt) };
            }
            const updated = await createCliMcpServerStoreForOperation({ operationContext }).mutate({
              kind: 'tools-snapshot', serverId, snapshot: toolsSnapshot,
            }, capturedCatalog.revision, capturedCatalog);
            if (updated.status !== 'updated') return { ok: false, errorCode: 'materialization_failed',
              error: updated.status === 'conflict' ? 'mcp_tools_snapshot_conflict' : 'mcp_tools_snapshot_unavailable',
              ...(stderrTail ? { stderrTail } : {}), durationMs: Math.max(0, nowMs(params.deps?.nowMs) - startedAt) };
            if (!await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
          }
          const toolNames = tools.map((tool) => tool.name);
          const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
          return {
            ok: true,
            toolCount: toolNames.length,
            toolNamesSample: toolNames.slice(0, 20),
            tools, ...metadata, ...(stderrTail ? { stderrTail } : {}),
            durationMs,
          };
        } catch (error) {
          const durationMs = Math.max(0, nowMs(params.deps?.nowMs) - startedAt);
          const message = redactErrorText(mcpConfig.sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)));
          const cause = error instanceof McpServerProbeError ? error.spawnFailure ?? error.cause : error;
          const configuredCommand = resolution.resolved.serversByName[resolution.serverName]?.config.stdio?.command;
          const runtimeMissing = configuredCommand && cause && typeof cause === 'object'
            && 'code' in cause && cause.code === 'ENOENT' && 'path' in cause && cause.path === configuredCommand
            ? configuredCommand : undefined;
          const stderrTail = error instanceof McpServerProbeError ? error.stderrTail : undefined;
          const code = probeCompleted ? 'materialization_failed'
            : error instanceof McpServerProbeError ? error.phase === 'connect' ? 'mcp_connect_failed' : 'mcp_list_tools_failed'
              : message.includes('mcp_connect_timeout') ? 'mcp_connect_failed' : 'mcp_list_tools_failed';
          return { ok: false, errorCode: code, error: message, durationMs,
            ...(runtimeMissing ? { runtimeMissing } : {}), ...(stderrTail ? { stderrTail } : {}) };
        } finally {
          await mcpConfig.cleanup();
        }
      } finally {
        try { await Promise.all(pluginAttachments.map(attachment => attachment.dispose())); }
        finally { await pluginLease?.release(); }
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
    async (raw: unknown, context?: RpcHandlerContext): Promise<DaemonMcpServersPreviewResponse> => {
      context?.signal?.throwIfAborted();
      const parsed = DaemonMcpServersPreviewRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
      }

      const credentials = await readCredentialsImpl().catch(() => null);
      if (!credentials) {
        return { ok: false, errorCode: 'internal_error', error: 'missing_credentials' };
      }

      try {
        const artifacts = createCredentialedAccountArtifactStore(credentials);
        const inventoryRead = readSkillLibraryInventory(artifacts, context?.signal);
        // Catalog admission, exact Session resolution and the read-only Artifact
        // inventory are independent. Observe both promises even if either fails.
        const previewRead = (async () => {
          const [accountSettingsContext, session] = await Promise.all([
            loadFreshMcpAccountSettingsContext(credentials, { bootstrapAccountSettingsContext: bootstrapAccountSettingsContextImpl }),
            parsed.data.sessionId ? resolveSessionTransportContext({ reason: 'session-control', credentials, idOrPrefix: parsed.data.sessionId, signal: context?.signal }) : null,
          ]);
          const accountMcpSettings = readMcpServersSettingsFromAccountSettings(accountSettingsContext);
          const operationContext = accountSettingsContext.operationContext;
          let metadata: Record<string, unknown> = {};
          let sessionRunning = false;
          let directory = parsed.data.directory ?? null;
          let agentId = parsed.data.agentId;
          let capabilitySelection = parsed.data.capabilitySelection ?? (parsed.data.selection ? { mcp: parsed.data.selection } : null);
          if (parsed.data.sessionId) {
            if (!session?.ok || session.sessionId !== parsed.data.sessionId) throw new Error('session_unavailable');
            const opened = tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: session.accountEncryptionCurrentness.mode,
              rawSession: session.rawSession });
            if (!opened || readSessionOwnerLocality({ metadata: opened, rawSession: session.rawSession })?.machineId !== parsed.data.machineId) {
              throw new Error('session_unavailable');
            }
            metadata = opened;
            directory = typeof opened.path === 'string' ? opened.path : null;
            const target = resolveBackendTargetFromSessionMetadata(opened);
            if (target?.kind === 'backend') agentId = target.backendId;
            sessionRunning = session.rawSession.active === true;
            capabilitySelection = readSessionCapabilitySelectionFromMetadataV1(opened);
          }
          // Finite previews observe current destinations without starting retained-source
          // maintenance. Their independent inventories share only this request's lifetime.
          const [ruleCatalog, inventory, mcpPluginItems, pluginSkills, detected] = await Promise.all([
            createCliPromptLibraryStore({ credentials, operationContext, signal: context?.signal })
              .readCatalog(context?.signal, 'skill-rules'),
            inventoryRead,
            (async () => {
              const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
              try { return await lease.registry.projectMcpServerItems?.(accountMcpSettings) ?? []; }
              finally { await lease.release(); }
            })(),
            readAvailablePluginSkillItemsV1(() => readAccountPluginSkills({ credentials, settings: operationContext.readSnapshot()?.settings,
              serverHttpBaseUrl: operationContext.serverHttpBaseUrl, signal: context?.signal, availableOnly: true,
              isCurrent: () => operationContext.isCurrent() }), context?.signal),
            detectProviderMcpServersImpl({ directory, providers: [agentId], env: depsEnv }),
          ]);
          const rules = readPromptLibraryCatalogRecordV1({ ...ruleCatalog, key: 'skill-rules' });
          if (rules.status !== 'ready' || rules.record.key !== 'skill-rules') throw new Error('skill_rules_unavailable');
          if (!await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');

          const preview = await resolveSessionMcpPreview({
            settings: accountMcpSettings,
            machineId: parsed.data.machineId,
            directory,
            agentId,
            ...(parsed.data.projectKey !== undefined ? { projectKey: parsed.data.projectKey } : {}),
            sessionProject: { credentials, metadata, signal: context?.signal },
            capabilitySelection,
            sessionMetadata: metadata, sessionRunning,
            signal: context?.signal,
            skillLibrary: { inventory, artifacts, rules: rules.record.value.rules, pluginSkills }, mcpPluginItems,
            assertCurrent: async () => { context?.signal?.throwIfAborted();
              if (!await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
              context?.signal?.throwIfAborted(); },
            detectedServers: detected.servers,
            detectedWarnings: detected.warnings,
          });
          if (!await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
          context?.signal?.throwIfAborted();
          return preview;
        })();
        const [preview] = await Promise.all([previewRead, inventoryRead]);
        return preview;
      } catch (error) {
        context?.signal?.throwIfAborted();
        return { ok: false, errorCode: 'internal_error', error: redactErrorText(error) };
      }
    },
  );
}
