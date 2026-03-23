import * as React from 'react';
import { useRouter } from 'expo-router';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export function useRequireGlobalInboxEnabled(): boolean {
  const router = useRouter();
  const enabled = useFeatureEnabled('inbox.global') || useFeatureEnabled('actions.approvals');

  React.useEffect(() => {
    if (enabled) return;
    router.replace('/');
  }, [enabled, router]);

  return enabled;
}

