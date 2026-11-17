import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { CoordinationStatesSpecimen } from '@/components/dev/coordination/CoordinationStatesSpecimen';

/**
 * Dev-only: coordination states drawn by their real owners (lab coordination-v3). `?scene=followers` is People's
 * populated Followers sheet; `?scene=ask` (default) is a composer Ask's grouped target lines.
 */
export default function CoordinationStatesDevScreen() {
  const params = useLocalSearchParams<{ scene?: string }>();
  return (
    <CoordinationStatesSpecimen
      scene={params.scene === 'followers' ? 'followers' : 'ask'}
    />
  );
}
