import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';

import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { readSessionListRowForServerId, type SessionListRowStateByServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { SessionListRenderableMetadata } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import { normalizeWorkspaceScopeBase, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSessionFromState, type WorkspaceTargetForSessionState } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';

type SessionProjectState = Readonly<{
    sessions: Readonly<Record<string, Session>>;
    sessionListRowsByServerId: SessionListRowStateByServerId;
}>;

/** The store and mounted SCM subscribers resolve exactly the same workspace owner. */
export function resolveSessionScmScopeFromState(
    state: WorkspaceTargetForSessionState & SessionProjectState,
    sessionId: string,
    serverId?: string | null,
): WorkspaceScopeBase | null {
    return resolveManagedSessionScmScope(state, sessionId, serverId)
        ?? (serverId != null ? resolveWorkspaceTargetForSessionFromState(state, { sessionId, serverId }) : null);
}

/** A shared-only list projection cannot hide a matching hydrated owner view. */
export function readSessionProjectMetadata(
    state: SessionProjectState,
    sessionId: string,
    serverIdRaw?: string | null,
): Session['metadata'] | SessionListRenderableMetadata {
    const session = state.sessions[sessionId];
    if (serverIdRaw == null) return session ? readSessionOwnerMetadataView(session) : null;
    const serverId = serverIdRaw.trim();
    const rowMetadata = readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, sessionId)?.metadata;
    if (rowMetadata?.path?.trim()) return rowMetadata;
    const ownerMetadata = session && areServerProfileIdentifiersEquivalent(session.serverId, serverId)
        ? readSessionOwnerMetadataView(session) : null;
    return ownerMetadata ?? rowMetadata ?? null;
}

/** SCM cache identity survives disconnection; it is not permission to issue a Machine RPC. */
export function resolveManagedSessionScmScope(
    state: SessionProjectState,
    sessionId: string,
    serverIdRaw?: string | null,
): WorkspaceScopeBase | null {
    const metadata = readSessionProjectMetadata(state, sessionId, serverIdRaw);
    if (readSessionDirectoryKind(metadata) !== 'managed' || !metadata?.path) return null;
    const machineId = resolveSessionMachineId(metadata);
    if (!machineId) return null;
    const serverId = serverIdRaw?.trim() || state.sessions[sessionId]?.serverId?.trim()
        || String(getActiveServerSnapshot().serverId ?? '').trim();
    const workspace = resolveSessionWorkspaceRootForMachine({ metadata, machineId, candidatePath: metadata.path });
    return normalizeWorkspaceScopeBase({
        serverId,
        machineId,
        rootPath: workspace.machinePath ?? metadata.path,
    });
}
