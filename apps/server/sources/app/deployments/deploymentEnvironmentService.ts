import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isDeploymentEnvironmentUpdateNativeAdmissionV1,
    type ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentEnvironmentHeaderV1Schema, DeploymentEnvironmentDeployerPrincipalsV1Schema, DeploymentPreviewDataTargetsV1Schema,
    type DeploymentEnvironmentDeployerPrincipalV1, type DeploymentEnvironmentCreateStorageInputV1 } from '@happier-dev/protocol';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1,
    machineSecretGrantSubjectKey, resolveDeploymentStoredDefinitionRevisionV1,
    isDeploymentEnvironmentBindingsOnlyUpdateV1, reconcileDeploymentRemovedDataServicesV1,
    applyOwnServerEnvironmentConfigurationPatchV1,
    isEnvironmentSecretBindingManagedByBindingsWriterV1, readRetainedOperationalEnvironmentBindingGrantsV1,
    captureDeploymentBindingSavedSecretRevisionsV1, matchesDeploymentBindingSavedSecretCapturesV1,
    normalizeDeploymentBindingSavedSecretRevisionsV1, readDeploymentBindingSavedSecretRevisionsV1,
    type DeploymentBindingsSetStorageInputV1, type DeploymentEnvironmentTemplateSetInputV1, type DeploymentEnvironmentBackupSetInputV1,
    type DeploymentEnvironmentUpdateStorageInputV1 } from '@happier-dev/deployment-protocol';
import { prepareDeploymentBackupRetentionV1, projectEnvironmentSecretBindingRequiredUsesV1,
    type EnvironmentSecretRequiredUsesProjectionV1 } from '@happier-dev/deployments';
import { formatSharedSavedSecretRefV1, parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readSavedSecretResourcesForAccountInTx, validateSavedSecretResourceReferenceCapturesV1,
    readSavedSecretResourcesForPrincipalInTx, publishSavedSecretUsageChangesInTx,
    acquireSavedSecretReferencePublicationAccountsInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { defaultRepeatKeyExpiresAt, fetchRepeatKey, lockPostgresRepeatKeyInTx, saveRepeatKey } from '@/storage/queue/repeatKey';
import { readTransactionDatabaseTime } from '@/storage/transactionDatabaseTime';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import { resolveDeploymentEnvironmentAdmissionInTx, admitDeploymentMachineInTx, admitDeploymentMachinesInTx, deploymentFailure, canDeployDeploymentEnvironment,
    admitDeploymentDefinitionMachinesInTx, readDeploymentDefinitionMachinesInTx,
    type DeploymentAuthentication, type DeploymentSourceAdmission, type DeploymentFailure } from './deploymentAdmission';
import { deploymentContentReference, readPlainDeploymentEnvironmentContentInTx, admitDeploymentStoredContentsInTx } from './deploymentStoredContent';
import { publishDeploymentChangesInTx } from './deploymentPublication';
import { syncEnvironmentSecretGrantsInTx, readEnvironmentMachineSecretGrantsInTx } from './environmentSecretGrantRepository';
import { readProjectSourceOwnerInTx, readProjectSourceCustodyInTx, createProjectSourceInTx,
    resolveProjectSourceAudienceInTx } from '@/app/projects/sources/projectSourceService';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { linkDeploymentTargetForAdmittedEnvironmentInTx } from './deploymentTargetLinkService';
import { admitDeploymentDeployerPrincipalsInTx, replaceDeploymentDeployerPrincipalsInTx, sameDeploymentDeployerPrincipals } from './deploymentEnvironmentDeployers';
import { admitPreviewEnvironmentRelationInTx } from './previewEnvironmentRelation';
import { readDeploymentDomainInventoryInTx } from './deploymentDomainService';

export type DeploymentEnvironmentRow = NonNullable<Awaited<ReturnType<Tx['deploymentEnvironment']['findUnique']>>>;
export type AdmittedDeploymentEnvironment = Extract<Awaited<ReturnType<typeof loadDeploymentEnvironmentInTx>>, { ok: true }>;

/** A refused first link must unwind the enclosing Environment transaction. */
export class DeploymentEnvironmentCreationError extends Error {
    constructor(readonly failure: DeploymentFailure) {
        super(failure.error);
        this.name = 'DeploymentEnvironmentCreationError';
    }
}

/** One Environment row serializes receipt admission across every supported database provider. */
export async function lockDeploymentEnvironmentInTx(tx: Tx, environmentId: string): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'postgres') await tx.$queryRawUnsafe('SELECT "id" FROM "DeploymentEnvironment" WHERE "id" = $1 FOR UPDATE', environmentId);
    if (provider === 'mysql') await tx.$queryRawUnsafe('SELECT `id` FROM `DeploymentEnvironment` WHERE `id` = ? FOR UPDATE', environmentId);
    // SQLite's existing serialized writer transaction owns its write exclusion.
}

export function projectDeploymentEnvironmentHeader(row: DeploymentEnvironmentRow & Readonly<{ deployers?: readonly Readonly<{ principalKind: string; principalId: string }>[] }>, serverId: string, admission: DeploymentSourceAdmission) {
    const canDeploy = canDeployDeploymentEnvironment(admission, row);
    return DeploymentEnvironmentHeaderV1Schema.parse({
        v: 1, id: row.id, serverId, projectSourceId: row.projectSourceId, revision: row.revision,
        owner: admission.owner, protection: row.protection,
        purpose: row.purpose, deployerMode: row.deployerMode,
        ...(row.previewTemplateEnvironmentId ? { previewTemplateEnvironmentId: row.previewTemplateEnvironmentId,
            previewRepositoryId: row.previewRepositoryId, previewPullRequestId: row.previewPullRequestId,
            previewTargetLinkId: row.previewTargetLinkId } : {}),
        ...(row.deployers ? { deployerPrincipals: row.deployers.map(({ principalKind, principalId }) => ({ principalKind, principalId })) } : {}),
        controllerMachineId: row.controllerMachineId,
        ...(row.buildMachineId ? { buildMachineId: row.buildMachineId } : {}),
        // Full mode lives in protected content; null edge custody never implies Tunnel.
        ...(row.edgeMachineId ? { ingress: { kind: 'edgeCaddy', edgeMachineId: row.edgeMachineId } } : {}),
        ...(row.runtimeTargetLinkId ? { runtimeTargetLinkId: row.runtimeTargetLinkId } : {}),
        ...deploymentContentReference(row),
        capabilities: { role: admission.canManage ? 'manager' : canDeploy ? 'deployer' : 'reader',
            read: true, deploy: canDeploy, manage: admission.canManage && !row.deletedAt,
            manageBindings: admission.canManage && !row.deletedAt, manageTargets: admission.canManage && !row.deletedAt,
            delete: admission.canManage && !row.deletedAt },
        createdByAccountId: row.createdByAccountId, createdAtMs: row.createdAt.getTime(), updatedAtMs: row.updatedAt.getTime(),
        ...(row.deletedAt ? { deletedAtMs: row.deletedAt.getTime() } : {}),
    });
}

