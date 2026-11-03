import { DeploymentStateV1Schema, type DeploymentEnvironmentListInputV1 } from '@happier-dev/protocol';
import { projectDeploymentReceiptActivityV1 } from '@happier-dev/deployment-protocol/v1';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import type { Tx } from '@/storage/inTx';
import { deploymentFailure, resolveDeploymentEnvironmentAdmissionInTx,
    type DeploymentAuthentication, type DeploymentSourceAdmission } from './deploymentAdmission';
import { projectDeploymentEnvironmentHeader } from './deploymentEnvironmentService';
import { projectDeploymentTargetHeader } from './deploymentTargetLinkService';
import { openDeploymentReadCursor, sealDeploymentReadCursor } from './deploymentReadCursor';
import { projectDeploymentReceiptHeader } from './deploymentService';
import type { MachineDeploymentReferencesInputV1, MachineDeploymentReferencesPageV1, MachineReferenceV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveEffectiveMachineAccessForMachinesInTx } from '@/app/machines/machineAccess';
import type { Prisma } from '@prisma/client';
import { resolveProjectSourcesAccessInTx } from '@/app/projects/sources/projectSourceService';
import { deploymentInProgressStates } from './deploymentAcceptedExecution';
import { readDeploymentDomainEnvironmentIdsForMachineInTx, projectDeploymentDomainMachineReferences } from './deploymentDomainService';

function deploymentMachineReferenceWhere(machineId: string) {
    return { OR: [{ controllerMachineId: machineId }, { buildMachineId: machineId }, { edgeMachineId: machineId },
        { deployments: { some: { state: { in: deploymentInProgressStates() }, OR: [
            { acceptedControllerMachineId: machineId }, { acceptedBuildMachineId: machineId },
        ] } } },
        { targetLinks: { some: { OR: [{ machineId }, { machines: { some: { machineId } } }] } } }],
    } satisfies Prisma.DeploymentEnvironmentWhereInput;
}

/** Machine removal reads only matching relational custody, including retained/tombstoned links. */
export async function readDeploymentMachineReferencesInTx(tx: Tx, actorAccountId: string,
    input: MachineDeploymentReferencesInputV1, authentication: DeploymentAuthentication = {},
): Promise<MachineDeploymentReferencesPageV1 | ReturnType<typeof deploymentFailure>> {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.homeId) return deploymentFailure('deployment_unavailable');
    const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, { accountIds: [actorAccountId], machineIds: [input.machineId] });
    if (!access.get(input.machineId)?.get(actorAccountId)) return deploymentFailure('deployment_unavailable');
    const limit = ARTIFACT_LIST_PAGE_MAX_ITEMS_V1;
    const capturedDomainEnvironmentIds = await readDeploymentDomainEnvironmentIdsForMachineInTx(tx, {
        machineId: input.machineId, afterEnvironmentId: input.cursor, limit: limit + 1,
    });
    const rows = await tx.deploymentEnvironment.findMany({ where: {
        ...(input.cursor ? { id: { gt: input.cursor } } : {}),
        OR: [deploymentMachineReferenceWhere(input.machineId), { id: { in: capturedDomainEnvironmentIds } }],
    }, select: { id: true, projectSourceId: true, controllerMachineId: true, buildMachineId: true, edgeMachineId: true,
        runtimeTargetLinkId: true, deployments: { where: { state: { in: deploymentInProgressStates() }, OR: [
            { acceptedControllerMachineId: input.machineId }, { acceptedBuildMachineId: input.machineId },
        ] }, select: { acceptedControllerMachineId: true, acceptedBuildMachineId: true } }, targetLinks: { where: {
            OR: [{ machineId: input.machineId }, { machines: { some: { machineId: input.machineId } } }],
        }, select: { id: true, role: true, deletedAt: true, detachedAt: true } },
        domains: { where: { deletedAt: null }, select: { id: true, environmentId: true, capturedPlacements: true } } },
    orderBy: { id: 'asc' }, take: limit + 1 });
    const references: MachineReferenceV1[] = [];
    const sources = new Map<string, Awaited<ReturnType<typeof resolveDeploymentEnvironmentAdmissionInTx>>>();
    let coverage: MachineDeploymentReferencesPageV1['coverage'] = 'complete';
    for (const row of rows.slice(0, limit)) {
        let admitted = sources.get(row.projectSourceId);
        if (!admitted) {
            admitted = await resolveDeploymentEnvironmentAdmissionInTx(tx, actorAccountId,
                { serverId: input.homeId, projectSourceId: row.projectSourceId }, authentication);
            sources.set(row.projectSourceId, admitted);
        }
        // Hidden Source identities stay hidden, but cannot become a false "unused" fact.
        if (!admitted.ok) { coverage = 'partial'; continue; }
        const roles = new Set<NonNullable<MachineReferenceV1['deploymentRoles']>[number]>();
        for (const link of row.targetLinks) roles.add(link.detachedAt ? 'detached'
            : link.deletedAt ? 'retiring' : link.role === 'data' ? 'data'
                : row.runtimeTargetLinkId !== link.id ? 'retiring' : 'runtime');
        if (row.controllerMachineId === input.machineId) roles.add('controller');
        if (row.buildMachineId === input.machineId) roles.add('build');
        if (row.edgeMachineId === input.machineId) roles.add('edge');
        if (capturedDomainEnvironmentIds.includes(row.id) && row.edgeMachineId !== input.machineId && row.targetLinks.length === 0) roles.add('retiring');
        for (const receipt of row.deployments) {
            if (receipt.acceptedControllerMachineId === input.machineId) roles.add('controller');
            if (receipt.acceptedBuildMachineId === input.machineId) roles.add('build');
        }
        references.push({ kind: 'deployment_environment', id: row.id, name: '',
            deploymentDomains: row.domains.flatMap(domain => projectDeploymentDomainMachineReferences(domain, input.machineId)),
            deploymentRoles: (['runtime', 'data', 'retiring', 'detached', 'controller', 'build', 'edge'] as const).filter(role => roles.has(role)) });
    }
    return { homeId: input.homeId, machineId: input.machineId, coverage, references,
        // A cursor must not disclose an unreadable Environment id. If no
        // admitted row can advance this page, coverage already records partial.
        nextCursor: rows.length > limit ? references.at(-1)?.id ?? null : null };
}


