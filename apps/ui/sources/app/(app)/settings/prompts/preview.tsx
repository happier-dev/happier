import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { PromptRuntimePreviewScreen } from '@/components/settings/prompts/preview/PromptRuntimePreviewScreen';

export default React.memo(function PromptRuntimePreviewRoute() {
  const params = useLocalSearchParams<{ sessionId?: string; serverId?: string }>();
  const sessionId = String(params.sessionId ?? '').trim();
  const serverId = String(params.serverId ?? '').trim();
  const initialSelection = sessionId && serverId ? { sessionId, serverId } : null;
  return <PromptRuntimePreviewScreen initialSelection={initialSelection} />;
});
