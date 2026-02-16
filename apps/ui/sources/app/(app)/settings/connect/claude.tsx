import * as React from 'react';
import { useRouter } from 'expo-router';

export default function ClaudeConnectRedirect() {
  const router = useRouter();

  React.useEffect(() => {
    router.replace('/(app)/settings/connected-services/anthropic');
  }, [router]);

  return null;
}

