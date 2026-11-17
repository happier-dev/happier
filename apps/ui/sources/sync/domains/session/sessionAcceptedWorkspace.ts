import type { SessionAcceptedWorkspaceV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Session } from '@/sync/domains/state/storageTypes';
import { admitProjectWorkspaceCensusForSubject } from '@/sync/domains/workspaces/projectWorkspaceCensusAdmission';
import { readCurrentProjectAccountRows, readProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { readSessionOwnerMetadataView } from './readSessionOwnerMetadataView';

/** Reuses the opened Account's admitted, indexed census; never inventories or guesses from paths. */
export function readSessionAcceptedWorkspaceRef(session: Pick<Session, 'ownerAccountId' | 'access' | 'accessLevel'
    | 'metadataLayoutVersion' | 'metadata' | 'ownerMetadataView'>, scope: ServerAccountScope | null,
    state: Parameters<typeof readCurrentProjectAccountRows>[0]): WorkspaceRefV1 | null {
    if (!scope) return null;
    const currentRows = readCurrentProjectAccountRows(state);
    const rows = areServerAccountScopesEqual(scope, currentRows?.scope) ? currentRows : null;
    const census = admitProjectWorkspaceCensusForSubject({
        subject: { kind: 'session', ownerAccountId: session.ownerAccountId, access: session.access, accessLevel: session.accessLevel },
        rowServerId: scope.serverId, censusServerId: rows?.scope.serverId, viewerAccountId: scope.accountId,
        workspaceRefs: rows ? readProjectAccountWorkspaceRefs(state) : undefined, sessionProjectKeyResolver: rows?.sessionProjectKeyResolver,
    });
    const metadata = readSessionOwnerMetadataView(session);
    const resolved = metadata && census.workspaceRefs ? census.sessionProjectKeyResolver?.(metadata, scope.serverId) : null;
    return resolved?.kind === 'resolved' ? resolved.ref ?? null : null;
}

export function readSessionAcceptedWorkspace(...input: Parameters<typeof readSessionAcceptedWorkspaceRef>): SessionAcceptedWorkspaceV1 | undefined {
    const ref = readSessionAcceptedWorkspaceRef(...input);
    return ref ? { checkout: workspaceAddressFromRefV1(ref),
        ...(ref.repositoryIdentity ? { repository: ref.repositoryIdentity } : {}) } : undefined;
}
