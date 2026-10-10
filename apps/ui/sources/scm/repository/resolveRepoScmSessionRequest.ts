import { storage } from '@/sync/domains/state/storage';
import { readSessionWorkspaceContext } from '@/sync/domains/session/readSessionWorkspaceContext';
import { resolveProjectMachineScopeId } from '@/sync/runtime/orchestration/projectManager';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
    resolveMachineTargetForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { findMachineInCollection } from '@/sync/domains/machines/identity/machineCollection';
import { resolveRepoScmMachinePathRequest } from './resolveRepoScmMachinePathRequest';

export type RepoScmSessionRequest = Readonly<{
    sessionId: string;
    machineId: string | null;
    resolvedPath: string;
    repoIdentityKey: string;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Home-qualified resolution. Two Homes can host the same Session id, so a caller that names its
 * Home gets that Home's Session: the machine and workspace path come from the canonical exact-Home
 * target owner (which reads the Home-scoped list row and machine inventory and refuses the
 * session-id-keyed project map), and the repository identity is spelled by the shared machine/path
 * owner so both SCM entry points produce one key. The active Home is never consulted.
 */
function resolveExactHomeRepoScmSessionRequest(
    state: SessionMachineTargetState,
    serverId: string,
    sessionId: string,
): RepoScmSessionRequest | null {
    const target = resolveMachineTargetForSessionFromState(state, { serverId, sessionId });
    if (!target) {
        return null;
    }

    const row = readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, sessionId);
    const directSession = state.sessions?.[sessionId];
    const exactMetadata = row?.metadata
        ?? (directSession && areServerProfileIdentifiersEquivalent(directSession.serverId, serverId)
            ? readSessionOwnerMetadataView({
                metadataLayoutVersion: directSession.metadataLayoutVersion,
                metadata: directSession.metadata ?? null,
                ownerMetadataView: directSession.ownerMetadataView,
            })
            : null);
    const scopedMachines = resolveServerScopedMachines({
        serverId,
        activeServerId: getActiveServerSnapshot().serverId,
        activeMachines: Object.values(state.machines ?? {}),
        machineListByServerId: state.machineListByServerId ?? {},
        machineListStatusByServerId: state.machineListStatusByServerId,
    }) ?? [];
    const homeDir = normalizeNonEmptyString(exactMetadata?.homeDir)
        ?? normalizeNonEmptyString(
            findMachineInCollection(scopedMachines, target.machineId)?.metadata?.homeDir,
        );

    const request = resolveRepoScmMachinePathRequest({
        serverId,
        machineId: target.machineId,
        path: target.basePath,
        homeDir,
    });
    if (!request) {
        return null;
    }

    return {
        sessionId,
        machineId: request.machineId,
        resolvedPath: request.resolvedPath,
        repoIdentityKey: request.repoIdentityKey,
    };
}

export function resolveRepoScmSessionRequest(input: Readonly<{
    sessionId: string;
    serverId?: string | null;
}>): RepoScmSessionRequest | null {
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
        return null;
    }

    const state = storage.getState();
    const hasSelectedHome = Object.prototype.hasOwnProperty.call(input, 'serverId')
        && input.serverId !== undefined;
    if (hasSelectedHome) {
        const serverId = normalizeNonEmptyString(input.serverId);
        return serverId
            ? resolveExactHomeRepoScmSessionRequest(state as SessionMachineTargetState, serverId, sessionId)
            : null;
    }

    const session = state.sessions?.[sessionId];
    if (!session) {
        return null;
    }

    const workspaceContext = readSessionWorkspaceContext(state, sessionId);
    const ownerMetadata = readSessionOwnerMetadataView(session);
    const repoPath = workspaceContext.projectPath ?? workspaceContext.workspacePath;
    const normalizedRepoPath = normalizeNonEmptyString(repoPath);
    if (!normalizedRepoPath) {
        return null;
    }

    const reachableMachineId = readMachineTargetForSession(sessionId)?.machineId ?? null;
    const sessionMachineId = resolveSessionMachineId(ownerMetadata);
    const projectMachineId = normalizeNonEmptyString(workspaceContext.projectMachineId);
    const machineId =
        reachableMachineId
        ?? sessionMachineId
        ?? projectMachineId
        ?? resolveProjectMachineScopeId(ownerMetadata ?? {});

    const machineHomeDir =
        machineId && machineId !== 'unknown'
            ? state.machines?.[machineId]?.metadata?.homeDir
            : undefined;
    const resolvedPath = resolveAbsolutePath(
        normalizedRepoPath,
        ownerMetadata?.homeDir ?? machineHomeDir
    );

    return {
        sessionId,
        machineId: machineId && machineId !== 'unknown' ? machineId : null,
        resolvedPath,
        repoIdentityKey: `${machineId}:${resolvedPath}`,
    };
}
