import { useRouter } from 'expo-router';

export function useSessionListNavigationActions() {
    const router = useRouter();

    return {
        handleOpenProject(workspaceRefId: string) {
            router.push(`/projects/${encodeURIComponent(workspaceRefId)}`);
        },
        handleOpenArchivedSessions() {
            router.push('/session/archived');
        },
    };
}