/** Mutations and new reads resolve Source authority; accepted finite reads consume their scoped admission. */
export async function loadDeploymentEnvironmentInTx(tx: Tx, actorAccountId: string, serverId: string, environmentId: string,
    authentication: DeploymentAuthentication = {},
    acceptedRead?: Readonly<{ environmentId: string }>,
) {
    const row = await tx.deploymentEnvironment.findUnique({ where: { id: environmentId },
        include: { deployers: { select: { principalKind: true, principalId: true } } } });
    if (!row) return deploymentFailure('deployment_unavailable');
    if (acceptedRead?.environmentId === row.id) {
        const custody = await readProjectSourceCustodyInTx(tx, row.projectSourceId);
        if (!custody) return deploymentFailure('deployment_unavailable');
        return { ok: true as const, row, admission: { ...custody,
            canManage: false, canDeployMember: false, effectivePrincipals: [] } satisfies DeploymentSourceAdmission };
    }
    const source = await resolveDeploymentEnvironmentAdmissionInTx(tx, actorAccountId, { serverId, projectSourceId: row.projectSourceId }, authentication);
    if (!source.ok) return source;
    return { ok: true as const, row, admission: source.admission };
}

/** Captured receipt admission needs current Environment/Source custody, without re-admitting its work. */
export async function loadDeploymentEnvironmentCustodyInTx(tx: Tx, input: Readonly<{
    serverId: string; environmentId: string; includeRemoved?: boolean;
}>) {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return deploymentFailure('deployment_unavailable');
    const row = await tx.deploymentEnvironment.findUnique({ where: { id: input.environmentId } });
    if (!row || row.deletedAt && !input.includeRemoved) return deploymentFailure('deployment_unavailable');
    const custody = await readProjectSourceCustodyInTx(tx, row.projectSourceId);
    if (!custody) return deploymentFailure('deployment_unavailable');
    return { ok: true as const, row, ...custody };
}

/** New installation-proved reads and secret acquisitions still require the Source's Machine grant. */
export async function loadDeploymentEnvironmentForInstalledMachineInTx(tx: Tx, input: Readonly<{
    serverId: string; environmentId: string; machineId: string; installationId: string;
}>) {
    const loaded = await loadDeploymentEnvironmentCustodyInTx(tx, input);
    if (!loaded.ok) return loaded;
    const denied = await admitDeploymentMachineInTx(tx, loaded.owner, input.machineId,
        loaded.row.buildMachineId === input.machineId ? 'build' : 'target', input.installationId);
    return denied ?? loaded;
}

/** Current placement requirements, independent of retained ciphertext for accepted work. */
export async function readDeploymentEnvironmentRequiredSecretUsesInTx(tx: Tx,
    row: Pick<DeploymentEnvironmentRow, 'id' | 'runtimeTargetLinkId' | 'buildMachineId' | 'referencedSavedSecretRevisions'>,
): Promise<EnvironmentSecretRequiredUsesProjectionV1> {
    const captures = readDeploymentBindingSavedSecretRevisionsV1(row.referencedSavedSecretRevisions);
    if (!captures) return { status: 'incomplete', requiredSecretUses: [] };
    const link = row.runtimeTargetLinkId ? await tx.deploymentTargetLink.findFirst({
        where: { id: row.runtimeTargetLinkId, environmentId: row.id, deletedAt: null },
        include: { machines: { orderBy: { position: 'asc' } } },
    }) : null;
    const machineIds = [...new Set([...(link?.machines.map(member => member.machineId) ?? []),
        ...(row.buildMachineId ? [row.buildMachineId] : [])])];
    const installations = new Map<string, { machineId: string; installationId: string }>();
    for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1 })) {
        const machines = await tx.machine.findMany({ where: { id: { in: [...ids] }, revokedAt: null,
            replacedByMachineId: null, account: { status: 'active' } },
        select: { id: true, installationId: true, installationPublicKey: true } });
        for (const machine of machines) if (machine.installationId && machine.installationPublicKey) {
            installations.set(machine.id, { machineId: machine.id, installationId: machine.installationId });
        }
    }
    const runtimeInstallations = !row.runtimeTargetLinkId ? [] : link && link.machines.length > 0 && link.machines.every(member =>
        installations.get(member.machineId)?.installationId === member.installationId)
        ? link.machines.map(member => installations.get(member.machineId)!) : null;
    const registryIds = [...new Set(captures.flatMap(capture => capture.requiredBindings?.flatMap(binding =>
        binding.purpose === 'registry' ? [binding.targetLinkId] : []) ?? []))];
    const currentRegistryTargetLinkIds: string[] = [];
    for (const ids of portableQueryChunks({ values: registryIds, bindingsPerValue: 1 })) {
        const links = await tx.deploymentTargetLink.findMany({ where: { id: { in: [...ids] },
            environmentId: row.id, deletedAt: null }, select: { id: true } });
        currentRegistryTargetLinkIds.push(...links.map(current => current.id));
    }
    return projectEnvironmentSecretBindingRequiredUsesV1({ referencedSavedSecretRevisions: captures,
        runtimeInstallations, ...(row.buildMachineId ? { buildInstallation: installations.get(row.buildMachineId) ?? null } : {}),
        currentRegistryTargetLinkIds });
}

export function deploymentIntentDigest(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('base64url');
}

function environmentCreationRepeatKey(actorAccountId: string, requestKey: string): string {
    return `deployments.environments.create:${actorAccountId}:${requestKey}`;
}

