import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { HandoffStatesSpecimen, type HandoffSpecimenFrame } from '@/components/dev/sessions/HandoffStatesSpecimen';

const FRAMES: readonly HandoffSpecimenFrame[] = ['sheet', 'refused', 'creating', 'failed'];

/** Dev-only: the handoff sheet and progress over a real Session. `?session=<id>&frame=sheet|refused|creating|failed`. */
export default function HandoffStatesDevScreen() {
    const params = useLocalSearchParams<{ session?: string; frame?: string }>();
    const frame = FRAMES.find(candidate => candidate === params.frame) ?? 'sheet';
    return <HandoffStatesSpecimen sessionId={typeof params.session === 'string' ? params.session : null} frame={frame} />;
}
