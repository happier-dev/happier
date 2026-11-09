import { getProfileDefaultBackendTarget } from '@happier-dev/protocol/profiles/profileCompatibility';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveSessionStartAccountSettingsContext } from '@/settings/accountSettings/resolveSessionStartAccountSettingsContext';
import { resolveSessionStartAccountSettingsRefreshMode } from '@/settings/accountSettings/resolveSessionStartAccountSettingsRefreshMode';
import { assertProfileCompatibleWithBackendTarget, resolveAccountProfileForSessionStart } from '@/settings/profiles/resolveProfileForAgent';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import type { CommandContext } from './commandRegistry';

/** Selects the Profile before choosing an implicit Agent, including this invocation's first login. */
export async function prepareProfileSessionStart(params: Readonly<{
  profileQuery: string;
  startedBy?: 'terminal' | 'daemon';
  refreshRequested: boolean;
}>): Promise<Readonly<{
  sessionStart: NonNullable<CommandContext['sessionStart']>;
  backendTarget: ReturnType<typeof getProfileDefaultBackendTarget>;
}>> {
  const { credentials, machineId } = await authAndSetupMachineIfNeeded({ deferDaemonAutostart: true });
  const startedBy = params.startedBy ?? 'terminal';
  const snapshot = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking',
    refresh: resolveSessionStartAccountSettingsRefreshMode({ mode: 'blocking', refreshRequested: params.refreshRequested }) });
  const initialAccountSettingsContext = await resolveSessionStartAccountSettingsContext({ startedBy, snapshot,
    refreshRequested: params.refreshRequested });
  const { profile: selectedProfile, accountSettingsContext } = await resolveAccountProfileForSessionStart({ query: params.profileQuery,
    credentials, accountSettingsContext: initialAccountSettingsContext });
  const backendTarget = getProfileDefaultBackendTarget(selectedProfile);
  if (backendTarget) assertProfileCompatibleWithBackendTarget(selectedProfile, backendTarget);
  return { sessionStart: { credentials, machineId, accountSettingsContext, selectedProfile }, backendTarget };
}
