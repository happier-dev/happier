import { useRouter } from 'expo-router';

export function useSessionListNavigationActions() {
    const router = useRouter();

    return {
        handleOpenProject(workspaceRefId: string) {
            router.push(`/projects/${encodeURIComponent(workspaceRefId)}`);
        },
        handleCreateSessionFromWorkspaceScope(scopeHint: Readonly<{
            serverId: string;
            machineId: string;
            rootPath: string;
        }>) {
            router.push({
                pathname: '/new',
                params: {
                    machineId: scopeHint.machineId,
                    directory: scopeHint.rootPath,
                    ...(scopeHint.serverId ? { spawnServerId: scopeHint.serverId } : {}),
                },
            } as any);
        },
        handleOpenArchivedSessions() {
            router.push('/session/archived');
        },
    };
}
