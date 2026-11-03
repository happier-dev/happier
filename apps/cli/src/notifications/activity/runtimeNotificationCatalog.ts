import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import type { AccountSettings } from '@happier-dev/protocol';
import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { hydrateNotificationChannelCatalogForOperation } from '@/settings/notifications/hydrateNotificationChannelCatalog';
import { createSavedSecretMaterializerFromSnapshotV1, type SavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { readSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export class NotificationChannelCatalogUnavailableError extends Error {
  readonly code = 'notification_channel_catalog_unavailable' as const;
  constructor(readonly reason: string) {
    super('Notification channel catalog is unavailable');
    this.name = 'NotificationChannelCatalogUnavailableError';
  }
}

async function observeCurrent(read: (signal?: AbortSignal) => boolean | Promise<boolean>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try { return await read(signal); }
  finally { signal?.throwIfAborted(); }
}

export async function readRuntimeNotificationCatalog(params: Readonly<{
  settings: AccountSettings | null | undefined;
  signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  secretSources?: TargetSecretSourcesV1;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: (signal?: AbortSignal) => boolean | Promise<boolean>;
}>) {
  params.signal?.throwIfAborted();
  const operation = params.operationContext;
  if (operation) {
    if (!await observeCurrent(signal => operation.isCurrent(signal), params.signal)) throw new NotificationChannelCatalogUnavailableError('scope-retired');
    params.signal?.throwIfAborted();
    const existing = operation.readSnapshot()?.notificationChannelCatalog;
    if (!existing || existing.status === 'loading') await hydrateNotificationChannelCatalogForOperation({ operationContext: operation, signal: params.signal });
    params.signal?.throwIfAborted();
    const initialSnapshot = operation.readSnapshot();
    if (!initialSnapshot || !await observeCurrent(signal => operation.isCurrent(signal), params.signal)) throw new NotificationChannelCatalogUnavailableError('scope-retired');
    let snapshot = initialSnapshot;
    params.signal?.throwIfAborted();
    const catalog = snapshot.notificationChannelCatalog;
    if (catalog?.status !== 'ready') throw new NotificationChannelCatalogUnavailableError(
      catalog?.status === 'unavailable' ? catalog.reason : catalog?.status === 'partial' ? 'catalog-incomplete' : 'loading');
    return { settings: snapshot.settings, channels: catalog.channels,
      acquireSigningMaterializer: async (references: readonly string[], signal?: AbortSignal) => {
        if (references.length === 0 || !snapshot?.scopeKey) return createSavedSecretMaterializerFromSnapshotV1(snapshot);
        const expectedScopeKey = snapshot.scopeKey;
        const admitted = await runWithServerHttpBaseUrl(operation.serverHttpBaseUrl, () => readSavedSecretMaterializerForOperation({ expectedScopeKey,
          references: references.map(ref => ({ ref })), operationContext: operation, secretSources: params.secretSources, signal }));
        snapshot = admitted.snapshot;
        return admitted.materializer;
      },
      assertCurrent: async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (!await observeCurrent(signal => operation.isCurrent(signal), signal) || operation.readSnapshot() !== snapshot
          || params.isCurrent && !await observeCurrent(params.isCurrent, signal)) {
          throw new NotificationChannelCatalogUnavailableError('scope-retired');
        }
        signal?.throwIfAborted();
      }, savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot,
        { isCurrent: () => operation.readSnapshot() === snapshot }) };
  }
  const active = getActiveAccountSettingsSnapshot();
  let captured = active?.settings === params.settings ? active : null;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const incumbent = !params.notificationChannelCatalog && captured?.scopeKey ? { scopeKey: captured.scopeKey, lifetimeToken } : null;
  const catalog = params.notificationChannelCatalog ?? captured?.notificationChannelCatalog ?? { status: 'loading' as const };
  if (catalog.status !== 'ready') throw new NotificationChannelCatalogUnavailableError(
    catalog.status === 'unavailable' ? catalog.reason : catalog.status === 'partial' ? 'catalog-incomplete' : 'loading');
  return { settings: params.settings, channels: catalog.channels,
    acquireSigningMaterializer: async (references: readonly string[], signal?: AbortSignal) => {
      if (params.savedSecretMaterializer) return params.savedSecretMaterializer;
      if (references.length === 0 || !captured?.scopeKey) return captured ? createSavedSecretMaterializerFromSnapshotV1(captured) : undefined;
      const admitted = await readSavedSecretMaterializerForOperation({ expectedScopeKey: captured.scopeKey,
        references: references.map(ref => ({ ref })), secretSources: params.secretSources, signal });
      captured = admitted.snapshot;
      return admitted.materializer;
    }, assertCurrent: async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (params.isCurrent && !await observeCurrent(params.isCurrent, signal)
      || incumbent && !isActiveAccountSettingsSnapshotLifetimeCurrent(incumbent)) throw new NotificationChannelCatalogUnavailableError('scope-retired');
    signal?.throwIfAborted();
  }, savedSecretMaterializer: params.savedSecretMaterializer ?? (!params.notificationChannelCatalog && captured
    ? createSavedSecretMaterializerFromSnapshotV1(captured) : undefined) };
}
