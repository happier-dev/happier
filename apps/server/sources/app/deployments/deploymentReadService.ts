import { DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema, projectDeploymentControllerAvailabilityV1,
    type DeploymentEnvironmentAccessInputV1, type DeploymentEnvironmentAccessResultV1,
    type DeploymentEnvironmentGetInputV1, type DeploymentReceiptGetInputV1,
    type DeploymentEnvironmentListInputV1, type DeploymentReceiptListInputV1, DeploymentStateV1Schema } from '@happier-dev/protocol';
import { canTransitionDeploymentV1, projectDeploymentReceiptActivityV1 } from '@happier-dev/deployment-protocol/v1';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/deployment-protocol';
import type { Tx } from '@/storage/inTx';
import { deploymentFailure, resolveDeploymentEnvironmentAdmissionInTx, projectDeploymentSourceAdmission,
    canDeployDeploymentEnvironment, type DeploymentAuthentication, type DeploymentSourceAdmission } from './deploymentAdmission';
import { loadDeploymentEnvironmentInTx, projectDeploymentEnvironmentHeader,
    readDeploymentEnvironmentRequiredSecretUsesInTx, readDeploymentPreviewTemplateEnvironmentId } from './deploymentEnvironmentService';
import { readEnvironmentSecretGrantCoverageInTx } from './environmentSecretGrantRepository';
import { loadDeploymentTargetRowsInTx, projectDeploymentTargetHeader } from './deploymentTargetLinkService';
import { hasCompleteTeardownInTx } from './deploymentDispositionService';
import { openDeploymentReadCursor, sealDeploymentReadCursor } from './deploymentReadCursor';
import { projectDeploymentListRow, projectDeploymentSourcePresentation } from './deploymentListProjection';
import { projectDeploymentReceiptHeader } from './deploymentService';
import { admitDeploymentStoredContentInTx, admitDeploymentStoredContentsInTx } from './deploymentStoredContent';
import { readDeploymentPendingContent } from './deploymentPendingService';
import type { MachineDeploymentReferencesInputV1, MachineDeploymentReferencesPageV1, MachineReferenceV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveEffectiveMachineAccessForMachinesInTx } from '@/app/machines/machineAccess';
import { serializeMachinePresence } from '@/app/machines/machineSerialization';
import type { Prisma } from '@prisma/client';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { resolveProjectSourcesAccessInTx } from '@/app/projects/sources/projectSourceService';
import { deploymentInProgressStates } from './deploymentAcceptedExecution';
import { readDeploymentDomainEnvironmentIdsForMachineInTx, projectDeploymentDomainMachineReferences, projectDeploymentDomainHeader } from './deploymentDomainService';
import type { VerifiedExternalActionExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { readDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readSavedSecretResourcesForAccountInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { DeploymentApprovalEnvironmentResultV1Schema } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';

type AcceptedDeploymentRead = NonNullable<VerifiedExternalActionExecutionRequest['acceptedDeploymentReceipt']>['read'];

/** Approval needs the admitted relationship, never private definition or Link content. */
export async function readDeploymentApprovalEnvironmentInTx(tx: Tx, actorAccountId: string,
    input: Readonly<{ serverId: string; environmentId: string }>, authentication: DeploymentAuthentication,
    admittedEnvironmentId?: string,
) {
    if (admittedEnvironmentId === undefined) {
        const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
        if (!loaded.ok) return loaded;
    }
    const environment = await tx.deploymentEnvironment.findUnique({ where: { id: admittedEnvironmentId ?? input.environmentId },
        select: { id: true, projectSourceId: true, purpose: true, previewTemplateEnvironmentId: true,
            previewCompanionOfEnvironmentId: true,
            previewCompanionOfEnvironment: { select: { previewTemplateEnvironmentId: true } } } });
    if (!environment) return deploymentFailure('deployment_unavailable', { phase: 'deployment.approval.environment.read', causeKind: 'not_found' });
    const previewTemplateEnvironmentId = readDeploymentPreviewTemplateEnvironmentId(environment);
    return DeploymentApprovalEnvironmentResultV1Schema.parse({ ok: true, environment: {
        id: environment.id, projectSourceId: environment.projectSourceId, purpose: environment.purpose,
        ...(environment.previewCompanionOfEnvironmentId ? { previewCompanionOfEnvironmentId: environment.previewCompanionOfEnvironmentId } : {}),
        ...(previewTemplateEnvironmentId ? { previewTemplateEnvironmentId } : {}),
    } });
}

function acceptedEnvironmentRead(read: AcceptedDeploymentRead, environmentId: string, deploymentId?: string) {
    return read && (read.environmentId === environmentId || deploymentId !== undefined && read.deploymentId === deploymentId)
        ? { environmentId } : undefined;
}

/** Source rights only: private Artifact availability and native effects retain their own admission. */
export async function readDeploymentEnvironmentAccessInTx(tx: Tx, actorAccountId: string,
    input: DeploymentEnvironmentAccessInputV1, authentication: DeploymentAuthentication = {},
): Promise<DeploymentEnvironmentAccessResultV1> {
    const environmentIds = [...new Set(input.environmentIds)];
    if (!environmentIds.length) return { ok: true, items: [] };
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return deploymentFailure('deployment_unavailable', { phase: 'deployment.environment.access.server', causeKind: 'server_mismatch' });
    const environments = new Map<string, Readonly<{ id: string; projectSourceId: string; deletedAt: Date | null; deployerMode: string;
        deployers: readonly Readonly<{ principalKind: string; principalId: string }>[] }>>();
    for (const ids of portableQueryChunks({ values: environmentIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        const rows = await tx.deploymentEnvironment.findMany({ where: { id: { in: [...ids] } },
            select: { id: true, projectSourceId: true, deletedAt: true, deployerMode: true,
                deployers: { select: { principalKind: true, principalId: true } } } });
        for (const row of rows) environments.set(row.id, row);
    }
    const sources = await resolveProjectSourcesAccessInTx(tx, actorAccountId,
        [...new Set([...environments.values()].map(row => row.projectSourceId))], authentication, { includeDeleted: true });
    const items: Extract<DeploymentEnvironmentAccessResultV1, { ok: true }>['items'] = [];
    for (const environmentId of environmentIds) {
        const environment = environments.get(environmentId);
        const source = environment ? sources.get(environment.projectSourceId) : undefined;
        // Missing, malformed and unreadable records disclose the same absence.
        if (!environment || !source?.ok) continue;
        items.push({ environmentId, read: true,
            deploy: canDeployDeploymentEnvironment(projectDeploymentSourceAdmission(source), environment) });
    }
    return { ok: true, items };
}

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
): Promise<MachineDeploymentReferencesPageV1 | ReturnType<typeof deploymentFailure<'deployment_unavailable'>>> {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.homeId) return deploymentFailure('deployment_unavailable', { phase: 'deployment.machine.references.server', causeKind: 'server_mismatch' });
    const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, { accountIds: [actorAccountId], machineIds: [input.machineId] });
    if (!access.get(input.machineId)?.get(actorAccountId)) return deploymentFailure('deployment_unavailable', { phase: 'deployment.machine.references.access', causeKind: 'access_denied' });
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
        const admitted = sources.get(row.projectSourceId) ?? await resolveDeploymentEnvironmentAdmissionInTx(tx, actorAccountId,
            { serverId: input.homeId, projectSourceId: row.projectSourceId }, authentication);
        sources.set(row.projectSourceId, admitted);
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

/** Header reads acquire only demanded Artifact heads; clients own all private body opening. */
export async function readDeploymentEnvironmentInTx(tx: Tx, actorAccountId: string, input: DeploymentEnvironmentGetInputV1,
    authentication: DeploymentAuthentication = {},
    acceptedRead?: AcceptedDeploymentRead,
    registryRead?: VerifiedExternalActionExecutionRequest['registryAppUpdateRead'],
) {
    const registryEnvironment = registryRead?.environmentId === input.environmentId ? registryRead : undefined;
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication,
        acceptedEnvironmentRead(acceptedRead, input.environmentId) ?? registryEnvironment);
    if (!loaded.ok) return loaded;
    const pending = readDeploymentPendingContent(loaded.row);
    if (!pending.ok) return pending;
    // One Environment read includes runtime, data and retained link custody.
    const targetRows = await loadDeploymentTargetRowsInTx(tx, loaded.row.id);
    const targetLinks = targetRows.map(projectDeploymentTargetHeader);
    if (loaded.row.runtimeTargetLinkId && !targetLinks.some(link => link.id === loaded.row.runtimeTargetLinkId)) return deploymentFailure('deployment_unavailable', { phase: 'deployment.environment.read.runtime_target', causeKind: 'binding_missing' });
    // Registry admission already selected this Environment. Its Artifact GET
    // consumes the current reference through the existing mode/envelope reader.
    const failures = registryEnvironment || acceptedRead?.contentCustody && acceptedEnvironmentRead(acceptedRead, input.environmentId)
        ? [] : await admitDeploymentStoredContentsInTx(tx, actorAccountId, loaded.admission.owner, [
        { reference: loaded.row, expectedStoredKind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, access: 'read', pendingDeploy: pending.pendingDeploy },
        ...targetLinks.map(reference => ({ reference, expectedStoredKind: DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, access: 'read' as const })),
    ]);
    const contentFailure = failures.find(failure => failure !== null);
    if (contentFailure) return contentFailure;
    const controllerMachine = await tx.machine.findUnique({ where: { id: loaded.row.controllerMachineId },
        select: { active: true, lastActiveAt: true, revokedAt: true } });
    const controller = projectDeploymentControllerAvailabilityV1(loaded.row.controllerMachineId, controllerMachine
        ? { ...serializeMachinePresence(controllerMachine), revokedAt: controllerMachine.revokedAt?.getTime() ?? null }
        : null);
    const retainedTargetLinkCleanupCompleteIds: string[] = [];
    if (input.includeRetainedTargetLinkCleanup) {
        for (const link of targetRows) {
            if ((link.deletedAt !== null || link.detachedAt !== null || loaded.row.deletedAt !== null)
                && await hasCompleteTeardownInTx(tx, link, undefined, loaded.row.runtimeTargetLinkId, targetLinks)) {
                retainedTargetLinkCleanupCompleteIds.push(link.id);
            }
        }
    }
    const captures = readDeploymentBindingSavedSecretRevisionsV1(loaded.row.referencedSavedSecretRevisions);
    const resourceIds = captures?.map(capture => capture.resourceId);
    const resources = resourceIds?.length ? await readSavedSecretResourcesForAccountInTx(tx, actorAccountId,
        authentication.authenticationAuthority
            ? { ...authentication, authenticationAuthority: authentication.authenticationAuthority } : undefined,
        resourceIds) : [];
    const current = new Map(resources.flatMap(resource => 'ref' in resource && resource.capabilities.use && resource.revision !== null
        ? [[resource.ref, resource.revision] as const] : []));
    const savedSecretRevisions = captures?.flatMap(capture => {
        const revision = current.get(formatSharedSavedSecretRefV1(capture.resourceId));
        return revision === undefined ? [] : [{ resourceId: capture.resourceId, revision }];
    });
    const required = await readDeploymentEnvironmentRequiredSecretUsesInTx(tx, loaded.row);
    const coverage = await readEnvironmentSecretGrantCoverageInTx(tx, {
        environmentId: loaded.row.id, requiredSecretUses: required.requiredSecretUses,
    });
    const unavailableResource = captures?.some(capture => !current.has(formatSharedSavedSecretRefV1(capture.resourceId)));
    const changedResource = captures?.some(capture => current.get(formatSharedSavedSecretRefV1(capture.resourceId)) !== capture.revision);
    const secretScope = {
        ...coverage,
        ...(required.status === 'incomplete' ? { status: 'unavailable', reason: 'secret_scope_requirements_unavailable' }
            : unavailableResource ? { status: 'unavailable', reason: 'secret_scope_resource_unavailable' }
                : changedResource ? { status: 'actionNeeded', reason: 'secret_scope_resource_revision_changed' }
                    : coverage.missingGrantCount ? { status: 'actionNeeded', reason: 'secret_scope_grants_required' }
                        : { status: 'ready', reason: 'secret_scope_current' }),
    };
    return DeploymentEnvironmentGetResultV1Schema.parse({ ok: true,
        environment: projectDeploymentEnvironmentHeader(loaded.row, input.serverId, loaded.admission), targetLinks, controller,
        secretScope,
        ...(savedSecretRevisions === undefined ? {} : { savedSecretRevisions }),
        ...(input.includeRetainedTargetLinkCleanup ? { retainedTargetLinkCleanupCompleteIds } : {}),
        ...(pending.pendingDeploy ? { pendingDeploy: pending.pendingDeploy } : {}),
        ...('pendingAdmission' in pending && pending.pendingAdmission ? { pendingAdmission: pending.pendingAdmission } : {}) });
}

export async function readDeploymentReceiptInTx(tx: Tx, actorAccountId: string,
    input: Omit<DeploymentReceiptGetInputV1, 'environmentId'> & Readonly<{ environmentId?: string }>,
    authentication: DeploymentAuthentication = {},
    acceptedRead?: AcceptedDeploymentRead,
) {
    const row = await tx.deployment.findUnique({ where: { id: input.deploymentId } });
    if (!row || (input.environmentId !== undefined && input.environmentId !== row.environmentId)) return deploymentFailure('deployment_unavailable', { phase: 'deployment.receipt.read', causeKind: row ? 'access_denied' : 'not_found' });
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, row.environmentId, authentication,
        acceptedEnvironmentRead(acceptedRead, row.environmentId, row.id));
    if (!loaded.ok) return loaded;
    const contentFailure = acceptedRead?.contentCustody && acceptedEnvironmentRead(acceptedRead, row.environmentId, row.id)
        ? null : await admitDeploymentStoredContentInTx(tx, actorAccountId, loaded.admission.owner, row, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, 'read');
    if (contentFailure) return contentFailure;
    const deployment = projectDeploymentReceiptHeader(row);
    return DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment,
        // Same Source admission and lifecycle rule as requestCancelDeploymentInTx.
        // This is presentation, not a second authority or an admission proof.
        cancellable: canDeployDeploymentEnvironment(loaded.admission, loaded.row)
            && deployment.cancelRequestedAtMs === undefined && canTransitionDeploymentV1(deployment.state, 'outcome_unknown') });
}

