import { isSessionAccessRecipient } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { resolveSessionProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionListRenderableOwnerMetadataView } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { admitProjectWorkspaceCensusForSubject } from '@/sync/domains/workspaces/projectWorkspaceCensusAdmission';
import { readCurrentProjectAccountRows, readProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import type { StorageState } from '@/sync/store/types';
import type { AtmosphereProject, AtmosphereTarget } from './resolveAtmosphere';

/** Route context is an address; undefined is unknown membership/override, null is accepted Home inheritance. */
export function readAtmosphereProject(state: StorageState, surface: AtmosphereTarget): AtmosphereProject | null | undefined {
    if (typeof surface === 'string') return null;
    if ('project' in surface) return surface.project;
    if (!('session' in surface)) return null;
    const address = surface.session;
    const row = readSessionListRowForServerId(state.sessionListRowsByServerId, address.serverId, address.sessionId);
    if (!row) return undefined;
    // A recipient cannot consume the owner's private Project census; its presentation is the viewer's Home.
    if (isSessionAccessRecipient(row.access, row.accessLevel)) return null;
    const rows = readCurrentProjectAccountRows(state);
    const census = admitProjectWorkspaceCensusForSubject({
        subject: { kind: 'session', ownerAccountId: row.ownerAccountId, access: row.access, accessLevel: row.accessLevel },
        rowServerId: address.serverId, censusServerId: rows?.scope.serverId, viewerAccountId: rows?.scope.accountId,
        workspaceRefs: readProjectAccountWorkspaceRefs(state), sessionProjectKeyResolver: rows?.sessionProjectKeyResolver,
    });
    if (!census.admitted) return undefined;
    const metadata = readSessionListRenderableOwnerMetadataView(row);
    const result = census.workspaceRefs !== undefined && census.sessionProjectKeyResolver
        ? census.sessionProjectKeyResolver(metadata, address.serverId, row.projectKey)
        : resolveSessionProjectKeyV1(metadata, address.serverId, census.workspaceRefs,
            { ...workspaceRefResolutionContextV1(), projectKey: row.projectKey });
    if (result.kind === 'none') return null;
    if (result.kind !== 'resolved') return undefined;
    // A partial census can identify membership before it has read the organization override.
    // Only an admitted row or complete census can establish override versus Home inheritance.
    if (census.workspaceRefs !== undefined) return result.projectKey;
    return rows?.organizations.some(row => row.key.serverId === result.projectKey.serverId
        && row.key.projectKey === result.projectKey.projectKey) ? result.projectKey : undefined;
}
