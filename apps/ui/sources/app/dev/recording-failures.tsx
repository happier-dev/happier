import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { RECORDING_FAILURE_SPECIMEN_STATES } from '@/components/dev/recording/recordingFailureSpecimenStates';

const RecordingFailuresSpecimen = retryableLazy(() => import('@/components/dev/recording/RecordingFailuresSpecimen'));

/** Static dev-only QA entry: what the person reads for each recording result. `?state=<id>` opens that one. */
export default function RecordingFailuresDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    if (!isDevRouteEnabled()) return null;
    const state = RECORDING_FAILURE_SPECIMEN_STATES.find(candidate => candidate === params.state) ?? null;
    return <React.Suspense fallback={null}><RecordingFailuresSpecimen state={state} /></React.Suspense>;
}
