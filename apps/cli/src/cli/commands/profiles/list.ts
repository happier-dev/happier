import { AGENT_IDS } from '@happier-dev/agents';
import {
  DEFAULT_BUILT_IN_BACKEND_PROFILES,
  getRequiredConfigEnvVarNames,
  getRequiredSecretEnvVarNames,
  isProfileCompatibleWithAgent,
  type AIBackendProfile,
} from '@happier-dev/protocol';
import { cyan, dim, emphasis, gray, kv, sectionTitle } from '@happier-dev/cli-common/output';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { readCredentials } from '@/persistence';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';

type ProfilesListItem = Readonly<{
  id: string;
  name: string;
  isBuiltIn: boolean;
  description?: string;
  supportedAgentIds: string[];
  requiredSecretEnvVarNames: string[];
  requiredConfigEnvVarNames: string[];
  authMode?: AIBackendProfile['authMode'];
  requiresMachineLoginTargetKey?: string;
  requiresMachineLogin?: string;
}>;

function mapProfileToListItem(profile: AIBackendProfile): ProfilesListItem {
  return {
    id: profile.id,
    name: profile.name,
    isBuiltIn: profile.isBuiltIn === true,
    ...(profile.description ? { description: profile.description } : {}),
    supportedAgentIds: AGENT_IDS.filter((agentId) => isProfileCompatibleWithAgent(profile, agentId)),
    requiredSecretEnvVarNames: getRequiredSecretEnvVarNames(profile),
    requiredConfigEnvVarNames: getRequiredConfigEnvVarNames(profile),
    ...(profile.authMode ? { authMode: profile.authMode } : {}),
    ...(profile.requiresMachineLoginTargetKey ? { requiresMachineLoginTargetKey: profile.requiresMachineLoginTargetKey } : {}),
    ...(profile.requiresMachineLogin ? { requiresMachineLogin: profile.requiresMachineLogin } : {}),
  };
}

function printProfilesHuman(profiles: ReadonlyArray<ProfilesListItem>, authenticated: boolean): void {
  console.log(sectionTitle(`Backend profiles (${profiles.length})`));
  for (const profile of profiles) {
    const suffix = profile.isBuiltIn ? gray('built-in') : cyan('custom');
    console.log(`- ${emphasis(profile.id)} (${profile.name}) ${gray(`[${suffix}]`)}`);
    if (profile.description) console.log(`  ${dim(profile.description)}`);
    if (profile.supportedAgentIds.length > 0) {
      console.log(`  ${kv('Agents:', profile.supportedAgentIds.join(', '))}`);
    }
    if (profile.requiredSecretEnvVarNames.length > 0) {
      console.log(`  ${kv('Required secrets:', profile.requiredSecretEnvVarNames.join(', '))}`);
    }
    if (profile.requiredConfigEnvVarNames.length > 0) {
      console.log(`  ${kv('Required config:', profile.requiredConfigEnvVarNames.join(', '))}`);
    }
    if (profile.requiresMachineLoginTargetKey) {
      console.log(`  ${kv('Requires machine login target:', profile.requiresMachineLoginTargetKey)}`);
    }
    if (profile.requiresMachineLogin) {
      console.log(`  ${kv('Requires machine login:', profile.requiresMachineLogin)}`);
    }
  }

  if (!authenticated) {
    console.log(dim('Log in to see custom profiles.'));
  }
}

export async function runProfilesListCommand(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const refreshSettings = args.includes('--refresh-settings');

  const credentials = await readCredentials();
  if (!credentials) {
    const profiles = DEFAULT_BUILT_IN_BACKEND_PROFILES.map(mapProfileToListItem);
    if (json) {
      printJsonEnvelope({ ok: true, kind: 'profiles_list', data: { authenticated: false, profiles } });
      return;
    }
    printProfilesHuman(profiles, false);
    return;
  }

  const snapshot = await bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: refreshSettings ? 'force' : 'auto',
  });

  const { customProfiles } = readProfilesFromAccountSettings(snapshot.settings as any);
  const profiles = [...DEFAULT_BUILT_IN_BACKEND_PROFILES, ...customProfiles]
    .map(mapProfileToListItem)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'profiles_list', data: { authenticated: true, profiles } });
    return;
  }

  printProfilesHuman(profiles, true);
}
