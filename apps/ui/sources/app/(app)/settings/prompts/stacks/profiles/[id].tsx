import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { PromptStacksScreen } from '@/components/settings/prompts/stacks/PromptStacksScreen';
import { PromptStackEditorScreen } from '@/components/settings/prompts/stacks/PromptStackEditorScreen';
import { useSetting } from '@/sync/domains/state/storage';
import { readUiAiLaunchProfilesForLegacyUi } from '@/sync/domains/profiles/aiLaunchProfileCollection';

function firstParam(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}
export default function PromptProfileStackEditorRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const profileId = firstParam(params.id);
  const rawProfiles = useSetting('profiles');
  const profiles = React.useMemo(
    () => readUiAiLaunchProfilesForLegacyUi(rawProfiles),
    [rawProfiles],
  );

  if (!profileId) return <PromptStacksScreen />;

  const profileName = profiles.find((p) => p.id === profileId)?.name ?? profileId;

  return <PromptStackEditorScreen surface="profile" profileId={profileId} title={profileName} />;
}
