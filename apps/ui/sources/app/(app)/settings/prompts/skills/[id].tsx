import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { SkillBundleEditorScreen } from '@/components/settings/prompts/skills/SkillBundleEditorScreen';

export default function EditSkillBundlePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!id) return null;
  return <SkillBundleEditorScreen artifactId={id} />;
}
