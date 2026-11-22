import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { WorkspaceSyncFailureSpecimen } from '@/components/dev/workspaces/WorkspaceSyncFailureSpecimen';

/** Dev-only: a refused Sync action's alert. `?cause=projectChanged|reviewedChanged` (default: projectChanged). */
export default function WorkspaceSyncFailureDevScreen() {
    const params = useLocalSearchParams<{ cause?: string }>();
    return <WorkspaceSyncFailureSpecimen cause={params.cause === 'reviewedChanged' ? 'reviewedChanged' : 'projectChanged'} />;
}
