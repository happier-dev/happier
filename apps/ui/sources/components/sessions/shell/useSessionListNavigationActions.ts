import * as React from 'react';
import { useRouter } from 'expo-router';

export function useSessionListNavigationActions() {
    const router = useRouter();

    const handleOpenProject = React.useCallback((workspaceRefId: string) => {
        router.push(`/projects/${encodeURIComponent(workspaceRefId)}`);
    }, [router]);

    const handleOpenArchivedSessions = React.useCallback(() => {
        router.push('/session/archived');
    }, [router]);

    return {
        handleOpenProject,
        handleOpenArchivedSessions,
    };
}
