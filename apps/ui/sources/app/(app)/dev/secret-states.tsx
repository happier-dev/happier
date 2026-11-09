import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { SecretStatesSpecimen } from '@/components/dev/secrets/SecretStatesSpecimen';

/** Dev-only: Secret trouble rows and a profile's required secret, through the real owners. `?frame=rows|requirement`. */
export default function SecretStatesDevScreen() {
  const params = useLocalSearchParams<{ frame?: string }>();
  return (
    <SecretStatesSpecimen
      frame={typeof params.frame === 'string' ? params.frame : undefined}
    />
  );
}
