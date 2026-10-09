import type { BackendTargetRefV1, McpValueRefV1 } from '@happier-dev/protocol';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AcpProbeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import { materializeConfiguredAcpEnvironment } from '@/agent/acp/catalog/configured/materializeEnvironment';
import { AcpCatalogUnavailableError, requireReadyAcpCatalog, resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
  refreshSavedSecretCatalogForOperation,
  SavedSecretOperationAdmissionError,
  savedSecretOperationAdmissionStatus,
  type SavedSecretOperationContextV1,
} from '@/settings/secrets/hydrateSavedSecretCatalog';
import { SavedSecretResolutionError } from '@/settings/secrets/savedSecretCatalog';

import { isConfiguredAcpProbeTarget } from './isConfiguredAcpProbeTarget';

function tryResolveLiteralConfiguredAcpEnvironment(
  env: Readonly<Record<string, McpValueRefV1>>,
): Record<string, string> | null {
  const launchEnv: Record<string, string> = {};
  for (const [envKey, valueRef] of Object.entries(env)) {
    if (valueRef.t !== 'literal') {
      return null;
    }
    launchEnv[envKey] = valueRef.v;
  }
  return launchEnv;
}

const abortingPermissionHandler: AcpPermissionHandler = {
  handleToolCall: async () => ({ decision: 'abort' }),
};

export async function createConfiguredAcpProbeBackend(params: Readonly<{
  agentId: CatalogAgentLookupId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: StoredCredentials | null;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
  savedSecretOperationContext?: SavedSecretOperationContextV1;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<AcpProbeBackend | null> {
  if (!isConfiguredAcpProbeTarget(params)) return null;

  const operationContext = params.savedSecretOperationContext;
  const readSnapshot = () => operationContext ? operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  if (operationContext && !await operationContext.isCurrent()) throw new AcpCatalogUnavailableError('scope-retired');
  let accountSnapshot = readSnapshot();
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  if (!accountSnapshot || params.accountSettings && params.accountSettings !== accountSnapshot.settings) {
    throw new AcpCatalogUnavailableError('settings-snapshot-unavailable');
  }
  if (!accountSnapshot.scopeKey) throw new AcpCatalogUnavailableError('account-settings-unavailable');
  const scopeKey = accountSnapshot.scopeKey;
  const credentials = params.credentials ?? operationContext?.credentials;
  const credentialsScope = credentials && (operationContext
    ? runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(credentials))
    : resolveAccountSettingsScopeKey(credentials));
  if (credentialsScope && accountSnapshot.scopeKey !== credentialsScope) {
    throw new AcpCatalogUnavailableError('scope-retired');
  }
  if (params.acpCatalogSnapshot && params.acpCatalogSnapshot !== accountSnapshot.acpCatalog) {
    throw new AcpCatalogUnavailableError('catalog-stale');
  }
  const assertCurrent = async () => {
    if (operationContext && !await operationContext.isCurrent()) throw new AcpCatalogUnavailableError('scope-retired');
    const current = readSnapshot();
    if (!current || current.scopeKey !== scopeKey
      || !operationContext && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      throw new AcpCatalogUnavailableError('scope-retired');
    }
    return current;
  };
  if (accountSnapshot.acpCatalog?.status !== 'ready' && credentials) {
    const { refreshActiveAcpCatalog } = await import('@/agent/acp/catalog/hydrateAcpCatalog');
    await refreshActiveAcpCatalog({ credentials, operationContext });
    accountSnapshot = await assertCurrent();
  }
  const catalog = requireReadyAcpCatalog(accountSnapshot.acpCatalog);
  const backend = resolveConfiguredAcpBackendFromAccountSettings(
    accountSnapshot.settings,
    params.backendTarget.backendId,
    catalog,
  );
  if (!backend) return null;

  const { createConfiguredAcpBackend } = await import('@/agent/acp/catalog/configured/createConfiguredAcpBackend');
  if ((await assertCurrent()).acpCatalog !== catalog) throw new AcpCatalogUnavailableError('catalog-stale');
  let launchEnv = tryResolveLiteralConfiguredAcpEnvironment(backend.env);
  if (launchEnv === null) {
    if (!credentials) throw new AcpCatalogUnavailableError('credentials-unavailable');
    const references = Object.values(backend.env)
      .flatMap(value => value.t === 'savedSecret' ? [{ ref: value.secretId }] : []);
    if (references.length > 0) {
      try {
        const refresh = () => refreshSavedSecretCatalogForOperation({
          expectedScopeKey: scopeKey,
          references,
          operationContext,
        });
        await (operationContext
          ? runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl, refresh)
          : refresh());
      } catch (error) {
        if (!(error instanceof SavedSecretOperationAdmissionError)) throw error;
        const field = Object.entries(backend.env)
          .find(([, value]) => value.t === 'savedSecret' && value.secretId === error.reference)?.[0];
        throw new SavedSecretResolutionError({
          status: savedSecretOperationAdmissionStatus(error.reason),
          reference: error.reference,
          consumer: 'acp',
          field: `env:${field ?? error.reference}`,
        });
      }
    }
    accountSnapshot = await assertCurrent();
    if (accountSnapshot.acpCatalog !== catalog) throw new AcpCatalogUnavailableError('catalog-stale');
    launchEnv = materializeConfiguredAcpEnvironment({
      backend,
      accountSettings: accountSnapshot.settings,
      credentials,
      processEnv: params.processEnv,
      savedSecretResources: accountSnapshot.savedSecretResources,
    });
  }

  return createConfiguredAcpBackend({
    cwd: params.cwd,
    env: params.processEnv,
    backend,
    launchEnv,
    mcpServers: {},
    permissionHandler: abortingPermissionHandler,
  });
}
