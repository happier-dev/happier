import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { TeamSetupSpecimen } from '@/components/dev/teams/TeamSetupSpecimen';

/** Dev-only: plan D Team setup states through the real owners. `?frame=joined|tile|disclosure`. */
export default function TeamSetupDevScreen() {
  const params = useLocalSearchParams<{ frame?: string }>();
  return <TeamSetupSpecimen frame={typeof params.frame === 'string' ? params.frame : undefined} />;
}