/** The host commitment covers copied content; random Artifact materialization is not a new reviewed intent. */
function environmentCreationIntentDigest(input: DeploymentEnvironmentCreateStorageInputV1): string {
    if (!input.copyFrom) return deploymentIntentDigest(input);
    const { contentArtifactId: _contentArtifactId, contentHeaderVersion: _contentHeaderVersion,
        contentBodyVersion: _contentBodyVersion, firstTargetLink, ...intent } = input;
    if (!firstTargetLink) return deploymentIntentDigest(intent);
    const { contentArtifactId: _targetArtifactId, contentHeaderVersion: _targetHeaderVersion,
        contentBodyVersion: _targetBodyVersion, ...targetIntent } = firstTargetLink;
    return deploymentIntentDigest({ ...intent, firstTargetLink: targetIntent });
}

function parseEnvironmentCreationRepeatValue(value: string) {
    const [digest, environmentId] = value.split(':');
    if (!digest || !environmentId) return null;
    const suffix = value.slice(digest.length + environmentId.length + 2);
    if (!suffix) return { digest, environmentId };
    try { return { digest, environmentId, previewDataTargets: DeploymentPreviewDataTargetsV1Schema.parse(JSON.parse(suffix)) }; }
    catch { return null; }
}

/** Resolve the existing acknowledged create intent; current Environment admission remains the caller's responsibility. */
export async function readCreatedDeploymentEnvironmentIdInTx(tx: Tx, actorAccountId: string, requestKey: string): Promise<string | null> {
    const value = await fetchRepeatKey(tx, environmentCreationRepeatKey(actorAccountId, requestKey), await readTransactionDatabaseTime(tx));
    return value ? parseEnvironmentCreationRepeatValue(value)?.environmentId ?? null : null;
}

/** Create an independent private-content relationship after destination management and optional copy-source admission. */
export async function createDeploymentEnvironmentInTx(tx: Tx, actorAccountId: string, input: DeploymentEnvironmentCreateStorageInputV1,
    authentication: DeploymentAuthentication = {},
) {
    await lockPostgresRepeatKeyInTx(tx, environmentCreationRepeatKey(actorAccountId, input.requestKey));
    const digest = environmentCreationIntentDigest(input);
    const { newProject, projectSourceId, ...prepared } = input;
    if (!newProject) return projectSourceId ? createDeploymentEnvironmentForSourceInTx(tx, actorAccountId,
        { ...prepared, projectSourceId }, authentication, digest) : deploymentFailure('deployment_invalid');
    const created = await createProjectSourceInTx(tx, actorAccountId, { ...newProject, serverId: input.serverId }, authentication);
    if (!created.ok) return deploymentFailure(created.error === 'source_conflict' ? 'deployment_conflict' : 'deployment_access_denied');
    const result = await createDeploymentEnvironmentForSourceInTx(tx, actorAccountId,
        { ...prepared, projectSourceId: created.source.id }, authentication, digest);
    // The same transaction owns both records. A refused Environment must not leave an orphan Project.
    if (!result.ok) throw new DeploymentEnvironmentCreationError(result);
    return result;
}

