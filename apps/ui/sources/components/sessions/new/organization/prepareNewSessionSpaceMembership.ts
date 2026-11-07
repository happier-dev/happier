import type { SessionSpaceMembershipTargetV1 } from '@happier-dev/protocol/actions';
import type { SessionOrganizationPlacementV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { ensureSessionSpaceMembershipTag } from '@/sync/ops/sessionOrganization/sessionSpaceMembership';

/** Materializes the authored Space in the chosen Home before the Session is born. */
export async function prepareNewSessionSpaceMembership(params: Readonly<{
    spaceMembership?: SessionSpaceMembershipTargetV1 | null;
    organizationPlacement: SessionOrganizationPlacementV1;
    scope: ServerAccountScope;
    signal?: AbortSignal;
}>): Promise<SessionOrganizationPlacementV1> {
    if (!params.spaceMembership) return params.organizationPlacement;
    const result = await ensureSessionSpaceMembershipTag({
        ...params.spaceMembership,
        serverId: params.scope.serverId,
        expectedAccountId: params.scope.accountId,
        signal: params.signal,
    });
    if (!result.ok) throw new Error(result.error);
    return { ...params.organizationPlacement,
        tagIds: [...new Set([...params.organizationPlacement.tagIds, result.tagId])] };
}