/** Source and exact Machine selectors reach the relational owner before pagination, never private bodies. */
export async function listDeploymentEnvironmentsInTx(tx: Tx, actorAccountId: string, input: DeploymentEnvironmentListInputV1,
    authentication: DeploymentAuthentication = {},
) {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return deploymentFailure('deployment_unavailable', { phase: 'deployment.environment.list.server', causeKind: 'server_mismatch' });
    let cursor: string | undefined;
    try { cursor = openDeploymentReadCursor(actorAccountId, input); }
    catch { return deploymentFailure('deployment_invalid'); }
    if (input.machineId) {
        const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, { accountIds: [actorAccountId], machineIds: [input.machineId] });
        if (!access.get(input.machineId)?.get(actorAccountId)) return deploymentFailure('deployment_unavailable', { phase: 'deployment.environment.list.machine_access', causeKind: 'access_denied' });
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
        // Same latest-attempt ordering as the list below. Aggregate Environment counts
        // by Source/state before admission; never load inventories or private content.
        const sql = `SELECT e."projectSourceId" AS "projectSourceId", d."state" AS "state", COUNT(*) AS "environmentCount"
            FROM "DeploymentEnvironment" e JOIN "Deployment" d ON d."id" = (
                SELECT newest."id" FROM "Deployment" newest WHERE newest."environmentId" = e."id"
                ORDER BY newest."requestedAt" DESC, newest."id" DESC LIMIT 1
            ) WHERE e."deletedAt" IS NULL${sourceFilter}
            GROUP BY e."projectSourceId", d."state"`;
        const rows = await tx.$queryRawUnsafe<Array<{ projectSourceId: string; state: string; environmentCount: bigint | number | string }>>(
            provider === 'mysql' ? sql.replaceAll('"', '`') : sql,
            ...(input.projectSourceId === undefined ? [] : [input.projectSourceId]));
        const sourceIds = [...new Set(rows.map(row => row.projectSourceId))].filter(id => !sources.has(id));
        const admissions = sourceIds.length ? await resolveProjectSourcesAccessInTx(tx, actorAccountId, sourceIds, authentication, { includeDeleted: true }) : null;
        const activity = { running: false, failed: false, attentionCount: 0 };
        for (const row of rows) {
            if (sources.get(row.projectSourceId)?.ok !== true && admissions?.get(row.projectSourceId)?.ok !== true) continue;
            const fact = projectDeploymentReceiptActivityV1(DeploymentStateV1Schema.parse(row.state));
            activity.running ||= fact.running;
            activity.failed ||= fact.failed;
            if (fact.running || fact.failed) activity.attentionCount += Number(row.environmentCount);
        }
        return { ok: true as const, items: [], currentDeployments: [], runtimeTargetLinks: [],
            nextCursor: null, coverage: 'complete' as const, activity };
    }
    // Deployment content uses the incumbent Artifact-backed structural page budget.
    const limit = Math.min(input.limit ?? ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, ARTIFACT_LIST_PAGE_MAX_ITEMS_V1);
    // Newly generated Environment ids lead the finite inventory; continuation visits older ids.
    const readRows = (where: Prisma.DeploymentEnvironmentWhereInput) => tx.deploymentEnvironment.findMany({
        where, orderBy: { id: 'desc' }, take: limit + 1,
        include: { deployers: { select: { principalKind: true, principalId: true } },
            previewCompanionOfEnvironment: { select: { previewTemplateEnvironmentId: true } },
            // Exact visible groups consume Environment headers, not latest-attempt
            // history. Ordinary inventory retains its incumbent receipt projection.
            deployments: input.environmentIds === undefined
                ? { orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: 1 } : false,
            domains: input.environmentIds === undefined ? { where: { deletedAt: null }, orderBy: { id: 'asc' } } : false,
            runtimeTargetLink: { include: { machines: { orderBy: { position: 'asc' } },
                activeDeployment: input.environmentIds === undefined } } } });
    // Carry only the existing page window into the next query. The database
    // merges it with that selection chunk in its native collation, preserving
    // the ordinary list/cursor contract without a JavaScript ordering copy.
    const fixedBindings = limit + 1 // Retained page candidates.
        + 2 // List take/offset.
        + (input.environmentIds === undefined ? 1 : 0) // Latest receipt take.
        + (input.projectSourceId ? 1 : 0)
        + (input.previewRepositoryId === undefined ? 0 : 1)
        + (input.previewPullRequestIds === undefined && input.previewTemplateEnvironmentId === undefined ? 0 : 1) // Preview purpose.
        + (input.previewTemplateEnvironmentId === undefined ? 0 : 1)
        + (input.previewCompanionOfEnvironmentId === undefined ? 0 : 1)
        + (cursor ? 1 : 0)
        + (input.machineId ? 7 + deploymentInProgressStates().length : 0);
    const bindingsPerValue = input.environmentIds !== undefined && input.previewPullRequestIds !== undefined ? 2 : 1;
    const environmentChunks = input.environmentIds === undefined ? [undefined]
        : portableQueryChunks({ values: [...new Set(input.environmentIds)], bindingsPerValue, fixedBindings });
    const previewChunks = input.previewPullRequestIds === undefined ? [undefined]
        : portableQueryChunks({ values: [...new Set(input.previewPullRequestIds)], bindingsPerValue, fixedBindings });
    let rows: Awaited<ReturnType<typeof readRows>> = [];
    for (const environmentIds of environmentChunks) {
        for (const previewPullRequestIds of previewChunks) {
            const where: Prisma.DeploymentEnvironmentWhereInput = {
                ...(input.includeDeleted ? {} : { deletedAt: null }),
                ...(input.projectSourceId ? { projectSourceId: input.projectSourceId } : {}),
                ...(input.previewCompanionOfEnvironmentId === undefined ? {} : {
                    previewCompanionOfEnvironmentId: input.previewCompanionOfEnvironmentId }),
                ...(input.previewPullRequestIds === undefined ? {} : { purpose: 'preview',
                    previewPullRequestId: { in: previewPullRequestIds ? [...previewPullRequestIds] : undefined } }),
                ...(input.previewRepositoryId === undefined ? {} : { previewRepositoryId: input.previewRepositoryId }),
                ...(input.previewTemplateEnvironmentId === undefined ? {} : { purpose: 'preview',
                    previewTemplateEnvironmentId: input.previewTemplateEnvironmentId }),
                ...(cursor || environmentIds !== undefined ? { id: {
                    ...(environmentIds === undefined ? {} : { in: [...environmentIds] }),
                    ...(cursor ? { lt: cursor } : {}),
                } } : {}),
                ...(input.machineId ? deploymentMachineReferenceWhere(input.machineId) : {}),
            };
            rows = await readRows(rows.length ? { OR: [where, { id: { in: rows.map(row => row.id) } }] } : where);
        }
    }
    const hasNext = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items: ReturnType<typeof projectDeploymentEnvironmentHeader>[] = [];
    const projectSources = new Map<string, Pick<DeploymentSourceAdmission['source'], 'id' | 'name'>>();
    const currentDeployments: ReturnType<typeof projectDeploymentReceiptHeader>[] = [];
    const servingDeployments: ReturnType<typeof projectDeploymentReceiptHeader>[] = [];
    const liveAddressDomains: ReturnType<typeof projectDeploymentDomainHeader>[] = [];
    const runtimeTargetLinks: ReturnType<typeof projectDeploymentTargetHeader>[] = [];
    let coverage: 'complete' | 'partial' = 'complete';
    const selectedRepository = input.previewRepository ? normalizeScmHostingRepositoryIdentity(input.previewRepository) : null;
    for (const row of selected) {
        const source = sources.get(row.projectSourceId) ?? await resolveDeploymentEnvironmentAdmissionInTx(tx, actorAccountId,
            { serverId: input.serverId, projectSourceId: row.projectSourceId }, authentication);
        sources.set(row.projectSourceId, source);
        if (!source.ok) { coverage = 'partial'; continue; }
        if (input.previewRepository) {
            const selector = source.admission.source.repository;
            const repository = selector && normalizeScmHostingRepositoryIdentity({ kind: selector.provider.kind,
                deployment: selector.provider.baseUrl, repository: selector.repository.nameWithOwner });
            if (!repository || !selectedRepository || !sameScmHostingRepositoryIdentity(repository, selectedRepository)) continue;
        }
        if (row.runtimeTargetLink && row.runtimeTargetLink.environmentId !== row.id) { coverage = 'partial'; continue; }
        const environment = projectDeploymentListRow(() => projectDeploymentEnvironmentHeader(row, input.serverId, source.admission));
        if (!environment) { coverage = 'partial'; continue; }
        items.push(environment);
        // Source admission already loaded this exact name. Preserve its existing
        // disclosed-metadata contract, not a copy in Environment metadata/storage.
        projectSources.set(row.projectSourceId, projectDeploymentSourcePresentation(source.admission.source));
        for (const receipt of row.deployments ?? []) {
            const projected = projectDeploymentListRow(() => projectDeploymentReceiptHeader(receipt));
            if (projected) currentDeployments.push(projected);
            else coverage = 'partial';
        }
        for (const domain of row.domains ?? []) {
            const projected = projectDeploymentListRow(() => projectDeploymentDomainHeader(domain));
            if (projected) liveAddressDomains.push(projected);
            else coverage = 'partial';
        }
        if (row.runtimeTargetLink) {
            const link = row.runtimeTargetLink;
            const projected = projectDeploymentListRow(() => projectDeploymentTargetHeader(link));
            if (projected) runtimeTargetLinks.push(projected);
            else coverage = 'partial';
            if (projected && link.activeDeployment) {
                const receipt = projectDeploymentListRow(() => projectDeploymentReceiptHeader(link.activeDeployment!));
                if (receipt) servingDeployments.push(receipt);
                else coverage = 'partial';
            }
        }
    }
    const last = selected.at(-1);
    const nextCursor = hasNext && last
        ? items.at(-1)?.id === last.id ? last.id : sealDeploymentReadCursor(actorAccountId, input, last.id)
        : null;
    return { ok: true as const, items, projectSources: [...projectSources.values()], currentDeployments, runtimeTargetLinks, coverage,
        ...(input.environmentIds === undefined ? { servingDeployments, liveAddressDomains } : {}),
        nextCursor };
}