async function createDeploymentEnvironmentForSourceInTx(tx: Tx, actorAccountId: string,
    input: Omit<DeploymentEnvironmentCreateStorageInputV1, 'projectSourceId' | 'newProject'> & { projectSourceId: string },
    authentication: DeploymentAuthentication, digest: string,
) {
    const source = await resolveDeploymentEnvironmentAdmissionInTx(tx, actorAccountId, { ...input, includeDeletedSource: false }, authentication);
    if (!source.ok) return source;
    if (!source.admission.canManage) return deploymentFailure('deployment_access_denied');
    if (!await admitDeploymentDeployerPrincipalsInTx(tx, source.admission, input.deployerPrincipals ?? [])) {
        return deploymentFailure('deployment_access_denied');
    }
    const now = await readTransactionDatabaseTime(tx);
    const repeatKey = environmentCreationRepeatKey(actorAccountId, input.requestKey);
    const repeated = await fetchRepeatKey(tx, repeatKey, now);
    if (input.copyFrom && !repeated) await lockDeploymentEnvironmentInTx(tx, input.copyFrom.environmentId);
    const copied = input.copyFrom
        ? await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.copyFrom.environmentId, authentication)
        : undefined;
    if (copied && !copied.ok) return copied;
    if (copied?.row.deletedAt) return deploymentFailure('deployment_unavailable');
    if (repeated) {
        const original = parseEnvironmentCreationRepeatValue(repeated);
        if (!original || original.digest !== digest) return deploymentFailure('deployment_conflict');
        const { environmentId } = original;
        const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, environmentId, authentication);
        return loaded.ok && !loaded.row.deletedAt ? { ok: true as const, environmentId,
            projectSourceId: loaded.row.projectSourceId, revision: loaded.row.revision,
            ...(loaded.row.runtimeTargetLinkId ? { runtimeTargetLinkId: loaded.row.runtimeTargetLinkId } : {}),
            ...(original.previewDataTargets ? { previewDataTargets: original.previewDataTargets } : {}) }
            : deploymentFailure('deployment_conflict');
    }
    // An acknowledged intent keeps its result after the source advances. New copies capture an exact, independently writable revision.
    if (input.copyFrom && copied?.ok && (copied.row.revision !== input.copyFrom.expectedRevision
        || copied.row.contentArtifactId === input.contentArtifactId)) return deploymentFailure('deployment_conflict');
    const preview = await admitPreviewEnvironmentRelationInTx(tx, actorAccountId, input, authentication);
    if (!preview.ok) return preview;
    const dataRequests = input.previewDataTargetLinks ?? [];
    const sourceDataById = new Map<string, NonNullable<Awaited<ReturnType<Tx['deploymentTargetLink']['findUnique']>>>>();
    for (const ids of portableQueryChunks({ values: dataRequests.map(item => item.templateDataTargetLinkId),
        bindingsPerValue: 1, fixedBindings: 1 })) {
        const links = await tx.deploymentTargetLink.findMany({ where: { id: { in: [...ids] },
            environmentId: input.preview!.templateEnvironmentId, role: 'data', sourceKind: 'plugin', deletedAt: null, detachedAt: null } });
        for (const link of links) sourceDataById.set(link.id, link);
    }
    for (const item of dataRequests) {
        const link = sourceDataById.get(item.templateDataTargetLinkId);
        if (!link || link.revision !== item.expectedTemplateTargetLinkRevision || link.contentArtifactId === item.contentArtifactId)
            return deploymentFailure('deployment_conflict');
    }
    const machineFailure = await admitDeploymentDefinitionMachinesInTx(tx, actorAccountId, source.admission.owner,
        [{ machineId: input.controllerMachineId, role: 'controller' },
            ...(input.buildMachineId ? [{ machineId: input.buildMachineId, role: 'build' as const }] : []),
            ...(input.firstTargetLink?.machines ?? []),
            ...[...sourceDataById.values()].flatMap(link => link.machineId
                ? [{ machineId: link.machineId, installationId: link.installationId ?? undefined }] : [])]);
    if (machineFailure) return machineFailure;
    const content = await readPlainDeploymentEnvironmentContentInTx(tx, actorAccountId, source.admission.owner, input);
    if (!content.ok) return content;
    // New Environments, including copies and previews, do not inherit another Environment's recovery ownership.
    if (content.content?.backup !== undefined) return deploymentFailure('deployment_conflict');
    if (content.content?.ingress !== undefined) return deploymentFailure('deployment_conflict');
    const linkContentFailures = await admitDeploymentStoredContentsInTx(tx, actorAccountId, source.admission.owner,
        [...(input.firstTargetLink ? [input.firstTargetLink] : []), ...dataRequests].map(reference => ({
            reference, expectedStoredKind: DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1 })));
    const linkContentFailure = linkContentFailures.find(item => item !== null);
    if (linkContentFailure) return linkContentFailure;
    const row = await tx.deploymentEnvironment.create({ data: {
        projectSourceId: input.projectSourceId, createdByAccountId: actorAccountId,
        protection: input.protection, purpose: input.purpose, deployerMode: input.deployerMode,
        ...preview.relation,
        deployers: { create: (input.deployerPrincipals ?? []).map(principal => ({ ...principal, createdByAccountId: actorAccountId })) },
        controllerMachineId: input.controllerMachineId, buildMachineId: input.buildMachineId,
        // Opened client preparation admits only an empty initial binding set.
        referencedSavedSecretRevisions: [],
        ...deploymentContentReference(input),
    }, include: { deployers: { select: { principalKind: true, principalId: true } } } });
    let revision = row.revision;
    let runtimeTargetLinkId: string | undefined;
    if (input.firstTargetLink) {
        const linked = await linkDeploymentTargetForAdmittedEnvironmentInTx(tx, actorAccountId, {
            ...input.firstTargetLink, serverId: input.serverId, environmentId: row.id,
            expectedRevision: row.revision, requestKey: input.requestKey, targetId: 'own-server', role: 'runtime',
        }, { ok: true, row, admission: source.admission }, { contentAdmitted: true });
        if (!linked.ok) throw new DeploymentEnvironmentCreationError(linked);
        revision = linked.revision;
        runtimeTargetLinkId = linked.targetLinkId;
    }
    const previewDataTargets: ReturnType<typeof DeploymentPreviewDataTargetsV1Schema.parse> = [];
    for (const item of dataRequests) {
        const sourceLink = sourceDataById.get(item.templateDataTargetLinkId)!;
        const linked = await linkDeploymentTargetForAdmittedEnvironmentInTx(tx, actorAccountId, {
            ...deploymentContentReference(item), serverId: input.serverId, environmentId: row.id, expectedRevision: revision,
            requestKey: `${input.requestKey}:${sourceLink.id}`, targetId: sourceLink.contributionLocalId!, role: 'data',
            source: { kind: 'plugin', contribution: { pluginId: sourceLink.pluginId!, localId: sourceLink.contributionLocalId! } },
            targetKind: sourceLink.targetKind, machines: [],
            ...(sourceLink.machineId ? { machineId: sourceLink.machineId, installationId: sourceLink.installationId! } : {}),
        }, { ok: true, row: { ...row, revision }, admission: source.admission }, { contentAdmitted: true });
        if (!linked.ok) throw new DeploymentEnvironmentCreationError(linked);
        revision = linked.revision;
        previewDataTargets.push({ templateDataTargetLinkId: sourceLink.id,
            targetLinkId: linked.targetLinkId, targetLinkRevision: linked.targetLinkRevision });
    }
    await saveRepeatKey(tx, repeatKey, `${digest}:${row.id}${previewDataTargets.length ? `:${JSON.stringify(previewDataTargets)}` : ''}`, defaultRepeatKeyExpiresAt(now));
    // The link owner has already published the final Environment revision.
    if (!input.firstTargetLink && !dataRequests.length) await publishDeploymentChangesInTx(tx, source.admission, row.id, revision);
    return { ok: true as const, environmentId: row.id, projectSourceId: row.projectSourceId, revision,
        ...(runtimeTargetLinkId ? { runtimeTargetLinkId } : {}),
        ...(previewDataTargets.length ? { previewDataTargets } : {}) };
}

