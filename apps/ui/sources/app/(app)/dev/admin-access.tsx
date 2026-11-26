import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import {
  MachineAdminAccessSpecimen,
  type MachineAdminAccessSpecimenState,
} from '@/components/dev/machines/MachineAdminAccessSpecimen';

const STATES: readonly MachineAdminAccessSpecimenState[] = [
  'denied',
  'reading',
  'failed',
  'allowed',
  'none',
  'before',
];

/** Dev-only: Security → Administrator access with Preauthorized and the Machine's sudo. `?state=denied|reading|failed|allowed|none|before`. */
export default function AdminAccessDevScreen() {
  const params = useLocalSearchParams<{ state?: string }>();
  const state =
    STATES.find((candidate) => candidate === params.state) ?? 'denied';
  return <MachineAdminAccessSpecimen state={state} />;
}
