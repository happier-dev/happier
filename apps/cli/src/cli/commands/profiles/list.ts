import { cyan, dim, emphasis, gray, kv, sectionTitle } from '@happier-dev/cli-common/output';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { readStoredCredentials } from '@/persistence';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { mapProfileToListItem, type ProfilesListItem } from '@/settings/profiles/profileListProjection';

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

  const credentials = await readStoredCredentials();
  if (!credentials) {
    const profiles = readProfilesFromAccountSettings({}).visibleProfiles.map(mapProfileToListItem);
    if (json) {
      await printJsonEnvelope({ ok: true, kind: 'profiles_list', data: { authenticated: false, profiles } });
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

  const profiles = readProfilesFromAccountSettings(snapshot.settings).visibleProfiles
    .map(mapProfileToListItem)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'profiles_list', data: { authenticated: true, profiles } });
    return;
  }

  printProfilesHuman(profiles, true);
}