/** One newest-first Environment history window; no Artifact header or body census. */
export async function listDeploymentReceiptsInTx(tx: Tx, actorAccountId: string, input: DeploymentReceiptListInputV1,
    authentication: DeploymentAuthentication = {},
    acceptedRead?: AcceptedDeploymentRead,
) {
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication,
        acceptedEnvironmentRead(acceptedRead, input.environmentId));
    if (!loaded.ok) return loaded;
    const filters: Prisma.DeploymentWhereInput = { environmentId: input.environmentId,
        ...(input.state ? { state: input.state } : {}),
        ...(input.actorAccountId ? { requestedByAccountId: input.actorAccountId } : {}),
        ...(input.operation ? { operation: input.operation } : {}) };
    if (input.inProgressOnly) {
        // The Environment lock admits one in-progress receipt, so observing
        // that fact never needs to page settled history or fetch content.
        const busy = await tx.deployment.findFirst({ where: { ...filters,
            AND: { state: { in: deploymentInProgressStates() } } } });
        return { ok: true as const, items: busy ? [projectDeploymentReceiptHeader(busy)] : [], nextCursor: null };
    }
    const limit = Math.min(input.limit ?? ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, ARTIFACT_LIST_PAGE_MAX_ITEMS_V1);
    const cursor = input.cursor ? await tx.deployment.findFirst({
        where: { id: input.cursor, environmentId: input.environmentId }, select: { id: true, requestedAt: true },
    }) : null;
    if (input.cursor && !cursor) return deploymentFailure('deployment_invalid');
    const rows = await tx.deployment.findMany({ where: { ...filters,
        ...(cursor ? { OR: [{ requestedAt: { lt: cursor.requestedAt } },
            { requestedAt: cursor.requestedAt, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const hasNext = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.flatMap(row => {
        const projected = projectDeploymentListRow(() => projectDeploymentReceiptHeader(row));
        return projected ? [projected] : [];
    });
    return { ok: true as const, items, nextCursor: hasNext ? selected.at(-1)!.id : null };
}
