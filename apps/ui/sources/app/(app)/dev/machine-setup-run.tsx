import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { MachineSetupRunSpecimen, type MachineSetupRunSpecimenState } from '@/components/dev/machines/MachineSetupRunSpecimen';

const STATES: readonly MachineSetupRunSpecimenState[] = ['running', 'needs-you', 'stopped', 'done'];

/** Dev-only: the Machine Setup tab's run region (lab L7). `?state=running|needs-you|stopped|done`. */
export default function MachineSetupRunDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    const state = STATES.find(entry => entry === params.state) ?? 'running';
    return <MachineSetupRunSpecimen state={state} />;
}