/** Definition sub-revisions advance only for document/selectors; unrelated edits retain grants. */
export async function updateDeploymentEnvironmentInTx(tx: Tx, actorAccountId: string,
    input: DeploymentEnvironmentUpdateStorageInputV1, authentication: DeploymentAuthentication = {},
    contentWriter: 'environment' | 'template' | 'backup' = 'environment',
    admitted?: AdmittedDeploymentEnvironment,
    publicationAccountIds?: readonly string[],
    executionBinding?: ExternalActionExecutionAuthorizationBindingV1 | null,
) {
    if (!admitted) await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const loaded = admitted ?? await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if (loaded.row.deletedAt || !loaded.admission.canManage) return deploymentFailure('deployment_access_denied');
    if (loaded.row.revision !== input.expectedRevision) return deploymentFailure('deployment_conflict');
    if (contentWriter !== 'environment' && input.patch) return deploymentFailure('deployment_conflict');
    const currentDeployerMode = DeploymentEnvironmentHeaderV1Schema.shape.deployerMode.parse(loaded.row.deployerMode);
    const deployerMode = input.patch?.deployerMode ?? currentDeployerMode;
    const principalsChanged = input.patch?.deployerPrincipals !== undefined
        && !sameDeploymentDeployerPrincipals(loaded.row.deployers, input.patch.deployerPrincipals);
    if (input.patch?.deployerPrincipals !== undefined || (deployerMode === 'chosen' && deployerMode !== loaded.row.deployerMode)) {
        const principals = DeploymentEnvironmentDeployerPrincipalsV1Schema.safeParse(input.patch?.deployerPrincipals
            ?? loaded.row.deployers.map(({ principalKind, principalId }) => ({ principalKind, principalId })));
        if (!principals.success) return deploymentFailure('deployment_invalid');
        if (!await admitDeploymentDeployerPrincipalsInTx(tx, loaded.admission, principals.data)) {
            return deploymentFailure('deployment_access_denied');
        }
    }
    const buildMachineId = input.patch?.buildMachineId ?? loaded.row.buildMachineId;
    const ingress = input.patch?.ingress;
    const edgeMachineId = ingress === undefined ? loaded.row.edgeMachineId : ingress?.kind === 'edgeCaddy' ? ingress.edgeMachineId : null;
    const protection = input.patch?.protection ?? loaded.row.protection;
    if (loaded.row.edgeMachineId && edgeMachineId !== loaded.row.edgeMachineId) {
        const inventory = await readDeploymentDomainInventoryInTx(tx, actorAccountId, input, authentication, loaded);
        if (!inventory.ok) return inventory;
        if (inventory.capturedMachineIds === null || inventory.domains.length > 0
            && !inventory.capturedMachineIds.includes(loaded.row.edgeMachineId)) return deploymentFailure('deployment_conflict');
    }
    if (ingress !== undefined && ingress !== null) {
        const runtime = loaded.row.runtimeTargetLinkId ? await tx.deploymentTargetLink.findFirst({ where: {
            id: loaded.row.runtimeTargetLinkId, environmentId: loaded.row.id, deletedAt: null, detachedAt: null,
        }, select: { targetKind: true, machines: { select: { machineId: true } } } }) : null;
        if (runtime?.targetKind !== 'ownServer' || runtime.machines.length === 0
            || ingress.kind === 'edgeCaddy' && runtime.machines.length < 2) return deploymentFailure('deployment_invalid');
    }
    const placementAdmissions = [
        ...(input.patch?.buildMachineId !== undefined && buildMachineId !== loaded.row.buildMachineId
            ? [{ machineId: input.patch.buildMachineId, role: 'build' as const }] : []),
        ...(ingress?.kind === 'edgeCaddy' ? [{ machineId: ingress.edgeMachineId, role: 'target' as const }] : []),
    ];
    const content = await readPlainDeploymentEnvironmentContentInTx(tx, actorAccountId, loaded.admission.owner, input);
    if (!content.ok) return content;
    let definitionChanged = content.content === null
        && !isDeepStrictEqual(deploymentContentReference(loaded.row), deploymentContentReference(input));
    if (content.content) {
        const previous = await readPlainDeploymentEnvironmentContentInTx(tx, actorAccountId, loaded.admission.owner, loaded.row);
        if (!previous.ok) return previous;
        if (!isDeepStrictEqual(content.content.ingress, ingress === undefined ? previous.content?.ingress : ingress ?? undefined)) {
            return deploymentFailure('deployment_conflict');
        }
        if (!previous.content) return deploymentFailure('deployment_conflict');
        const candidate = content.content.definition;
        const incumbent = previous.content.definition;
        let reconciled = previous.content;
        if (contentWriter === 'environment' && candidate.kind === 'stored' && !isDeepStrictEqual(incumbent, candidate)) {
            try { reconciled = await reconcileDeploymentRemovedDataServicesV1(previous.content, candidate); }
            catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'invalid_request') {
                    return deploymentFailure('deployment_invalid');
                }
                throw error;
            }
        }
        let desiredBackup = reconciled.backup;
        if (contentWriter === 'environment' && input.patch?.backupRetention) {
            const prepared = prepareDeploymentBackupRetentionV1({ currentBackup: desiredBackup,
                ...input.patch.backupRetention });
            if (!prepared.ok) return deploymentFailure('deployment_conflict');
            desiredBackup = prepared.configuration;
        }
        definitionChanged = contentWriter === 'environment' && !isDeepStrictEqual(previous.content, content.content);
        const native = executionBinding?.deploymentNativeAdmission;
        // Authentication admitted this exact prepared private edit; opaque and plain content share that owner.
        const admittedPreparedContent = isDeploymentEnvironmentUpdateNativeAdmissionV1(native)
            && native.environmentId === input.environmentId && native.inputDigest === input.authoredInputDigest;
        const desiredOwnServer = applyOwnServerEnvironmentConfigurationPatchV1(reconciled.ownServer, input.patch?.ownServer ?? {});
        if (contentWriter === 'environment') {
            if ((!input.preparedBindings && !isDeepStrictEqual(previous.content.bindings, content.content.bindings))
                || !isDeepStrictEqual(previous.content.previewProvenance, content.content.previewProvenance)
                || !isDeepStrictEqual(reconciled.template, content.content.template)
                || (!admittedPreparedContent && !isDeepStrictEqual(desiredOwnServer, content.content.ownServer))
                || (!admittedPreparedContent && !isDeepStrictEqual(previous.content.previewTemplate, content.content.previewTemplate))
                || ((!admittedPreparedContent || input.patch?.backupRetention !== undefined)
                    && !isDeepStrictEqual(desiredBackup, content.content.backup))) return deploymentFailure('deployment_conflict');
        } else if (contentWriter === 'backup') {
            if (!isDeepStrictEqual({ ...previous.content, backup: undefined }, { ...content.content, backup: undefined })) {
                return deploymentFailure('deployment_conflict');
            }
        } else {
            // This writer owns only provenance. Definition and credential custody stay with their existing owners.
            if (!isDeepStrictEqual({ ...previous.content, template: undefined }, { ...content.content, template: undefined })) {
                return deploymentFailure('deployment_conflict');
            }
            const provenance = content.content.template;
            const definition = content.content.definition;
            if (!provenance || definition.kind !== 'stored' || provenance.definition.contentRevision !== definition.contentRevision
                || provenance.definition.composeDigest !== definition.composeDigest) return deploymentFailure('deployment_conflict');
        }
        if (candidate.kind === 'stored') {
            if (candidate.contentRevision !== resolveDeploymentStoredDefinitionRevisionV1(incumbent, candidate)) {
                return deploymentFailure('deployment_conflict');
            }
        }
    }
    const buildChanged = buildMachineId !== loaded.row.buildMachineId;
    const edgeChanged = edgeMachineId !== loaded.row.edgeMachineId;
    // Prepared content and placement continue in the binding writer, which admits the combined mutation once.
    if (!input.preparedBindings && (definitionChanged || buildChanged || edgeChanged)) {
        const denied = await admitDeploymentDefinitionMachinesInTx(tx, actorAccountId, loaded.admission.owner, [
            ...await readDeploymentDefinitionMachinesInTx(tx, loaded.row),
            ...placementAdmissions,
        ]);
        if (denied) return denied;
    }
    if (!principalsChanged && deployerMode === loaded.row.deployerMode
        && buildMachineId === loaded.row.buildMachineId && edgeMachineId === loaded.row.edgeMachineId && protection === loaded.row.protection
        && !input.preparedBindings && isDeepStrictEqual(deploymentContentReference(loaded.row), deploymentContentReference(input))) {
        return { ok: true as const, environmentId: loaded.row.id, revision: loaded.row.revision };
    }
    if (buildChanged && !buildMachineId) return deploymentFailure('deployment_invalid');
    if (input.preparedBindings) {
        return setDeploymentEnvironmentBindingsForAdmittedEnvironmentInTx(tx, actorAccountId, {
            serverId: input.serverId, environmentId: input.environmentId, expectedRevision: input.expectedRevision,
            ...deploymentContentReference(input), ...input.preparedBindings,
        }, loaded, authentication, { buildMachineId, deployerMode,
            ...(ingress !== undefined ? { edgeMachineId } : {}),
            ...(input.patch?.deployerPrincipals !== undefined ? { deployerPrincipals: input.patch.deployerPrincipals } : {}),
            ...(input.patch?.protection !== undefined ? { protection: input.patch.protection } : {}) });
    }
    if (buildChanged) {
        // Only the canonical plain reader can prove there is no binding custody.
        // Zero grant rows cannot establish that for opaque or unprepared content.
        if (content.content === null || content.content.bindings.length !== 0) return deploymentFailure('client_required');
    }
    const changed = await tx.deploymentEnvironment.updateMany({ where: { id: loaded.row.id, revision: input.expectedRevision },
        data: { ...deploymentContentReference(input),
            ...(input.patch?.buildMachineId !== undefined ? { buildMachineId: input.patch.buildMachineId } : {}),
            ...(ingress !== undefined ? { edgeMachineId } : {}),
            ...(input.patch?.protection !== undefined ? { protection: input.patch.protection } : {}),
            deployerMode,
            revision: { increment: 1 } } });
    if (changed.count !== 1) throw new Error('Locked deployment Environment changed during content CAS');
    if (principalsChanged && input.patch?.deployerPrincipals !== undefined) {
        await replaceDeploymentDeployerPrincipalsInTx(tx, loaded.row.id, actorAccountId, loaded.row.deployers, input.patch.deployerPrincipals);
    }
    await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, loaded.row.revision + 1, undefined, false, publicationAccountIds);
    return { ok: true as const, environmentId: loaded.row.id, revision: loaded.row.revision + 1 };
}

