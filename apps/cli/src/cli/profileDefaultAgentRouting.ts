import { getProfileDefaultBackendTarget, resolveBackendProfile, type AIBackendProfile, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { bootstrapAccountSettingsContext, type AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveSessionStartAccountSettingsContext } from '@/settings/accountSettings/resolveSessionStartAccountSettingsContext';
import { resolveSessionStartAccountSettingsRefreshMode } from '@/settings/accountSettings/resolveSessionStartAccountSettingsRefreshMode';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { assertProfileCompatibleWithBackendTarget } from '@/settings/profiles/resolveProfileForAgent';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import type { CommandContext } from '@/cli/commandRegistry';

export async function loadProfileRoutingAccountSettings(params: Readonly<{
  credentials: Credentials;
  startedBy?: 'terminal' | 'daemon';
  refreshRequested?: boolean;
}>): Promise<AccountSettingsContext> {
  const startedBy = params.startedBy ?? 'terminal';
  const mode = startedBy === 'daemon' ? 'blocking' : 'fast';
  const snapshot = await bootstrapAccountSettingsContext({
    credentials: params.credentials,
    mode,
    refresh: resolveSessionStartAccountSettingsRefreshMode({ mode, refreshRequested: params.refreshRequested === true }),
  });
  return resolveSessionStartAccountSettingsContext({ startedBy, snapshot, refreshRequested: params.refreshRequested });
}

export async function fetchCustomProfilesForProfileRouting(credentials: Credentials): Promise<ReadonlyArray<AIBackendProfile>> {
  const snapshot = await loadProfileRoutingAccountSettings({ credentials });
  return readProfilesFromAccountSettings(snapshot.settings).customProfiles;
}

export function resolveProfileRoutedBackendTarget(params: Readonly<{
  profileQuery: string;
  customProfiles: ReadonlyArray<AIBackendProfile>;
}>): BackendTargetRefV1 | null {
  const resolved = resolveBackendProfile({ query: params.profileQuery, customProfiles: params.customProfiles });
  if (!resolved.ok) return null;
  const target = getProfileDefaultBackendTarget(resolved.profile);
  if (target) assertProfileCompatibleWithBackendTarget(resolved.profile, target);
  return target;
}

export async function resolveProfileRoutedBackendTargetFromSettings(params: Readonly<{
  profileQuery: string;
  credentials: Credentials;
}>): Promise<BackendTargetRefV1 | null> {
  return resolveProfileRoutedBackendTarget({
    profileQuery: params.profileQuery,
    customProfiles: await fetchCustomProfilesForProfileRouting(params.credentials),
  });
}

export async function prepareProfileSessionStart(params: Readonly<{
  profileQuery: string;
  startedBy?: 'terminal' | 'daemon';
  refreshRequested?: boolean;
}>): Promise<Readonly<{
  sessionStart: NonNullable<CommandContext['sessionStart']>;
  backendTarget: BackendTargetRefV1 | null;
}>> {
  // Selection requires custom account profiles, including on this invocation's first login.
  // The final handler owns daemon startup after dispatch applies the selected target policy.
  const { credentials } = await authAndSetupMachineIfNeeded({ deferDaemonAutostart: true });
  const accountSettingsContext = await loadProfileRoutingAccountSettings({ ...params, credentials });
  return {
    sessionStart: { credentials, accountSettingsContext },
    backendTarget: resolveProfileRoutedBackendTarget({
      profileQuery: params.profileQuery,
      customProfiles: readProfilesFromAccountSettings(accountSettingsContext.settings).customProfiles,
    }),
  };
}
