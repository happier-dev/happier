import type { StoredCredentials } from '@/persistence';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { listMcpServerCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveSessionCapabilitiesForDirectory } from '@/mcp/servers/resolveSessionCapabilitiesForDirectory';
import { projectMcpServerMaterializationV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { readSavedSecretMaterializerForOperation } from "@/settings/secrets/savedSecretCatalogRead";
import { type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";

export async function resolveCustomHappierToolsContext(params: Readonly<{
  credentials: StoredCredentials;
  accountSettingsSnapshot?: ActiveAccountSettingsSnapshot | null;
  operationContext: SavedSecretOperationContextV1;
  signal?: AbortSignal;
  machineId: string;
  directory: string;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<Awaited<ReturnType<typeof materializeMcpServerConfigRecord>>> {
  const snapshot = params.accountSettingsSnapshot ?? null;
  const context = params.operationContext;
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
    processEnv: params.processEnv ?? process.env,
    tmpDir: null,
    strictMode: resolved.strictMode,
  });
  if (!await context.isCurrent()) {
    materialized.cleanup();
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  return materialized;
}
