import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { DeployAutoSpecimen } from '@/components/dev/deployments/DeployAutoSpecimen';
import { useDeviceType } from '@/utils/platform/responsive';

/** Dev-only: Deploy an app's auto mode over fixtures. `?state=session|cards|failed|making|opening`. */
export default function DeployAutoDevScreen() {
  const params = useLocalSearchParams<{ state?: string }>();
  return (
    <DeployAutoSpecimen
      state={params.state ?? 'session'}
      phone={useDeviceType() === 'phone'}
    />
  );
}
