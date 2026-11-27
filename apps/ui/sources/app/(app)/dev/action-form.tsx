import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { PortableActionFormSpecimen } from '@/components/dev/actions/PortableActionFormSpecimen';

/** Dev-only: the shared Action form for a released portable Account Action. `?variant=note|failed`. */
export default function ActionFormDevScreen() {
  const params = useLocalSearchParams<{ variant?: string }>();
  return <PortableActionFormSpecimen variant={params.variant ?? 'note'} />;
}
