import { isDeepStrictEqual } from 'node:util';

import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import type { PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';

import type { ConnectedAccountCatalogKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

import { accountSettingsKeysChanged, type ActiveAccountSettingsKeys, type ActiveAccountSettingsSnapshotListener } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { runConnectedAccountBindingStage } from '@/daemon/connectedServices/purposeBindings/bindingDiagnostics';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { replaceSavedSecretCatalogInSnapshot, withdrawSavedSecretCatalogInSnapshot, type ActiveAccountSettingsSnapshot, replaceSavedSecretLegacyImportInSnapshot, replaceProfileCatalogInSnapshot, replaceProviderConnectionsCatalogInSnapshot, preserveAccountCatalogsInSnapshot, preserveConnectedAccountCatalogCleanup, replaceNotificationChannelCatalogInSnapshot, resolveAcpCatalogRevisionAdmission } from "@/settings/accountSettings/activeAccountSettingsSnapshot";
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

import type { SavedSecretCatalogResourceInputV1, SavedSecretCatalogState, SavedSecretLegacyImportResultV1 } from './savedSecretCatalog';
import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';

/** Invocation-owned Account custody; it never publishes to the daemon Account. */
export type SavedSecretOperationContextV1 = Readonly<{
  /** Existing authenticated Machine ingress, retained only in host-private invocation custody. */
  machineAdmission?: Readonly<Pick<NonNullable<RpcHandlerContext['machineAdmission']>, 'actorAccountId' | 'custodianAccountId'>
    & Partial<Pick<NonNullable<RpcHandlerContext['machineAdmission']>, 'role'>>>;
  /** The executing runtime's already held contribution projection. */
  secretSources?: TargetSecretSourcesV1;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  readSnapshot(): ActiveAccountSettingsSnapshot | null;
  subscribeAccountSettings(listener: () => void, keys: ActiveAccountSettingsKeys): () => void;
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  replaceAccountSettings(snapshot: ActiveAccountSettingsSnapshot, signal?: AbortSignal): Promise<boolean>;
  commitLegacyImportResult(input: Readonly<{ expectedSettingsVersion: number; result: SavedSecretLegacyImportResultV1 }>): Promise<boolean>;
  commitProfileCatalog(input: Readonly<{ expectedSettingsVersion: number; catalog: ProfileCatalogSnapshotV1 }>): Promise<boolean>;
  commitNotificationChannelCatalog(input: Readonly<{ expectedSettingsVersion: number; catalog: NotificationChannelCatalogSnapshotV1; signal?: AbortSignal }>): Promise<boolean>;
  commitAcpCatalog(input: Readonly<{ catalog: AcpCatalogSnapshotV1 }>): Promise<boolean>;
  commitMcpCatalog(catalog: McpServerCatalogSnapshotV1): Promise<boolean>;
  subscribeMcpCatalog(listener: () => void): () => void;
  commitProviderConnectionsCatalog(input: Readonly<{ expectedSettingsVersion: number; catalog: ProviderConnectionsCatalogSnapshotV1 }>): Promise<boolean>;
  commitConnectedAccountCatalog(input: Readonly<{ key: ConnectedAccountCatalogKeyV1; catalog: ConnectedAccountCatalogSnapshotV1 }>): Promise<boolean>;
  commitPromptLibraryCatalog(input: Readonly<{ expectedSettingsVersion: number; catalog: PromptLibraryCatalogSnapshotV1 }>): Promise<boolean>;
  beginRefresh(): boolean;
  commitCatalog(input: Readonly<{ resources: readonly SavedSecretCatalogResourceInputV1[]; state: SavedSecretCatalogState }>): boolean;
  withdrawCatalog(): void;
}>;

export function createInvocationSavedSecretOperationContextV1(input: Readonly<{
  machineAdmission?: SavedSecretOperationContextV1['machineAdmission'];
  secretSources?: TargetSecretSourcesV1;
  credentials: StoredCredentials;
  snapshot: ActiveAccountSettingsSnapshot;
  /** A long-lived Session refreshes source observations without replacing an in-flight reader. */
  readSourceSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  serverHttpBaseUrl: string;
  isCurrent(signal?: AbortSignal): Promise<boolean>;
}>): SavedSecretOperationContextV1 {
  const scopeKey = input.snapshot.scopeKey;
  if (!scopeKey || scopeKey !== resolveAccountSettingsScopeKeyForToken(input.credentials.token)) {
    throw new Error('saved_secret_account_snapshot_unavailable');
  }
  let snapshot: ActiveAccountSettingsSnapshot | null = input.snapshot;
  const settingsListeners = new Set<ActiveAccountSettingsSnapshotListener>();
  const replaceSnapshot = (next: ActiveAccountSettingsSnapshot | null) => {
    const previous = snapshot;
    snapshot = next;
    if (previous === next) return;
    for (const listener of settingsListeners) {
      try { listener(previous, next); } catch { logger.debug('[Settings] Captured subscriber failed'); }
    }
  };
  let sourceSnapshot = input.snapshot;
  let acpRevision = snapshot.acpCatalog && 'revision' in snapshot.acpCatalog && typeof snapshot.acpCatalog.revision === 'number'
    ? snapshot.acpCatalog.revision : undefined;
  let mcpRevision = snapshot.mcpServerCatalog?.status === 'ready' && typeof snapshot.mcpServerCatalog.revision === 'number'
    ? snapshot.mcpServerCatalog.revision : undefined;
  const subscribeAccountSettings = (listener: () => void, keys: ActiveAccountSettingsKeys) => {
    if (!snapshot) return () => undefined;
    const changed: ActiveAccountSettingsSnapshotListener = (previous, next) => {
      if (accountSettingsKeysChanged(previous, next, keys)) listener();
    };
    settingsListeners.add(changed);
    return () => { settingsListeners.delete(changed); };
  };
  const retire = () => {
    if (snapshot) withdrawSavedSecretCatalogInSnapshot(snapshot);
    replaceSnapshot(null);
    settingsListeners.clear();
  };
  const readSnapshot = () => {
    if (!snapshot || !input.readSourceSnapshot) return snapshot;
    const next = input.readSourceSnapshot();
    if (!next || next.scopeKey !== scopeKey) {
      retire();
      return null;
    }
    if (next !== sourceSnapshot) {
      const refreshed = preserveAccountCatalogsInSnapshot(snapshot, next, sourceSnapshot);
      const admission = refreshed.acpCatalog ? resolveAcpCatalogRevisionAdmission({ catalog: refreshed.acpCatalog,
        retainedRevision: acpRevision, settingsVersion: refreshed.settingsVersion }) : null;
      sourceSnapshot = next;
      replaceSnapshot(admission?.status === 'stale' ? { ...refreshed, acpCatalog: snapshot.acpCatalog } : refreshed);
      if (admission?.status === 'admitted') acpRevision = admission.revision;
      if (snapshot.mcpServerCatalog?.status === 'ready' && typeof snapshot.mcpServerCatalog.revision === 'number') {
        mcpRevision = Math.max(mcpRevision ?? 0, snapshot.mcpServerCatalog.revision);
      }
    }
    return snapshot;
  };
  const isCurrent = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!readSnapshot()) return false;
    // A failed observation grants no access, but also proves no revocation.
    // Preserve its typed cause and allow the same captured custody to recover.
    const current = await runConnectedAccountBindingStage('account_currentness', () => input.isCurrent(signal));
    // Canceling this reader is not evidence that the shared custody retired.
    signal?.throwIfAborted();
    if (!current && snapshot) retire();
    return current && readSnapshot() !== null;
  };
  const withdrawCatalog = () => {
    if (snapshot) replaceSnapshot(withdrawSavedSecretCatalogInSnapshot(snapshot));
  };
  // A requester Session runner holds the daemon's admission in its private credential custody.
  const requester = input.credentials.requesterSessionCredentialScope?.requesterSession;
  const machineAdmission = input.machineAdmission ?? (requester?.machineAdmission
    ? { actorAccountId: requester.attribution.accountId, ...requester.machineAdmission } : undefined);
  return Object.freeze({
    ...(machineAdmission ? { machineAdmission: Object.freeze({
      actorAccountId: machineAdmission.actorAccountId,
      custodianAccountId: machineAdmission.custodianAccountId,
      ...(machineAdmission.role ? { role: machineAdmission.role } : {}),
    }) } : {}),
    ...(input.secretSources ? { secretSources: input.secretSources } : {}),
    credentials: input.credentials,
    serverHttpBaseUrl: input.serverHttpBaseUrl,
    readSnapshot,
    subscribeAccountSettings,
    isCurrent,
    replaceAccountSettings: async (next: ActiveAccountSettingsSnapshot, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (next.scopeKey !== scopeKey || !readSnapshot() || !snapshot) return false;
      if (next.settingsVersion <= snapshot.settingsVersion) return true;
      const resources = next.savedSecretResources ?? snapshot.savedSecretResources ?? [];
      const catalog = replaceSavedSecretCatalogInSnapshot(snapshot, {
        resources, state: next.savedSecretCatalogState ?? snapshot.savedSecretCatalogState ?? 'temporarily_unavailable',
      });
      const refreshed = preserveAccountCatalogsInSnapshot(snapshot, { ...next,
        savedSecretResources: catalog.savedSecretResources, savedSecretCatalogState: catalog.savedSecretCatalogState });
      const admission = refreshed.acpCatalog ? resolveAcpCatalogRevisionAdmission({ catalog: refreshed.acpCatalog,
        retainedRevision: acpRevision, settingsVersion: refreshed.settingsVersion }) : null;
      replaceSnapshot(admission?.status === 'stale' ? { ...refreshed, acpCatalog: snapshot.acpCatalog } : refreshed);
      if (admission?.status === 'admitted') acpRevision = admission.revision;
      return true;
    },
    beginRefresh: () => { if (!snapshot) return false; withdrawCatalog(); return true; },
    commitLegacyImportResult: async (result: Parameters<SavedSecretOperationContextV1['commitLegacyImportResult']>[0]) => {
      if (!await isCurrent() || !snapshot || snapshot.settingsVersion !== result.expectedSettingsVersion) return false;
      replaceSnapshot(replaceSavedSecretLegacyImportInSnapshot(snapshot, result.result));
      return true;
    },
    commitProfileCatalog: async (profile: Parameters<SavedSecretOperationContextV1['commitProfileCatalog']>[0]) => {
      if (!readSnapshot() || !snapshot || snapshot.settingsVersion !== profile.expectedSettingsVersion) return false;
      replaceSnapshot(replaceProfileCatalogInSnapshot(snapshot, profile.catalog));
      return true;
    },
    commitAcpCatalog: async ({ catalog }: Parameters<SavedSecretOperationContextV1['commitAcpCatalog']>[0]) => {
      if (!await isCurrent() || !snapshot) return false;
      const admission = resolveAcpCatalogRevisionAdmission({ catalog, retainedRevision: acpRevision,
        settingsVersion: snapshot.settingsVersion });
      if (admission.status === 'stale') return false;
      acpRevision = admission.revision;
      if (!isDeepStrictEqual(snapshot.acpCatalog, catalog)) replaceSnapshot({ ...snapshot, acpCatalog: catalog });
      return true;
    },
    commitMcpCatalog: async (catalog: McpServerCatalogSnapshotV1) => {
      if (!await isCurrent() || !snapshot) return false;
      // An inactive source observation is not confirmed destination authority.
      if (catalog.status === 'ready' && catalog.revision === 'absent') return false;
      if (catalog.status === 'ready' && typeof catalog.revision === 'number') {
        if (mcpRevision !== undefined && catalog.revision < mcpRevision) return false;
        mcpRevision = catalog.revision;
      }
      if (!isDeepStrictEqual(snapshot.mcpServerCatalog, catalog)) {
        replaceSnapshot({ ...snapshot, mcpServerCatalog: catalog });
      }
      return true;
    },
    subscribeMcpCatalog: (listener: () => void) => subscribeAccountSettings(listener, { facets: ['mcpServerCatalog'] }),
    commitProviderConnectionsCatalog: async ({ catalog, expectedSettingsVersion }: Parameters<SavedSecretOperationContextV1['commitProviderConnectionsCatalog']>[0]) => {
      if (!await isCurrent() || !snapshot) return false;
      if ((catalog.status === 'ready' || catalog.status === 'partial') && catalog.revision === 'absent'
        && snapshot.settingsVersion !== expectedSettingsVersion) return false;
      if (!isDeepStrictEqual(snapshot.providerConnectionsCatalog, catalog)) replaceSnapshot(replaceProviderConnectionsCatalogInSnapshot(snapshot, catalog));
      return true;
    },
    commitConnectedAccountCatalog: async ({ key, catalog }: Parameters<SavedSecretOperationContextV1['commitConnectedAccountCatalog']>[0]) => {
      if (!readSnapshot() || !snapshot || catalog.status === 'ready' && catalog.record.key !== key) return false;
      const facet = key === 'configurations' ? 'connectedConfigurationCatalog' : 'connectedPurposeCatalog';
      const observed = preserveConnectedAccountCatalogCleanup(snapshot[facet], catalog);
      if (!isDeepStrictEqual(snapshot[facet], observed)) replaceSnapshot({ ...snapshot, [facet]: observed });
      return true;
    },
    commitNotificationChannelCatalog: async (notification: Parameters<SavedSecretOperationContextV1['commitNotificationChannelCatalog']>[0]) => {
      if (!await isCurrent(notification.signal) || !snapshot || snapshot.settingsVersion !== notification.expectedSettingsVersion) return false;
      replaceSnapshot(replaceNotificationChannelCatalogInSnapshot(snapshot, notification.catalog));
      return await isCurrent(notification.signal) && snapshot !== null && snapshot.settingsVersion === notification.expectedSettingsVersion;
    },
    commitPromptLibraryCatalog: async ({ catalog, expectedSettingsVersion }: Parameters<SavedSecretOperationContextV1['commitPromptLibraryCatalog']>[0]) => {
      if (!await isCurrent() || !snapshot || snapshot.settingsVersion !== expectedSettingsVersion) return false;
      if (!isDeepStrictEqual(snapshot.promptLibraryCatalog, catalog)) replaceSnapshot({ ...snapshot, promptLibraryCatalog: catalog });
      return true;
    },
    commitCatalog: (catalog: Parameters<SavedSecretOperationContextV1['commitCatalog']>[0]) => {
      if (!snapshot) return false;
      replaceSnapshot(replaceSavedSecretCatalogInSnapshot(snapshot, catalog));
      return true;
    },
    withdrawCatalog,
  });
}
