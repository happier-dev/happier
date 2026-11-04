import type { DeploymentTargetLinksListInputV1, DeploymentTargetLinksListResultV1 } from '@happier-dev/protocol';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/deployment-protocol';
import type { Tx } from '@/storage/inTx';
import { getActivePrismaRuntime } from '@/storage/prisma';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { qualifyTeamOperationAuthenticationInTx, resolveTeamActorContextInTx } from '@/app/teams/actorContext';
import { isEffectiveTeamMembership } from '@/app/teams/memberships/effectiveMembership';
import { deploymentFailure, resolveDeploymentEnvironmentAdmissionInTx, type DeploymentAuthentication } from './deploymentAdmission';
import { projectDeploymentEnvironmentHeader } from './deploymentEnvironmentService';
import { projectDeploymentTargetHeader } from './deploymentTargetLinkService';
import { admitDeploymentStoredContentsInTx } from './deploymentStoredContent';
import { projectDeploymentListRow } from './deploymentListProjection';
import { openDeploymentReadCursor, sealDeploymentReadCursor } from './deploymentReadCursor';

/** A finite preparation demand lists only admitted headers; private identity comparison belongs to the linking client. */
export async function listDeploymentTargetLinksInTx(tx: Tx, actorAccountId: string, input: DeploymentTargetLinksListInputV1,
    authentication: DeploymentAuthentication = {},
): Promise<DeploymentTargetLinksListResultV1> {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return deploymentFailure('deployment_unavailable');
    if (input.scope.kind === 'account') {
        if (input.scope.accountId !== actorAccountId || !(await tx.account.findFirst({ where: { id: actorAccountId, status: 'active' }, select: { id: true } }))) {
            return deploymentFailure('deployment_unavailable');
        }
    } else {
        const context = await resolveTeamActorContextInTx(tx, { actorAccountId, teamId: input.scope.teamId });
        if (!context?.membership || !isEffectiveTeamMembership({ accountStatus: context.accountStatus,
            membershipStatus: context.membership.status, teamArchivedAt: context.team.archivedAt })) return deploymentFailure('deployment_unavailable');
        if (!(await qualifyTeamOperationAuthenticationInTx(tx, { ...authentication, context })).ok) return deploymentFailure('deployment_unavailable');
    }
    const scope = input.scope;
    const selection = input.selection;
    let cursor: string | undefined;
    try { cursor = openDeploymentReadCursor(actorAccountId, input); }
    catch { return deploymentFailure('deployment_invalid'); }
    const limit = Math.min(input.limit ?? ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, ARTIFACT_LIST_PAGE_MAX_ITEMS_V1);
    const rows = await tx.deploymentTargetLink.findMany({ where: { deletedAt: null, detachedAt: null,
        ...(selection ? { targetKind: selection.targetKind, sourceKind: selection.source.kind,
            ...(selection.source.kind === 'plugin'
                ? { pluginId: selection.source.contribution.pluginId, contributionLocalId: selection.source.contribution.localId }
                : { hostTargetId: selection.source.id }) } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
        environment: { deletedAt: null, projectSource: { OR: [{ owner: { equals: scope } },
            ...(scope.kind === 'account' ? [{ owner: { equals: getActivePrismaRuntime().DbNull }, createdByAccountId: scope.accountId }] : [])] } },
    }, orderBy: { id: 'asc' }, take: limit + 1,
    include: { environment: { include: { deployers: { select: { principalKind: true, principalId: true } } } }, machines: { orderBy: { position: 'asc' } } } });
    const sources = new Map<string, Awaited<ReturnType<typeof resolveDeploymentEnvironmentAdmissionInTx>>>();
    const candidates: { row: (typeof rows)[number]; environment: ReturnType<typeof projectDeploymentEnvironmentHeader>;
        targetLink: ReturnType<typeof projectDeploymentTargetHeader> }[] = [];
    const items: Extract<DeploymentTargetLinksListResultV1, { ok: true }>['items'] = [];
    let coverage: 'complete' | 'partial' = 'complete';
    for (const row of rows.slice(0, limit)) {
        let source = sources.get(row.environment.projectSourceId);
        if (!source) {
            source = await resolveDeploymentEnvironmentAdmissionInTx(tx, actorAccountId,
                { serverId: input.serverId, projectSourceId: row.environment.projectSourceId }, authentication);
            sources.set(row.environment.projectSourceId, source);
        }
        if (!source.ok || source.admission.owner.kind !== scope.kind
            || (source.admission.owner.kind === 'account' && scope.kind === 'account' && source.admission.owner.accountId !== scope.accountId)
            || (source.admission.owner.kind === 'team' && scope.kind === 'team' && source.admission.owner.teamId !== scope.teamId)) {
            coverage = 'partial'; continue;
        }
        const projected = projectDeploymentListRow(() => ({
            environment: projectDeploymentEnvironmentHeader(row.environment, input.serverId, source.admission),
            targetLink: projectDeploymentTargetHeader(row),
        }));
        if (!projected) { coverage = 'partial'; continue; }
        candidates.push({ row, ...projected });
    }
    const environments = [...new Map(candidates.map(({ row }) => [row.environmentId, row.environment])).values()];
    const failures = await admitDeploymentStoredContentsInTx(tx, actorAccountId, scope, [
        ...environments.map(reference => ({ reference, expectedStoredKind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, access: 'read' as const })),
        ...candidates.map(({ row: reference }) => ({ reference, expectedStoredKind: DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, access: 'read' as const })),
    ]);
    const environmentFailures = new Map(environments.map((environment, index) => [environment.id, failures[index]]));
    for (const [index, { row, environment, targetLink }] of candidates.entries()) {
        if (environmentFailures.get(row.environmentId) || failures[environments.length + index]) { coverage = 'partial'; continue; }
        items.push({ environment, targetLink });
    }
    const last = rows[Math.min(rows.length, limit) - 1];
    const nextCursor = rows.length > limit && last
        ? items.at(-1)?.targetLink.id === last.id ? last.id : sealDeploymentReadCursor(actorAccountId, input, last.id)
        : null;
    // Opaque positions advance all-omitted pages without disclosing an unreadable identity.
    return { ok: true, items, nextCursor, coverage };
}
