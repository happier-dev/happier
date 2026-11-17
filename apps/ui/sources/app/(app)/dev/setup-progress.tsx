import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { SetupProgressSpecimen, type SetupProgressSpecimenState } from '@/components/dev/machines/SetupProgressSpecimen';

const STATES: readonly SetupProgressSpecimenState[] = ['running', 'waiting', 'failed'];

/** Dev-only: the progress surfaces on the shared checklist (E1). `?state=running|waiting|failed`. */
export default function SetupProgressDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    return <SetupProgressSpecimen state={STATES.find(entry => entry === params.state) ?? 'running'} />;
}
