import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { FreshCopyStatesSpecimen, type FreshCopySpecimenState } from '@/components/dev/projects/FreshCopyStatesSpecimen';

const STATES: readonly FreshCopySpecimenState[] = ['confirm', 'retired', 'refused', 'inUse'];

/** Dev-only: Fresh copy removal states. `?state=confirm|retired|refused|inUse` (default confirm). */
export default function FreshCopyStatesDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    const state = STATES.find((candidate) => candidate === params.state) ?? 'confirm';
    return <FreshCopyStatesSpecimen state={state} />;
}
