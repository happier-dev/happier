import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { MachineShareSpecimen } from '@/components/dev/machines/MachineShareSpecimen';

/** Dev-only: a Machine's share sheet as its owner sees it, for each way its agents run. */
export default function MachineShareDevScreen() {
  const params = useLocalSearchParams<{ state?: string }>();
  return (
    <MachineShareSpecimen
      state={typeof params.state === 'string' ? params.state : undefined}
    />
  );
}
