import { useRouter } from 'expo-router';

import { buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import { storage, useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storeTempData } from '@/utils/sessions/tempDataStore';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';

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
            const seedSessionId = normalizeString(options?.seedSessionId);
            const seedSession = rememberLastProjectSessionSelections
                ? resolveSeedSession(seedSessionId)
                : null;
            const seedMachineTarget = seedSessionId
                ? readMachineControlTargetForSession(seedSessionId)
                : null;
            const directory = seedMachineTarget?.machineId === scopeHint.machineId
                ? seedMachineTarget.basePath
                : scopeHint.rootPath;
            if (seedSession) {
                const dataId = storeTempData(buildNewSessionTempDataFromSessionConfiguration({
                    session: seedSession,
                    machineId: scopeHint.machineId,
                    directoryOverride: directory,
                }));
                router.push({
                    pathname: '/new',
                    params: {
                        dataId,
                        machineId: scopeHint.machineId,
                        directory,
                        ...(scopeHint.serverId ? { spawnServerId: scopeHint.serverId } : {}),
                    },
                } as any);
                return;
            }
            router.push({
                pathname: '/new',
                params: {
                    machineId: scopeHint.machineId,
                    directory,
                    ...(scopeHint.serverId ? { spawnServerId: scopeHint.serverId } : {}),
                },
            } as any);
        },
        handleOpenArchivedSessions() {
            router.push('/session/archived');
        },
    };
}
