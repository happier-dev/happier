import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { PromptStacksScreen } from '@/components/settings/prompts/stacks/PromptStacksScreen';
import { PromptStackEditorScreen } from '@/components/settings/prompts/stacks/PromptStackEditorScreen';
import { useSetting } from '@/sync/domains/state/storage';

function firstParam(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}
export default function PromptProfileStackEditorRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const profileId = firstParam(params.id);
  const profiles = useSetting('profiles');

  if (!profileId) return <PromptStacksScreen />;

  const profileName = profiles.find((p) => p.id === profileId)?.name ?? profileId;

  return <PromptStackEditorScreen surface="profile" profileId={profileId} title={profileName} />;
}
