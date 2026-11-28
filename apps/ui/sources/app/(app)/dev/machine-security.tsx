import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import {
  MACHINE_SECURITY_GRADE_SPECIMEN_STATES,
  MachineSecurityGradeSpecimen,
} from '@/components/dev/machines/MachineSecurityGradeSpecimen';

/** Dev-only: Machine → Security grade summary. `?state=toFix|incomplete|clear|noEvidence|offline|reading|failed|guest`. */
export default function MachineSecurityDevScreen() {
  const params = useLocalSearchParams<{ state?: string }>();
  const state = MACHINE_SECURITY_GRADE_SPECIMEN_STATES.find((candidate) => candidate === params.state) ?? 'toFix';
  return <MachineSecurityGradeSpecimen state={state} />;
}
