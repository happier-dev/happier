import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { resolveProfiledActionsSettingsV1, resolveSessionApprovalProfileReferenceV1, type ReadableApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { bindApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import type { AccountSettings, ActionsSettingsV1 } from '@happier-dev/protocol';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import type { StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from './secrets/savedSecretOperationContext';

import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, readActiveAccountRoleOverrides, readAccountRoleOverridesFromSnapshot, type ActiveAccountSettingsSnapshot } from './accountSettings/activeAccountSettingsSnapshot';
import { readActionsSettingsOverrideFromEnv } from './actionsSettingsOverride';

/** Narrow host-reviewed policy accepted by ordinary and restricted runtime constructors. */
export type RuntimeActionSettingsProvider = Readonly<{
  getActionsSettings: () => ActionsSettingsV1;
  getAccountSettings?: () => AccountSettings | null;
  getAccountRoleOverrides?: () => AccountRoleOverridesReadV1;
  getApprovalProfiles?: () => readonly ReadableApprovalProfileV1[] | undefined;
  prepareApprovalProfiles?: (signal?: AbortSignal) => Promise<void>;
}>;

export type ActionSettingsProvider = Readonly<{
  getAccountSettings: () => AccountSettings | null;
  getActionsSettings: () => ActionsSettingsV1;
  getAccountRoleOverrides: () => AccountRoleOverridesReadV1;
  getApprovalProfiles: () => readonly ReadableApprovalProfileV1[] | undefined;
  prepareApprovalProfiles?: (signal?: AbortSignal) => Promise<void>;
}>;

/** Invocation-owned policy follows its retained Account reader, never the focused host Account. */
export function createSnapshotActionSettingsProvider(readSnapshot: () => ActiveAccountSettingsSnapshot,
  operationContext?: SavedSecretOperationContextV1): ActionSettingsProvider {
  return {
    getActionsSettings: () => readSnapshot().settings.actionsSettingsV1,
    getAccountSettings: () => readSnapshot().settings,
    getAccountRoleOverrides: () => readAccountRoleOverridesFromSnapshot(readSnapshot()),
    getApprovalProfiles: () => { const snapshot = readSnapshot(); return snapshot.source === 'none' ? undefined : snapshot.approvalProfileCatalog; },
    ...(operationContext ? { prepareApprovalProfiles: async (signal?: AbortSignal) => {
      if (readSnapshot().approvalProfileCatalog !== undefined) return;
      const { refreshActiveApprovalProfileCatalog } = await import('./profiles/hydrateProfileCatalog');
      await refreshActiveApprovalProfileCatalog({ credentials: operationContext.credentials, operationContext, signal });
    } } : {}),
  };
}

function readAccountSettingsSafely(getAccountSettings?: (() => AccountSettings | null) | null): AccountSettings | null {
  if (!getAccountSettings) return null;
  try {
    return getAccountSettings() ?? null;
  } catch {
    return null;
  }
}

/**
 * Credential-scoped runtimes consume only their bound Account policy. Unscoped
 * ordinary CLI consumers retain the explicit environment override, then the
 * live/injected Account snapshot and defaults.
 */
export function createActionSettingsProvider(params: Readonly<{
  accountSettings?: AccountSettings | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  /** Credential-derived Account scope for long-lived runtime policy. */
  scopeKey?: string | null;
  /** Session ingress retains host policy rather than standalone CLI environment policy. */
  allowEnvironmentOverride?: boolean;
  credentials?: StoredCredentials | null;
}> = {}): ActionSettingsProvider {
  const initialSnapshot = getActiveAccountSettingsSnapshot();
  const scopeKey = params.scopeKey ?? null;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  let catalogLifetimeToken = initialSnapshot?.scopeKey === scopeKey ? lifetimeToken : undefined;
  let boundSettings = scopeKey && initialSnapshot?.scopeKey === scopeKey && initialSnapshot.source !== 'none'
    ? initialSnapshot.settings
    : params.accountSettings ?? null;
  const getAccountSettings = (): AccountSettings | null => {
    const current = getActiveAccountSettingsSnapshot();
    // A different active Account cannot retarget an already constructed runtime.
    // Unscoped snapshots cannot prove correspondence with a later publication.
    if (scopeKey) {
      // A private invocation's admitted getter is its bound authority. A retired
      // getter must not fall back to a focused Account or cached preferences.
      if (params.getAccountSettings) return readAccountSettingsSafely(params.getAccountSettings);
      if (current?.scopeKey === scopeKey) boundSettings = current.source === 'none' ? null : current.settings;
      return boundSettings;
    }
    return readAccountSettingsSafely(params.getAccountSettings)
      ?? (current && current.source !== 'none' ? current.settings : null)
      ?? params.accountSettings
      ?? null;
  };
  return {
    getAccountSettings,
    getApprovalProfiles: () => {
      const current = getActiveAccountSettingsSnapshot();
      if (catalogLifetimeToken === undefined && current?.scopeKey === scopeKey) catalogLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
      return current?.source !== 'none' && (!scopeKey || current?.scopeKey === scopeKey
        && getActiveAccountSettingsSnapshotLifetimeToken() === catalogLifetimeToken) ? current?.approvalProfileCatalog : undefined;
    },
    ...(params.credentials ? { prepareApprovalProfiles: async (signal?: AbortSignal) => {
      if (catalogLifetimeToken !== undefined && (getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey
        || getActiveAccountSettingsSnapshotLifetimeToken() !== catalogLifetimeToken)) return;
      if (getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey && getActiveAccountSettingsSnapshot()?.approvalProfileCatalog !== undefined) return;
      const { refreshActiveApprovalProfileCatalog } = await import('./profiles/hydrateProfileCatalog');
      await refreshActiveApprovalProfileCatalog({ credentials: params.credentials!, signal });
    } } : {}),
    getAccountRoleOverrides: () => {
      const current = getActiveAccountSettingsSnapshot();
      const roleScope = scopeKey ?? current?.scopeKey;
      if (!roleScope) return { status: 'unavailable', reason: 'source-unavailable' };
      return readActiveAccountRoleOverrides({ scopeKey: roleScope,
        lifetimeToken: scopeKey ? lifetimeToken : getActiveAccountSettingsSnapshotLifetimeToken() });
    },
    getActionsSettings: () => {
      const accountSettings = getAccountSettings();
      // AccountSettings was admitted by the Account source. Re-read its current
      // projection without re-parsing and rebuilding the whole policy per check.
      const override = !scopeKey && params.allowEnvironmentOverride !== false
        ? readActionsSettingsOverrideFromEnv() : null;
      return override ?? accountSettings?.actionsSettingsV1 ?? normalizeActionsSettingsV1(undefined);
    },
  };
}

/**
 * A bound Session's advertisement view: the Account settings with that Session's approval
 * profile applied, so a profile's Off hides the tool. Approval routing keeps the Account
 * settings plus the profile reference and applies the same overlay itself.
 */
export function createSessionActionSettingsView(provider: RuntimeActionSettingsProvider,
  readSessionMetadata: () => Readonly<{ approvalProfileId?: unknown; approvalProfileTeamOrGroupDerived?: unknown }> | null | undefined,
): RuntimeActionSettingsProvider {
  let last: Readonly<{ settings: ActionsSettingsV1; profileId: unknown; derived: boolean;
    catalog: readonly ReadableApprovalProfileV1[] | undefined; effective: ActionsSettingsV1 }> | undefined;
  return { ...provider, getActionsSettings: () => {
    const settings = provider.getActionsSettings();
    const metadata = readSessionMetadata();
    const catalog = provider.getApprovalProfiles?.();
    // Enablement runs once per tool per listing; rebuild only when a fact changed.
    if (last?.settings === settings && last.profileId === metadata?.approvalProfileId
      && last.catalog === catalog && last.derived === (metadata?.approvalProfileTeamOrGroupDerived === true)) return last.effective;
    const approvalProfileId = metadata ? resolveSessionApprovalProfileReferenceV1(metadata) : null;
    last = { settings, profileId: metadata?.approvalProfileId, derived: metadata?.approvalProfileTeamOrGroupDerived === true,
      catalog, effective: resolveProfiledActionsSettingsV1(settings, approvalProfileId,
        { boundProfile: approvalProfileId ? bindApprovalProfileV1(catalog ?? [], approvalProfileId) : null,
          approvalProfileTeamOrGroupDerived: metadata?.approvalProfileTeamOrGroupDerived === true }).settings };
    return last.effective;
  } };
}
