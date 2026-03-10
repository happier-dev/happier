import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { PromptStackPromptPickerScreen } from '@/components/settings/prompts/stacks/PromptStackPromptPickerScreen';

function firstParam(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}
export default function PromptStackPickerRoute() {
  const params = useLocalSearchParams<{ surface?: string | string[]; profileId?: string | string[] }>();
  const surface = firstParam(params.surface);
  const profileId = firstParam(params.profileId);

  if (surface === 'voice') {
    return <PromptStackPromptPickerScreen surface="voice" />;
  }

  if (surface === 'profile') {
    return <PromptStackPromptPickerScreen surface="profile" profileId={profileId} />;
  }

  return <PromptStackPromptPickerScreen surface="coding" />;
}
