import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { SecretRequestSpecimen } from '@/components/dev/approvals/SecretRequestSpecimen';

/** Dev-only: an Action waiting for a declared secret input, over a stored request. `?variant=single|two`. */
export default function SecretRequestDevScreen() {
  const params = useLocalSearchParams<{ variant?: string }>();
  return <SecretRequestSpecimen variant={params.variant ?? 'single'} />;
}
