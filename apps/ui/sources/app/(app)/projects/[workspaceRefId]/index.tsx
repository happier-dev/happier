import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';

export default React.memo(() => {
    const params = useLocalSearchParams<{ workspaceRefId?: string | string[] }>();
    const raw = params.workspaceRefId;
    const workspaceRefId = typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
            ? (raw[0] ?? '')
            : '';

    return (
        <ProjectDetailScreen workspaceRefId={workspaceRefId} />
    );
});
