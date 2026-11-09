import type { StoredCredentials } from '@/persistence';
import type { AdmittedMcpStdioRuntime, PrepareMcpStdioTransport } from '@/mcp/runtime/supervisedStdioTransport';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { listMcpServerCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveSessionCapabilitiesForDirectory } from '@/mcp/servers/resolveSessionCapabilitiesForDirectory';
import { projectMcpServerMaterializationV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { readSavedSecretMaterializerForOperation } from "@/settings/secrets/savedSecretCatalogRead";
import { type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { assertMcpStdioExecutionSupported, readMcpExecutionSource, type McpExecutionSource } from '@/mcp/runtime/mcpExecutionSource';

export async function resolveCustomHappierToolsContext(params: Readonly<{
  credentials: StoredCredentials;
  accountSettingsSnapshot?: ActiveAccountSettingsSnapshot | null;
  operationContext: SavedSecretOperationContextV1;
  signal?: AbortSignal;
  machineId: string;
  directory: string;
  processEnv?: NodeJS.ProcessEnv;
  isolationEnabled?: boolean;
  localWorkflow?: boolean;
  readExecutionSource?: (signal?: AbortSignal) => Promise<McpExecutionSource>;
  admittedStdio?: AdmittedMcpStdioRuntime;
}>): Promise<Awaited<ReturnType<typeof materializeMcpServerConfigRecord>> & Readonly<{ prepareTransport?: PrepareMcpStdioTransport }>> {
  const snapshot = params.accountSettingsSnapshot ?? null;
  const context = params.operationContext;
  const executionSource = params.readExecutionSource ? await params.readExecutionSource(params.signal)
    : await readMcpExecutionSource({ credentials: params.credentials,
    localWorkflow: params.localWorkflow,
    catalogCredentials: context.credentials, machineId: params.machineId,
    serverHttpBaseUrl: context.serverHttpBaseUrl, signal: params.signal });
  const scopeKey = runWithServerHttpBaseUrl(context.serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(params.credentials));
  if (!await context.isCurrent() || context.credentials.token !== params.credentials.token
    || snapshot?.scopeKey !== scopeKey || context.readSnapshot()?.scopeKey !== scopeKey) {
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  const settings = readMcpServersSettingsFromAccountSettings(snapshot);
  // This machine view intentionally has no Session override or Agent qualifier.
  const capabilities = resolveSessionCapabilitiesForDirectory({
    settings,
    machineId: params.machineId,
    directory: params.directory,
  });
  const resolved = projectMcpServerMaterializationV1(capabilities, params.directory);
  if (!params.admittedStdio && Object.values(resolved.serversByName).some(server => server.enabled)) {
    await assertMcpStdioExecutionSupported(executionSource, params.isolationEnabled, params.signal);
  }
  const references = [...new Set(listMcpServerCatalogSavedSecretRefsV1({ v: 1, bindings: [], servers:
    Object.values(resolved.serversByName).filter(server => server.enabled === true).map(server => server.config),
  }).map(reference => reference.secretId))];
  const admitted = await runWithServerHttpBaseUrl(context.serverHttpBaseUrl, () => readSavedSecretMaterializerForOperation({
    expectedScopeKey: scopeKey, operationContext: context, references: references.map(ref => ({ ref })), signal: params.signal,
  }));
  const savedSecretMaterializer = admitted.materializer;
  const materialized = await materializeMcpServerConfigRecord({
    resolved,
    savedSecretMaterializer,
    processEnv: params.admittedStdio?.environment ?? params.processEnv ?? process.env,
    tmpDir: null,
    signal: params.signal,
    agentLaunchTarget: params.admittedStdio?.target,
    strictMode: resolved.strictMode,
  });
  if (!await context.isCurrent()) {
    materialized.cleanup();
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  return { ...materialized,
    ...(params.admittedStdio ? { prepareTransport: ((config, signal) => params.admittedStdio!.prepareTransport({
      config, selectedMaterials: materialized.selectedMaterials ?? [], signal,
    })) satisfies PrepareMcpStdioTransport } : {}),
  };
}
