import { useRouter } from 'expo-router';

import { buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import { storage, useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storeTempData } from '@/utils/sessions/tempDataStore';

import type { CreateSessionFromWorkspaceScopeOptions } from './resolveSessionListHeaderActionHandlers';

type WorkspaceScopeHint = Readonly<{
    serverId: string;
    machineId: string;
    rootPath: string;
}>;

function normalizeString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null;
}

function resolveSeedSession(sessionId: unknown): Session | null {
    const normalizedSessionId = normalizeString(sessionId);
    if (!normalizedSessionId) {
        return null;
    }
    const session = (storage.getState().sessions as Record<string, Session | undefined>)[normalizedSessionId];
    return session ?? null;
}

export function useSessionListNavigationActions() {
    const router = useRouter();
    const rememberLastProjectSessionSelections = useSetting('rememberLastProjectSessionSelections') !== false;

    return {
        handleOpenProject(workspaceRefId: string) {
            router.push(`/projects/${encodeURIComponent(workspaceRefId)}`);
        },
        handleCreateSessionFromWorkspaceScope(
            scopeHint: WorkspaceScopeHint,
            options?: CreateSessionFromWorkspaceScopeOptions,
        ) {
            const seedSession = rememberLastProjectSessionSelections
                ? resolveSeedSession(options?.seedSessionId)
                : null;
            if (seedSession) {
                const dataId = storeTempData(buildNewSessionTempDataFromSessionConfiguration({
                    session: seedSession,
                    machineId: scopeHint.machineId,
                    directoryOverride: scopeHint.rootPath,
                }));
                router.push({
                    pathname: '/new',
                    params: {
                        dataId,
                        machineId: scopeHint.machineId,
                        directory: scopeHint.rootPath,
                        ...(scopeHint.serverId ? { spawnServerId: scopeHint.serverId } : {}),
                    },
                } as any);
                return;
            }
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
