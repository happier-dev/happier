import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { prepareActiveMcpServerCatalog } from '@/settings/mcp/hydrateMcpServerCatalog';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';

import type { McpCommandDeps } from './deps';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';

type FreshMcpAccountSettingsContext = AccountSettingsContext & Readonly<{
  scopeKey: string;
  mcpServerCatalog: Extract<McpServerCatalogSnapshotV1, { status: 'ready' }>;
  operationContext: SavedSecretOperationContextV1;
}>;

type FreshMcpAccountSettingsDeps = Pick<
  McpCommandDeps,
  'bootstrapAccountSettingsContext'
>;

export async function loadFreshMcpAccountSettingsContext(
  credentials: StoredCredentials,
  deps: FreshMcpAccountSettingsDeps,
): Promise<FreshMcpAccountSettingsContext> {
  const settings = await deps.bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: 'force',
  } as const);
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  const assertCurrent = () => {
    if (settings.scopeKey !== scopeKey || getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey
      || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      throw new McpServerCatalogUnavailableError('scope-retired');
    }
  };
  assertCurrent();
  await prepareActiveMcpServerCatalog({ credentials, scopeKey, lifetimeToken, refresh: true });
  assertCurrent();
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot) throw new McpServerCatalogUnavailableError('scope-retired');
  readMcpServersSettingsFromAccountSettings(snapshot);
  const admittedCatalog = snapshot.mcpServerCatalog;
  if (admittedCatalog?.status !== 'ready') throw new McpServerCatalogUnavailableError('catalog-unobserved');
  const capturedSnapshot = Object.freeze({
    ...snapshot,
    scopeKey,
    mcpServerCatalog: admittedCatalog,
    whenRefreshed: null,
  });
  const operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
    credentials, snapshot: capturedSnapshot, serverHttpBaseUrl, isCurrent: async () => { assertCurrent(); return true; },
  }));
  return Object.freeze({ ...capturedSnapshot, operationContext });
}
