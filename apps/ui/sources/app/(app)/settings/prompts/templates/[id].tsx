import { useLocalSearchParams } from 'expo-router';

import { PromptTemplateEditorScreen } from '@/components/settings/prompts/templates/PromptTemplateEditorScreen';

export default function EditPromptTemplateRoute() {
  const params = useLocalSearchParams();
  const id = typeof params?.id === 'string' ? params.id : null;
  return <PromptTemplateEditorScreen invocationId={id} />;
}