/** Instantiation's metadata-only admission shares the canonical Environment lock, revision CAS and publication. */
export async function setDeploymentEnvironmentTemplateInTx(tx: Tx, actorAccountId: string,
    input: DeploymentEnvironmentTemplateSetInputV1, authentication: DeploymentAuthentication = {},
) {
    return updateDeploymentEnvironmentInTx(tx, actorAccountId, input, authentication, 'template');
}

/** Backup configuration owns only its content leaf, sharing the Environment admission, lock and revision CAS. */
export async function setDeploymentEnvironmentBackupInTx(tx: Tx, actorAccountId: string,
    input: DeploymentEnvironmentBackupSetInputV1, authentication: DeploymentAuthentication = {},
) {
    return updateDeploymentEnvironmentInTx(tx, actorAccountId, input, authentication, 'backup');
}

/** Complete captures, prepared Artifact and installation grants commit with one Environment CAS. */
export async function setDeploymentEnvironmentBindingsInTx(tx: Tx, actorAccountId: string,
    input: DeploymentBindingsSetStorageInputV1, authentication: DeploymentAuthentication = {},
) {
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if (loaded.row.deletedAt || !loaded.admission.canManage) return deploymentFailure('deployment_access_denied');
    if (loaded.row.revision !== input.expectedRevision) return deploymentFailure('deployment_conflict');
    return setDeploymentEnvironmentBindingsForAdmittedEnvironmentInTx(tx, actorAccountId, input, loaded, authentication);
}

