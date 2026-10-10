import type { StoredCredentials } from '@/persistence';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { listMcpServerCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveEffectiveMcpServersForDirectory } from '@/mcp/servers/resolveEffectiveMcpServersForDirectory';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { readSavedSecretCatalogForOperation, type SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

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
  const resolved = resolveEffectiveMcpServersForDirectory({
    settings,
    machineId: params.machineId,
    directory: params.directory,
  });
  const references = [...new Set(listMcpServerCatalogSavedSecretRefsV1({ v: 1, bindings: [], servers:
    Object.values(resolved.serversByName).filter(server => server.enabled === true).map(server => server.config),
  }).map(reference => reference.secretId))];
  const admitted = await runWithServerHttpBaseUrl(context.serverHttpBaseUrl, () => readSavedSecretCatalogForOperation({
    expectedScopeKey: scopeKey, operationContext: context, references: references.map(ref => ({ ref })), signal: params.signal,
  }));
  const savedSecretMaterializer = createSavedSecretMaterializerFromSnapshotV1(admitted, { isCurrent: () => context.readSnapshot() === admitted });
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
