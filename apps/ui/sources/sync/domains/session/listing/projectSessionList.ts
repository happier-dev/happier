import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { matchSessionProjectScopeV1, resolveSessionProjectScopeV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createSessionProjectKeyResolverV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { isSessionListShortcutOccurrence, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { admitProjectWorkspaceCensusForSubject } from '@/sync/domains/workspaces/projectWorkspaceCensusAdmission';
import { readSessionListRenderableOwnerMetadataView } from './sessionListRenderableSessionProjection';
import { isUserFacingSession } from './isUserFacingSession';
import type { SessionListRenderableSession } from './sessionListRenderable';

export type ProjectSessionListItem = Extract<SessionListIndexItem, { type: 'session' }>;

/** Shared Project admission for the row subscription and the final ordinary-list projection. */
export function createProjectSessionListMatcher(input: Readonly<{
    project: QualifiedProjectKeyV1;
    viewer: ServerAccountScope | null;
    workspaceRefs?: readonly WorkspaceRefV1[];
}>): (row: SessionListRenderableSession | undefined, serverId: string) => ReturnType<typeof matchSessionProjectScopeV1> {
    const viewer = selectActiveServerAccountScopeForServer(input.viewer, input.project.serverId);
    const workspaceContext = { ...workspaceRefResolutionContextV1(),
        sessionProjectKeyResolver: createSessionProjectKeyResolverV1(input.workspaceRefs, workspaceRefResolutionContextV1()) };
    const scope = resolveSessionProjectScopeV1(input.project, input.workspaceRefs, workspaceContext.normalizeServerId);
    // Rows are immutable. This matcher belongs to one Project/viewer/census/profile generation;
    // unrelated arrivals reuse its classification without reopening unchanged owner metadata.
    const matches = new WeakMap<SessionListRenderableSession, ReturnType<typeof matchSessionProjectScopeV1>>();
    return (row, serverId) => {
        if (!viewer || !areServerProfileIdentifiersEquivalent(serverId, input.project.serverId)
            || !row) return 'miss';
        const previous = matches.get(row);
        if (previous !== undefined) return previous;
        if (!isUserFacingSession(row)) {
            matches.set(row, 'miss');
            return 'miss';
        }
        const census = admitProjectWorkspaceCensusForSubject({
            subject: { kind: 'session', ownerAccountId: row.ownerAccountId, access: row.access, accessLevel: row.accessLevel },
            rowServerId: serverId, censusServerId: viewer.serverId, viewerAccountId: viewer.accountId,
            workspaceRefs: input.workspaceRefs, sessionProjectKeyResolver: workspaceContext.sessionProjectKeyResolver,
        });
        const match = matchSessionProjectScopeV1(row.metadataUnavailable ? null : readSessionListRenderableOwnerMetadataView(row),
            serverId, scope, census.workspaceRefs, { ...workspaceContext, projectKey: row.projectKey,
                sessionProjectKeyResolver: census.sessionProjectKeyResolver });
        matches.set(row, match);
        return match;
    };
}

/** A projection of admitted membership, never an inventory over the row cache. */
export function projectSessionList(input: Readonly<{
    project: QualifiedProjectKeyV1;
    viewer: ServerAccountScope | null;
    source: readonly SessionListIndexItem[] | null;
    rows: Readonly<Record<string, SessionListRenderableSession>>;
    workspaceRefs?: readonly WorkspaceRefV1[];
}>): Readonly<{ items: readonly ProjectSessionListItem[]; unavailableCount: number }> {
    let unavailableCount = 0;
    const matchRow = createProjectSessionListMatcher(input);
    const items = (input.source ?? []).filter((item): item is ProjectSessionListItem => {
        if (item.type !== 'session' || !item.serverId) return false;
        // The roster lists a Session once: skip the index's needs-you / working shortcut copies.
        if (isSessionListShortcutOccurrence(item)) return false;
        const match = matchRow(input.rows[item.sessionId], item.serverId);
        if (match === 'unavailable') unavailableCount += 1;
        return match === 'match';
    });
    return { items, unavailableCount };
}
