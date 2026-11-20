import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { PresetKeyPendingSpecimen } from '@/components/dev/machines/PresetKeyPendingSpecimen';

/** Dev-only: a shared preset waiting for its key, in the presets table and the New Session picker. `?surface=picker`. */
export default function PresetKeyPendingDevScreen() {
  const params = useLocalSearchParams<{ surface?: string }>();
  return (
    <PresetKeyPendingSpecimen
      surface={params.surface === 'picker' ? 'picker' : 'table'}
    />
  );
}
