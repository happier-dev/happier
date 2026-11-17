import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ARTIFACTS_SPECIMEN_STATES, ArtifactsSpecimen } from '@/components/dev/artifacts/ArtifactsSpecimen';

/** Dev-only: the Artifacts browser with the lab's fixtures. `?state=` one of the specimen's states. */
export default function ArtifactsDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    const state = ARTIFACTS_SPECIMEN_STATES.find((candidate) => candidate === params.state) ?? 'grid';
    return <ArtifactsSpecimen key={state} state={state} />;
}
