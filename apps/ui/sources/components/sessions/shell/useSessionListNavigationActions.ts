import * as React from 'react';
import { useNewSessionEntryRouter as useRouter } from '@/components/sessions/new/navigation/newSessionEntry';

import { buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { openSessionAuthoringSeed } from '@/sync/ops/actions/openSessionAuthoringSeed';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage, useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { useOpenProject } from '@/components/projects/useOpenProject';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import {
    useUniversalSearchRuntime,
    type UniversalSearchScopeSeed,
} from '@/components/appShell/search/UniversalSearchRuntimeContext';

import type { CreateSessionFromWorkspaceScopeOptions, NewSessionGroupTarget } from './resolveSessionListHeaderActionHandlers';

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

export function useSessionListNavigationActions(
    universalSearchScope?: UniversalSearchScopeSeed,
) {
    const router = useRouter();
    const openProject = useOpenProject();
    const universalSearch = useUniversalSearchRuntime();
    const rememberLastProjectSessionSelections = useSetting('rememberLastProjectSessionSelections') !== false;

    // Handlers read the latest closure but keep one identity, so memoized list chrome and rows that
    // receive them do not rebuild on every render of the list.
    const handleOpenProject = useEventCallback((workspaceRefId: string, serverId?: string) => {
        fireAndForget(openProject(workspaceRefId, { serverId }), { tag: 'SessionList.openProject' });
    });
    const handleCreateSessionFromWorkspaceScope = useEventCallback((
            target: NewSessionGroupTarget,
            options?: CreateSessionFromWorkspaceScopeOptions,
        ) => {
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) return;
            if (!('rootPath' in target)) {
                // A machine's Chats group starts another no-folder session on that machine.
                const seedSession = rememberLastProjectSessionSelections
                    ? resolveSeedSession(options?.seedSessionId)
                    : null;
                return openSessionAuthoringSeed({
                    seed: { placement: { kind: 'exactTarget', serverId: target.serverId, machineId: target.machineId }, directoryIntent: { kind: 'managed' } },
                    ...(seedSession ? { sourceSession: { serverId: target.serverId, sessionId: seedSession.id } } : {}),
                    scope: lifetime.scope, isCurrent: lifetime.isCurrent,
                    navigateToNewSession: ({ draftId }) => router.push({ pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }) }),
                });
            }
            const scopeHint: WorkspaceScopeHint = target;
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
                const configuration = buildNewSessionTempDataFromSessionConfiguration({
                    session: seedSession,
                    machineId: scopeHint.machineId,
                    directoryOverride: directory,
                });
                return openSessionAuthoringSeed({
                    seed: { placement: { kind: 'exactTarget', serverId: scopeHint.serverId, machineId: scopeHint.machineId,
                        ...(configuration.directory ? { directory: configuration.directory } : {}) } },
                    sourceSession: { serverId: scopeHint.serverId, sessionId: seedSession.id },
                    scope: lifetime.scope, isCurrent: lifetime.isCurrent,
                    navigateToNewSession: ({ draftId }) => router.push({ pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }) }),
                });
            }
            return openSessionAuthoringSeed({
                seed: { placement: { kind: 'exactTarget', serverId: scopeHint.serverId,
                    machineId: scopeHint.machineId, ...(directory ? { directory } : {}) } },
                scope: lifetime.scope,
                isCurrent: lifetime.isCurrent,
                navigateToNewSession: ({ draftId }) => router.push({
                    pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }),
                }),
            });
        });
    const handleOpenArchivedSessions = useEventCallback(() => {
        router.push('/session/archived');
    });
    /**
     * Escalates the contextual query through the canonical Search opener,
     * which chooses the modal or native route for the current platform.
     */
    const handleOpenUniversalSearch = useEventCallback((query: string) => {
        const normalizedQuery = normalizeString(query);
        if (universalSearchScope) {
            universalSearch.open(normalizedQuery ?? undefined, universalSearchScope);
            return;
        }
        universalSearch.open(normalizedQuery ?? undefined);
    });

    return React.useMemo(() => ({
        handleOpenProject,
        handleCreateSessionFromWorkspaceScope,
        handleOpenArchivedSessions,
        handleOpenUniversalSearch,
    }), [handleCreateSessionFromWorkspaceScope, handleOpenArchivedSessions, handleOpenProject, handleOpenUniversalSearch]);
}