/** Source and exact Machine selectors reach the relational owner before pagination, never private bodies. */
export async function listDeploymentEnvironmentsInTx(tx: Tx, actorAccountId: string, input: DeploymentEnvironmentListInputV1,
    authentication: DeploymentAuthentication = {},
) {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return deploymentFailure('deployment_unavailable');
    let cursor: string | undefined;
    try { cursor = openDeploymentReadCursor(actorAccountId, input); }
    catch { return deploymentFailure('deployment_invalid'); }
    if (input.machineId) {
        const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, { accountIds: [actorAccountId], machineIds: [input.machineId] });
        if (!access.get(input.machineId)?.get(actorAccountId)) return deploymentFailure('deployment_unavailable');
    }
    const sources = new Map<string, Awaited<ReturnType<typeof resolveDeploymentEnvironmentAdmissionInTx>>>();
    if (input.projectSourceId) {
        const source = await resolveDeploymentEnvironmentAdmissionInTx(tx, actorAccountId,
            { serverId: input.serverId, projectSourceId: input.projectSourceId }, authentication);
        if (!source.ok) return source;
        sources.set(input.projectSourceId, source);
    }
    if (input.projection === 'activity') {
        const provider = getDbProviderFromEnv(process.env, 'postgres');
        const sourceFilter = input.projectSourceId === undefined ? ''
            : ` AND e."projectSourceId" = ${provider === 'postgres' ? '$1' : '?'}`;
        // Same latest-attempt ordering as the list below. Return only distinct
        // Source/state pairs, never Environment inventories or private content.
        const sql = `SELECT DISTINCT e."projectSourceId" AS "projectSourceId", d."state" AS "state"
            FROM "DeploymentEnvironment" e JOIN "Deployment" d ON d."id" = (
                SELECT newest."id" FROM "Deployment" newest WHERE newest."environmentId" = e."id"
                ORDER BY newest."requestedAt" DESC, newest."id" DESC LIMIT 1
            ) WHERE e."deletedAt" IS NULL${sourceFilter}`;
        const rows = await tx.$queryRawUnsafe<Array<{ projectSourceId: string; state: string }>>(
            provider === 'mysql' ? sql.replaceAll('"', '`') : sql,
            ...(input.projectSourceId === undefined ? [] : [input.projectSourceId]));
        const sourceIds = [...new Set(rows.map(row => row.projectSourceId))].filter(id => !sources.has(id));
        const admissions = sourceIds.length ? await resolveProjectSourcesAccessInTx(tx, actorAccountId, sourceIds, authentication) : null;
        const activity = { running: false, failed: false };
        for (const row of rows) {
            if (sources.get(row.projectSourceId)?.ok !== true && admissions?.get(row.projectSourceId)?.ok !== true) continue;
            const fact = projectDeploymentReceiptActivityV1(DeploymentStateV1Schema.parse(row.state));
            activity.running ||= fact.running;
            activity.failed ||= fact.failed;
        }
        return { ok: true as const, items: [], currentDeployments: [], runtimeTargetLinks: [],
            nextCursor: null, coverage: 'complete' as const, activity };
    }
    // Deployment content uses the incumbent Artifact-backed structural page budget.
    const limit = Math.min(input.limit ?? ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, ARTIFACT_LIST_PAGE_MAX_ITEMS_V1);
    const rows = await tx.deploymentEnvironment.findMany({ where: {
        ...(input.includeDeleted ? {} : { deletedAt: null }),
        ...(input.projectSourceId ? { projectSourceId: input.projectSourceId } : {}),
        ...(input.previewRepositoryId === undefined ? {} : { purpose: 'preview', previewRepositoryId: input.previewRepositoryId,
            previewPullRequestId: { in: input.previewPullRequestIds } }),
        ...(input.previewTemplateEnvironmentId === undefined ? {} : { purpose: 'preview',
            previewTemplateEnvironmentId: input.previewTemplateEnvironmentId }),
        ...(cursor || input.environmentIds !== undefined ? { id: {
            ...(input.environmentIds === undefined ? {} : { in: input.environmentIds }),
            ...(cursor ? { gt: cursor } : {}),
        } } : {}),
        ...(input.machineId ? deploymentMachineReferenceWhere(input.machineId) : {}),
    }, orderBy: { id: 'asc' }, take: limit + 1,
    include: { deployers: { select: { principalKind: true, principalId: true } },
        // Exact visible groups consume Environment headers, not latest-attempt
        // history. Ordinary inventory retains its incumbent receipt projection.
        deployments: input.environmentIds === undefined
            ? { orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: 1 } : false,
        runtimeTargetLink: { include: { machines: { orderBy: { position: 'asc' } } } } } });
    const hasNext = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items: ReturnType<typeof projectDeploymentEnvironmentHeader>[] = [];
    const projectSources = new Map<string, Pick<DeploymentSourceAdmission['source'], 'id' | 'name'>>();
    const currentDeployments: ReturnType<typeof projectDeploymentReceiptHeader>[] = [];
    const runtimeTargetLinks: ReturnType<typeof projectDeploymentTargetHeader>[] = [];
    let coverage: 'complete' | 'partial' = 'complete';
    for (const row of selected) {
        let source = sources.get(row.projectSourceId);
        if (!source) {
            source = await resolveDeploymentEnvironmentAdmissionInTx(tx, actorAccountId,
                { serverId: input.serverId, projectSourceId: row.projectSourceId }, authentication);
            sources.set(row.projectSourceId, source);
        }
        if (!source.ok) { coverage = 'partial'; continue; }
        if (row.runtimeTargetLink && row.runtimeTargetLink.environmentId !== row.id) return deploymentFailure('deployment_unavailable');
        items.push(projectDeploymentEnvironmentHeader(row, input.serverId, source.admission));
        // Source admission already loaded this exact name. Preserve its existing
        // disclosed-metadata contract, not a copy in Environment metadata/storage.
        projectSources.set(row.projectSourceId, { id: source.admission.source.id, name: source.admission.source.name });
        currentDeployments.push(...(row.deployments ?? []).map(projectDeploymentReceiptHeader));
        if (row.runtimeTargetLink) runtimeTargetLinks.push(projectDeploymentTargetHeader(row.runtimeTargetLink));
    }
    const last = selected.at(-1);
    const nextCursor = hasNext && last
        ? items.at(-1)?.id === last.id ? last.id : sealDeploymentReadCursor(actorAccountId, input, last.id)
        : null;
    return { ok: true as const, items, projectSources: [...projectSources.values()], currentDeployments, runtimeTargetLinks, coverage,
        nextCursor };
}
