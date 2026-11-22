import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { WorkspaceSyncFailureSpecimen } from '@/components/dev/workspaces/WorkspaceSyncFailureSpecimen';

/** Dev-only: a refused Sync action. `?cause=projectChanged|reviewedChanged`, `?surface=inline|alert` (defaults: projectChanged, inline). */
export default function WorkspaceSyncFailureDevScreen() {
    const params = useLocalSearchParams<{ cause?: string; surface?: string }>();
    return <WorkspaceSyncFailureSpecimen cause={params.cause === 'reviewedChanged' ? 'reviewedChanged' : 'projectChanged'}
        surface={params.surface === 'alert' ? 'alert' : 'inline'} />;
}