/** Combined definition/binding edits continue the same locked Environment admission. */
async function setDeploymentEnvironmentBindingsForAdmittedEnvironmentInTx(tx: Tx, actorAccountId: string,
    input: DeploymentBindingsSetStorageInputV1, loaded: AdmittedDeploymentEnvironment, authentication: DeploymentAuthentication,
    placement?: Readonly<{ buildMachineId: string | null; protection?: DeploymentEnvironmentCreateStorageInputV1['protection'];
        edgeMachineId?: string | null;
        deployerMode?: DeploymentEnvironmentCreateStorageInputV1['deployerMode'];
        deployerPrincipals?: readonly DeploymentEnvironmentDeployerPrincipalV1[] }>,
) {
    const resourceIds = [...new Set([
        ...input.referencedSavedSecretRevisions,
        ...(readDeploymentBindingSavedSecretRevisionsV1(loaded.row.referencedSavedSecretRevisions) ?? []),
    ].map(capture => capture.resourceId))];
    if (resourceIds.length > 0) {
        await acquireSavedSecretReferencePublicationAccountsInTx(tx, { accountId: actorAccountId, resourceIds,
            publicationAccountIds: await resolveProjectSourceAudienceInTx(tx, [loaded.admission.source]) });
    }
    const link = loaded.row.runtimeTargetLinkId ? await tx.deploymentTargetLink.findFirst({
        where: { id: loaded.row.runtimeTargetLinkId, environmentId: loaded.row.id, deletedAt: null },
        include: { machines: { orderBy: { position: 'asc' } } },
    }) : null;
    const buildMachineId = placement?.buildMachineId ?? loaded.row.buildMachineId;
    const preparedContent = await readPlainDeploymentEnvironmentContentInTx(tx, actorAccountId, loaded.admission.owner, input);
    if (!preparedContent.ok) return preparedContent;
    const previous = isDeepStrictEqual(deploymentContentReference(loaded.row), deploymentContentReference(input)) ? preparedContent
        : await readPlainDeploymentEnvironmentContentInTx(tx, actorAccountId, loaded.admission.owner, loaded.row);
    if (!previous.ok) return previous;
    if (preparedContent.content && (!previous.content || (!placement
        && !isDeploymentEnvironmentBindingsOnlyUpdateV1(previous.content, preparedContent.content)))) {
        return deploymentFailure('deployment_conflict');
    }
    const existingGrants = await readEnvironmentMachineSecretGrantsInTx(tx, { environmentId: loaded.row.id });
    const retainedGrants = preparedContent.content && previous.content
        ? readRetainedOperationalEnvironmentBindingGrantsV1({ previousBindings: previous.content.bindings,
            bindings: preparedContent.content.bindings, existingGrants })
        // Opaque binding semantics belong to the admitted content owner. Existing exact seals add no delivery authority.
        : existingGrants.filter(existing => input.grants.some(grant => isDeepStrictEqual(existing, grant)));
    if (retainedGrants === null) return deploymentFailure('deployment_conflict');
    const retainedSubjects = new Map(retainedGrants.map(grant => [machineSecretGrantSubjectKey(grant), grant]));
    // References survive authoring before placement; grants cover only current installations.
    const secretRevisions = new Map(input.referencedSavedSecretRevisions.map(ref => [ref.resourceId, ref.revision]));
    const subjects = new Set<string>();
    const recipients = new Map<string, { machineId: string; installationId: string; role: 'target' | 'build' }>();
    for (const grant of input.grants) {
        if (grant.kind === 'connectorToken' || grant.environmentId !== input.environmentId) return deploymentFailure('deployment_conflict');
        const key = machineSecretGrantSubjectKey(grant);
        if (subjects.has(key)) return deploymentFailure('deployment_conflict');
        subjects.add(key);
        const retained = retainedSubjects.get(key);
        if (retained && !isDeepStrictEqual(retained, grant)) return deploymentFailure('deployment_conflict');
        const runtime = link?.machines.some(member => member.machineId === grant.machineId && member.installationId === grant.installationId);
        const build = buildMachineId === grant.machineId;
        if (!retained && (grant.kind === 'environmentValues' ? grant.binding.phase === 'runtime' ? !runtime : !build : !runtime && !build)) {
            return deploymentFailure('deployment_conflict');
        }
        if (runtime || build) recipients.set(JSON.stringify([grant.machineId, grant.installationId]), {
            machineId: grant.machineId, installationId: grant.installationId, role: runtime ? 'target' : 'build',
        });
        if (grant.kind === 'secret') {
            const existing = secretRevisions.get(grant.resourceId);
            if (existing !== undefined && existing !== grant.resourceRevision) return deploymentFailure('deployment_conflict');
            secretRevisions.set(grant.resourceId, grant.resourceRevision);
        }
    }
    if (secretRevisions.size !== input.referencedSavedSecretRevisions.length
        || input.referencedSavedSecretRevisions.some(ref => secretRevisions.get(ref.resourceId) !== ref.revision)) {
        return deploymentFailure('deployment_conflict');
    }
    let definitionChanged = preparedContent.content === null
        && !isDeepStrictEqual(deploymentContentReference(loaded.row), deploymentContentReference(input));
    let referencedSavedSecretRevisions = normalizeDeploymentBindingSavedSecretRevisionsV1(input.referencedSavedSecretRevisions);
    if (preparedContent.content) {
        definitionChanged = !isDeepStrictEqual(previous.content, preparedContent.content);
        const contentReferences = new Map<string, number>();
        const requiredSubjects = new Set(retainedSubjects.keys());
        const registryTargetIds = new Set<string>();
        const buildRecipient = buildMachineId
            ? [...recipients.values()].find(recipient => recipient.machineId === buildMachineId) : undefined;
        for (const binding of preparedContent.content.bindings) {
            let resourceId: string | undefined;
            if (binding.source.kind === 'secret') {
                const ref = parseSavedSecretRefV1(binding.source.ref);
                if (ref.kind !== 'shared_resource') return deploymentFailure('deployment_conflict');
                resourceId = ref.resourceId;
                const previous = contentReferences.get(resourceId);
                if (previous !== undefined && previous !== binding.source.resourceRevision) return deploymentFailure('deployment_conflict');
                contentReferences.set(resourceId, binding.source.resourceRevision);
            }
            if (!isEnvironmentSecretBindingManagedByBindingsWriterV1(binding)) continue;
            if (binding.purpose === 'registry') registryTargetIds.add(binding.targetLinkId);
            const needsBuild = binding.purpose === 'registry' ? buildMachineId !== null : binding.phase === 'build';
            if (needsBuild && !buildRecipient) return deploymentFailure('deployment_conflict');
            const destinations = binding.purpose === 'variable'
                ? binding.phase === 'runtime' ? link?.machines ?? [] : buildRecipient ? [buildRecipient] : []
                : [...link?.machines ?? [], ...(buildRecipient ? [buildRecipient] : [])];
            for (const destination of destinations) {
                const common = { v: 1 as const, environmentId: loaded.row.id,
                    machineId: destination.machineId, installationId: destination.installationId };
                if (binding.source.kind === 'secret' && resourceId) {
                    requiredSubjects.add(machineSecretGrantSubjectKey({ ...common, kind: 'secret', resourceId,
                        resourceRevision: binding.source.resourceRevision }));
                } else if (binding.purpose === 'variable') {
                    requiredSubjects.add(machineSecretGrantSubjectKey({ ...common, kind: 'environmentValues',
                        binding: { purpose: 'variable', phase: binding.phase, name: binding.name } }));
                }
            }
        }
        if (contentReferences.size !== secretRevisions.size
            || [...contentReferences].some(([id, revision]) => secretRevisions.get(id) !== revision)) {
            return deploymentFailure('deployment_conflict');
        }
        if ([...requiredSubjects].some(subject => !subjects.has(subject))
            || input.grants.some(grant => !requiredSubjects.has(machineSecretGrantSubjectKey(grant)))) {
            return deploymentFailure('deployment_conflict');
        }
        // The selected runtime relation was already read; resolve only additional exact registry links.
        const currentRegistryTargets = new Set(link ? [link.id] : []);
        for (const ids of portableQueryChunks({ values: [...registryTargetIds].filter(id => !currentRegistryTargets.has(id)), bindingsPerValue: 1 })) {
            const rows = await tx.deploymentTargetLink.findMany({ where: { id: { in: [...ids] },
                environmentId: loaded.row.id, deletedAt: null }, select: { id: true } });
            rows.forEach(row => currentRegistryTargets.add(row.id));
        }
        if ([...registryTargetIds].some(id => !currentRegistryTargets.has(id))) return deploymentFailure('deployment_conflict');
        const canonicalCaptures = captureDeploymentBindingSavedSecretRevisionsV1(preparedContent.content.bindings);
        if (!matchesDeploymentBindingSavedSecretCapturesV1(canonicalCaptures, referencedSavedSecretRevisions)) {
            return deploymentFailure('deployment_conflict');
        }
        referencedSavedSecretRevisions = canonicalCaptures;
    }
    const buildChanged = buildMachineId !== loaded.row.buildMachineId;
    const edgeChanged = placement?.edgeMachineId !== undefined && placement.edgeMachineId !== loaded.row.edgeMachineId;
    const contentOrPlacementChanged = definitionChanged || buildChanged || edgeChanged;
    const admitMutation = async () => admitDeploymentDefinitionMachinesInTx(tx, actorAccountId, loaded.admission.owner, [
            ...await readDeploymentDefinitionMachinesInTx(tx, loaded.row),
            ...recipients.values(),
            ...(buildChanged ? [buildMachineId].flatMap(machineId => machineId
                ? [{ machineId, role: 'build' as const }] : []) : []),
            ...(edgeChanged ? [placement?.edgeMachineId].flatMap(machineId => machineId
                ? [{ machineId, role: 'target' as const }] : []) : []),
        ]);
    if (contentOrPlacementChanged) {
        const denied = await admitMutation();
        if (denied) return denied;
    }
    const references = input.referencedSavedSecretRevisions.map(ref => formatSharedSavedSecretRefV1(ref.resourceId));
    const savedSecretRevisions = input.referencedSavedSecretRevisions.map(ref => ({ resourceId: ref.resourceId, expectedRevision: ref.revision }));
    const principal = loaded.admission.owner;
    const actorResources = savedSecretRevisions.length === 0 ? [] : await readSavedSecretResourcesForAccountInTx(tx, actorAccountId,
        authentication.authenticationAuthority ? { ...authentication, authenticationAuthority: authentication.authenticationAuthority } : undefined,
        savedSecretRevisions.map(ref => ref.resourceId));
    if (!validateSavedSecretResourceReferenceCapturesV1(actorResources, { references, savedSecretRevisions })) {
        return deploymentFailure('deployment_conflict');
    }
    // Selecting one's own resource records workload consent in this link, not
    // in a separate grant exposing the resource to the entire Source audience.
    const ownedReferences = new Set(actorResources.flatMap(resource => 'ref' in resource && resource.relationship === 'owner'
        ? [resource.ref] : []));
    const foreignRevisions = savedSecretRevisions.filter(ref => !ownedReferences.has(formatSharedSavedSecretRefV1(ref.resourceId)));
    if (foreignRevisions.length > 0 && (principal.kind !== 'account' || principal.accountId !== actorAccountId)
        && !validateSavedSecretResourceReferenceCapturesV1(await readSavedSecretResourcesForPrincipalInTx(tx, principal,
            foreignRevisions.map(ref => ref.resourceId)), {
            references: foreignRevisions.map(ref => formatSharedSavedSecretRefV1(ref.resourceId)), savedSecretRevisions: foreignRevisions,
        })) {
        return deploymentFailure('deployment_conflict');
    }
    const previousCaptures = loaded.row.referencedSavedSecretRevisions;
    // Enriching capture metadata does not change the immutable content or the
    // resource revisions held by an already admitted builder.
    const retainAcceptedBuildCustody = isDeepStrictEqual(deploymentContentReference(loaded.row), deploymentContentReference(input))
        && Array.isArray(previousCaptures) && previousCaptures.length === referencedSavedSecretRevisions.length
        && previousCaptures.every((capture, index) => capture !== null && typeof capture === 'object' && !Array.isArray(capture)
            && capture.resourceId === referencedSavedSecretRevisions[index]!.resourceId
            && capture.revision === referencedSavedSecretRevisions[index]!.revision);
    const grantsChanged = await syncEnvironmentSecretGrantsInTx(tx, { environmentId: loaded.row.id, grants: input.grants,
        ...(!contentOrPlacementChanged ? { admitMutation } : {}),
        ...(retainAcceptedBuildCustody ? { retainAcceptedBuildCustody: true } : {}) });
    if (grantsChanged === null) return deploymentFailure('deployment_conflict');
    if (typeof grantsChanged === 'object') return grantsChanged;
    if (!contentOrPlacementChanged && !grantsChanged) {
        const machineFailure = await admitDeploymentMachinesInTx(tx, principal, [...recipients.values()]);
        if (machineFailure) return machineFailure;
    }
    const principalsChanged = placement?.deployerPrincipals !== undefined
        && !sameDeploymentDeployerPrincipals(loaded.row.deployers, placement.deployerPrincipals);
    if (!grantsChanged && !principalsChanged && (placement?.deployerMode ?? loaded.row.deployerMode) === loaded.row.deployerMode
        && (placement?.protection ?? loaded.row.protection) === loaded.row.protection
        && buildMachineId === loaded.row.buildMachineId
        && (placement?.edgeMachineId === undefined || placement.edgeMachineId === loaded.row.edgeMachineId)
        && isDeepStrictEqual(deploymentContentReference(loaded.row), deploymentContentReference(input))
        && isDeepStrictEqual(loaded.row.referencedSavedSecretRevisions, referencedSavedSecretRevisions)) {
        return { ok: true as const, environmentId: loaded.row.id, revision: loaded.row.revision };
    }
    const changed = await tx.deploymentEnvironment.updateMany({ where: { id: loaded.row.id, revision: input.expectedRevision },
        data: { ...deploymentContentReference(input), ...(placement ? { buildMachineId,
            ...(placement.edgeMachineId !== undefined ? { edgeMachineId: placement.edgeMachineId } : {}),
            ...(placement.protection !== undefined ? { protection: placement.protection } : {}),
            ...(placement.deployerMode !== undefined ? { deployerMode: placement.deployerMode } : {}) } : {}),
            referencedSavedSecretRevisions, revision: { increment: 1 } } });
    if (changed.count !== 1) throw new Error('Locked deployment Environment changed during binding CAS');
    if (principalsChanged && placement?.deployerPrincipals !== undefined) {
        await replaceDeploymentDeployerPrincipalsInTx(tx, loaded.row.id, actorAccountId, loaded.row.deployers, placement.deployerPrincipals);
    }
    if (!isDeepStrictEqual(previousCaptures, referencedSavedSecretRevisions)) {
        await publishSavedSecretUsageChangesInTx(tx, [
            ...(readDeploymentBindingSavedSecretRevisionsV1(previousCaptures) ?? []).map(capture => capture.resourceId),
            ...referencedSavedSecretRevisions.map(capture => capture.resourceId),
        ]);
    }
    await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, loaded.row.revision + 1);
    return { ok: true as const, environmentId: loaded.row.id, revision: loaded.row.revision + 1 };
}
