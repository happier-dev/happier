import { isDeepStrictEqual } from 'node:util';

import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import type { PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';

import type { ConnectedAccountCatalogKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { runConnectedAccountBindingStage } from '@/daemon/connectedServices/purposeBindings/bindingDiagnostics';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { replaceSavedSecretCatalogInSnapshot, withdrawSavedSecretCatalogInSnapshot, type ActiveAccountSettingsSnapshot, replaceSavedSecretLegacyImportInSnapshot, replaceProfileCatalogInSnapshot, replaceProviderConnectionsCatalogInSnapshot, preserveAccountCatalogsInSnapshot, preserveConnectedAccountCatalogCleanup, replaceNotificationChannelCatalogInSnapshot } from "@/settings/accountSettings/activeAccountSettingsSnapshot";
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

import type { SavedSecretCatalogResourceInputV1, SavedSecretCatalogState, SavedSecretLegacyImportResultV1 } from './savedSecretCatalog';
import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';

/** Invocation-owned Account custody; it never publishes to the daemon Account. */
export type SavedSecretOperationContextV1 = Readonly<{
  /** Existing authenticated Machine ingress, retained only in host-private invocation custody. */
  machineAdmission?: Readonly<Pick<NonNullable<RpcHandlerContext['machineAdmission']>, 'actorAccountId' | 'custodianAccountId'> & Partial<Pick<NonNullable<RpcHandlerContext['machineAdmission']>, 'role'>>>;
  /** The executing runtime's already held contribution projection. */
  secretSources?: TargetSecretSourcesV1;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  readSnapshot(): ActiveAccountSettingsSnapshot | null;
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  replaceAccountSettings(snapshot: ActiveAccountSettingsSnapshot): Promise<boolean>;
  commitLegacyImportResult(input: Readonly<{ expectedSettingsVersion: number; result: SavedSecretLegacyImportResultV1 }>): Promise<boolean>;
  commitProfileCatalog(input: Readonly<{ expectedSettingsVersion: number; catalog: ProfileCatalogSnapshotV1 }>): Promise<boolean>;
  commitNotificationChannelCatalog(input: Readonly<{ expectedSettingsVersion: number; catalog: NotificationChannelCatalogSnapshotV1 }>): Promise<boolean>;
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
  let sourceSnapshot = input.snapshot;
  let acpRevision = snapshot.acpCatalog?.status === 'ready' && typeof snapshot.acpCatalog.revision === 'number'
    ? snapshot.acpCatalog.revision : undefined;
  let mcpRevision = snapshot.mcpServerCatalog?.status === 'ready' && typeof snapshot.mcpServerCatalog.revision === 'number'
    ? snapshot.mcpServerCatalog.revision : undefined;
  const mcpListeners = new Set<() => void>();
  const notifyMcpCatalog = () => {
    for (const listener of mcpListeners) {
      try { listener(); } catch { logger.debug('[MCP] Captured catalog subscriber failed'); }
    }
  };
  const retire = () => {
    if (snapshot) withdrawSavedSecretCatalogInSnapshot(snapshot);
    snapshot = null;
    notifyMcpCatalog();
    mcpListeners.clear();
  };
  const readSnapshot = () => {
    if (!snapshot || !input.readSourceSnapshot) return snapshot;
    const next = input.readSourceSnapshot();
    if (!next || next.scopeKey !== scopeKey) {
      retire();
      return null;
    }
    if (next !== sourceSnapshot) {
      const previousMcpCatalog = snapshot.mcpServerCatalog;
      snapshot = preserveAccountCatalogsInSnapshot(snapshot, next, sourceSnapshot);
      sourceSnapshot = next;
      if (snapshot.acpCatalog?.status === 'ready' && typeof snapshot.acpCatalog.revision === 'number') {
        acpRevision = Math.max(acpRevision ?? 0, snapshot.acpCatalog.revision);
      }
      if (snapshot.mcpServerCatalog?.status === 'ready' && typeof snapshot.mcpServerCatalog.revision === 'number') {
        mcpRevision = Math.max(mcpRevision ?? 0, snapshot.mcpServerCatalog.revision);
      }
      if (snapshot.mcpServerCatalog !== previousMcpCatalog) notifyMcpCatalog();
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
    if (snapshot) snapshot = withdrawSavedSecretCatalogInSnapshot(snapshot);
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
    isCurrent,
    replaceAccountSettings: async (next: ActiveAccountSettingsSnapshot) => {
      if (next.scopeKey !== scopeKey || !await isCurrent() || !snapshot) return false;
      if (next.settingsVersion < snapshot.settingsVersion) return false;
      if (next.settingsVersion === snapshot.settingsVersion) return true;
      const resources = next.savedSecretResources ?? snapshot.savedSecretResources ?? [];
      const catalog = replaceSavedSecretCatalogInSnapshot(snapshot, {
        resources, state: next.savedSecretCatalogState ?? snapshot.savedSecretCatalogState ?? 'temporarily_unavailable',
      });
      snapshot = preserveAccountCatalogsInSnapshot(snapshot, { ...next,
        savedSecretResources: catalog.savedSecretResources, savedSecretCatalogState: catalog.savedSecretCatalogState });
      return true;
    },
    beginRefresh: () => { if (!snapshot) return false; withdrawCatalog(); return true; },
    commitLegacyImportResult: async (result: Parameters<SavedSecretOperationContextV1['commitLegacyImportResult']>[0]) => {
      if (!await isCurrent() || !snapshot || snapshot.settingsVersion !== result.expectedSettingsVersion) return false;
      snapshot = replaceSavedSecretLegacyImportInSnapshot(snapshot, result.result);
      return true;
    },
    commitProfileCatalog: async (profile: Parameters<SavedSecretOperationContextV1['commitProfileCatalog']>[0]) => {
      if (!await isCurrent() || !snapshot || snapshot.settingsVersion !== profile.expectedSettingsVersion) return false;
      snapshot = replaceProfileCatalogInSnapshot(snapshot, profile.catalog);
      return await isCurrent() && snapshot !== null && snapshot.settingsVersion === profile.expectedSettingsVersion;
    },
    commitAcpCatalog: async ({ catalog }: Parameters<SavedSecretOperationContextV1['commitAcpCatalog']>[0]) => {
      if (!await isCurrent() || !snapshot) return false;
      if (catalog.status === 'ready' && catalog.revision === 'absent'
        && (acpRevision !== undefined || catalog.sourceSettingsVersion !== snapshot.settingsVersion)) return false;
      if (catalog.status === 'ready' && typeof catalog.revision === 'number') {
        if (acpRevision !== undefined && catalog.revision < acpRevision) return false;
        acpRevision = catalog.revision;
      }
      if (!isDeepStrictEqual(snapshot.acpCatalog, catalog)) snapshot = { ...snapshot, acpCatalog: catalog };
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
        snapshot = { ...snapshot, mcpServerCatalog: catalog };
        notifyMcpCatalog();
      }
      return true;
    },
    subscribeMcpCatalog: (listener: () => void) => {
      if (!snapshot) return () => undefined;
      mcpListeners.add(listener);
      return () => { mcpListeners.delete(listener); };
    },
    commitProviderConnectionsCatalog: async ({ catalog, expectedSettingsVersion }: Parameters<SavedSecretOperationContextV1['commitProviderConnectionsCatalog']>[0]) => {
      if (!await isCurrent() || !snapshot) return false;
      if ((catalog.status === 'ready' || catalog.status === 'partial') && catalog.revision === 'absent'
        && snapshot.settingsVersion !== expectedSettingsVersion) return false;
      if (!isDeepStrictEqual(snapshot.providerConnectionsCatalog, catalog)) snapshot = replaceProviderConnectionsCatalogInSnapshot(snapshot, catalog);
      return true;
    },
    commitConnectedAccountCatalog: async ({ key, catalog }: Parameters<SavedSecretOperationContextV1['commitConnectedAccountCatalog']>[0]) => {
      if (!await isCurrent() || !snapshot || catalog.status === 'ready' && catalog.record.key !== key) return false;
      const facet = key === 'configurations' ? 'connectedConfigurationCatalog' : 'connectedPurposeCatalog';
      const observed = preserveConnectedAccountCatalogCleanup(snapshot[facet], catalog);
      if (!isDeepStrictEqual(snapshot[facet], observed)) snapshot = { ...snapshot, [facet]: observed };
      return true;
    },
    commitNotificationChannelCatalog: async (notification: Parameters<SavedSecretOperationContextV1['commitNotificationChannelCatalog']>[0]) => {
      if (!await isCurrent() || !snapshot || snapshot.settingsVersion !== notification.expectedSettingsVersion) return false;
      snapshot = replaceNotificationChannelCatalogInSnapshot(snapshot, notification.catalog);
      return await isCurrent() && snapshot !== null && snapshot.settingsVersion === notification.expectedSettingsVersion;
    },
    commitPromptLibraryCatalog: async ({ catalog, expectedSettingsVersion }: Parameters<SavedSecretOperationContextV1['commitPromptLibraryCatalog']>[0]) => {
      if (!await isCurrent() || !snapshot || snapshot.settingsVersion !== expectedSettingsVersion) return false;
      if (!isDeepStrictEqual(snapshot.promptLibraryCatalog, catalog)) snapshot = { ...snapshot, promptLibraryCatalog: catalog };
      return true;
    },
    commitCatalog: (catalog: Parameters<SavedSecretOperationContextV1['commitCatalog']>[0]) => {
      if (!snapshot) return false;
      snapshot = replaceSavedSecretCatalogInSnapshot(snapshot, catalog);
      return true;
    },
    withdrawCatalog,
  });
}
