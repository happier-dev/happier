import type { TeamCredentialUsageQueryInputV1 } from '@happier-dev/protocol/teams';
import type { Tx } from '@/storage/inTx';
import { AccountStatus } from '@/storage/enums.generated';
import { readHomeGovernanceAccountInTx, resolveHomeGovernanceAuthority } from '@/app/home/governance/homeCapabilities';
import { readsWholeTeamCredentialUsage } from '@/app/usage/teamCredentialUsageInvalidation';
import { resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from '../actorContext';
import { resolveTeamCredentialCapabilities } from '../capabilities';
import { qualifyTeamCredentialOperationInTx } from './resourceRead';
import { resolveTeamCredentialEntitlementInTx } from './resourceAccess';
import { readTeamCredentialAllowedRoutes } from './resourceDeliveryRead';
import { hasTeamCredentialDirectDeliveryActivityInTx, hasTeamCredentialResourceDirectDeliveryActivityInTx } from './resourceActivity';

const usageResourceSelect = {
    id: true, teamId: true, custodianAccountId: true, allMembersDeliveryMode: true,
    groupGrants: { select: { deliveryMode: true } },
    memberGrants: { select: { deliveryMode: true } },
} as const;

function hasDirectRoute(resource: Readonly<{
    allMembersDeliveryMode: string | null;
    groupGrants: readonly Readonly<{ deliveryMode: string }>[];
    memberGrants: readonly Readonly<{ deliveryMode: string }>[];
}>) {
    return [resource.allMembersDeliveryMode, ...resource.groupGrants.map(grant => grant.deliveryMode),
        ...resource.memberGrants.map(grant => grant.deliveryMode)].some(mode => {
        if (mode === null) return false;
        const routes = readTeamCredentialAllowedRoutes(mode);
        return routes.success && routes.data.some(route => route !== 'brokered');
    });
}

async function authorizeResourceUsageInTx(tx: Tx, accountId: string, resourceId: string,
    authentication: TeamOperationAuthenticationContext) {
    const resource = await tx.teamCredentialResource.findUnique({ where: { id: resourceId }, select: usageResourceSelect });
    if (!resource) return { ok: false as const, error: 'not_found_or_not_visible' as const };
    const actor = await resolveTeamActorContextInTx(tx, { teamId: resource.teamId, actorAccountId: accountId });
    if (!actor || actor.accountStatus !== AccountStatus.active) return { ok: false as const, error: 'not_found_or_not_visible' as const };
    const caps = resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt });
    if (readsWholeTeamCredentialUsage({ viewerAccountId: accountId,
        custodianAccountId: resource.custodianAccountId, manageCredentials: caps.manageCredentials })) {
        const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, authentication);
        if (!qualification.ok) return qualification;
        return { ok: true as const, resource, manager: true as const,
            directUsePossible: hasDirectRoute(resource)
                || await hasTeamCredentialResourceDirectDeliveryActivityInTx(tx, { resourceId }) };
    }
    const entitlement = await resolveTeamCredentialEntitlementInTx(tx, { resourceId, accountId });
    if (!entitlement.ok) return { ok: false as const, error: 'not_found_or_not_visible' as const };
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, authentication);
    if (!qualification.ok) return qualification;
    return { ok: true as const, resource, manager: false as const,
        directUsePossible: entitlement.allowedRoutes.some(route => route !== 'brokered')
            || await hasTeamCredentialDirectDeliveryActivityInTx(tx, { resourceId, recipientAccountId: accountId }) };
}

/**
 * Admit one subject of the existing credential-usage query. Team aggregates
 * require credential management and Team authentication; Home aggregates use
 * Home administration alone. Chunked reads consume this result without another
 * authority decision. Resource reads retain custodian/manager or own-use scope.
 */
export async function authorizeTeamCredentialUsageSubjectInTx(tx: Tx, accountId: string,
    input: TeamCredentialUsageQueryInputV1, authentication: TeamOperationAuthenticationContext) {
    if (input.resourceId !== undefined) {
        const admitted = await authorizeResourceUsageInTx(tx, accountId, input.resourceId, authentication);
        return admitted.ok ? { ...admitted, resourceIds: [admitted.resource.id] } : admitted;
    }
    // The ingress schema already requires exactly one resource or subject.
    const subject = input.subject!;
    if (subject.kind === 'home') {
        const authority = resolveHomeGovernanceAuthority(await readHomeGovernanceAccountInTx(tx, accountId));
        if (!authority.viewAdministration) return { ok: false as const, error: 'not_found_or_not_visible' as const };
    } else {
        const actor = await resolveTeamActorContextInTx(tx, { teamId: subject.teamId, actorAccountId: accountId });
        if (!actor || actor.accountStatus !== AccountStatus.active
            || !resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).manageCredentials) {
            return { ok: false as const, error: 'not_found_or_not_visible' as const };
        }
        const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, authentication);
        if (!qualification.ok) return qualification;
    }
    const resources = await tx.teamCredentialResource.findMany({
        where: subject.kind === 'team' ? { teamId: subject.teamId } : {}, select: usageResourceSelect,
    });
    // Activity already retains the Team identity after resource deletion.
    const retained = subject.kind === 'team' ? await tx.teamCredentialActivityEvent.findMany({
        where: { subjectKind: 'team_credential', teamId: subject.teamId },
        select: { resourceId: true }, distinct: ['resourceId'],
    }) : [];
    return { ok: true as const, resource: null, manager: true as const,
        resourceIds: subject.kind === 'home' ? null : [...new Set([
            ...resources.map(resource => resource.id), ...retained.map(event => event.resourceId),
        ])],
        directUsePossible: resources.some(hasDirectRoute)
            || await hasTeamCredentialResourceDirectDeliveryActivityInTx(tx,
                subject.kind === 'team' ? { teamId: subject.teamId } : { kind: 'home' }),
    };
}
