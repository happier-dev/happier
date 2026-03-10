import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { PromptDocEditorScreen } from '@/components/settings/prompts/docs/PromptDocEditorScreen';

export default function EditPromptDocPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!id) return null;
  return <PromptDocEditorScreen artifactId={id} />;
}
