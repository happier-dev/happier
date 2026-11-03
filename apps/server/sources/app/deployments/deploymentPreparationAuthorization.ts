import { deploymentPreparationOperationForActionV1, type ExternalActionExecutionAuthorizationBindingV1,
    type DeploymentPreparationAdmissionV1, type ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import type { Tx } from '@/storage/inTx';
import { readProjectSourceOwnerInTx, readProjectSourceCustodyInTx, resolveProjectSourceAccessInTx, canManageProjectSourceOwnerInTx } from '@/app/projects/sources/projectSourceService';
import { loadDeploymentEnvironmentInTx, readCreatedDeploymentEnvironmentIdInTx } from './deploymentEnvironmentService';
import { admitDeploymentMachineInTx, canDeployDeploymentEnvironment, type DeploymentAuthentication } from './deploymentAdmission';
import { DeploymentDomainAddAdmissionInputV1Schema, DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateStorageInputV1Schema, DeploymentEnvironmentUpdateInputV1Schema, DeploymentTargetLinkInputV1Schema,
    DeploymentDeployAdmissionInputV1Schema, DeploymentEnvironmentGetInputV1Schema, DeploymentReceiptGetInputV1Schema, DeploymentReceiptListInputV1Schema,
    ArtifactJsonCreateHttpInputV1Schema, ArtifactJsonUpdateHttpInputV1Schema, DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol';
import { deploymentOperationForRootActionV1 } from '@happier-dev/protocol';
import { createDeploymentCandidatePublicationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentEnvironmentTemplateSetInputV1Schema, DeploymentBindingsSetStorageInputV1Schema,
    EnvironmentSecretLaunchAdmissionInputV1Schema } from '@happier-dev/deployment-protocol';
import { ProjectAccountRowReadRequestV1Schema, PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readProjectDeploymentDefaultsInTx } from '@/app/projects/projectDeploymentDefaultsService';
import { listArtifactAccessGrantsInTx, readArtifactAccessGrantsForAdmittedCustodyInTx } from '@/app/artifacts/artifactAccessService';
import { ArtifactAccessGrantSetInputV1Schema, ArtifactRecipientKeyEnvelopeCommitInputV1Schema,
    type ArtifactAccessGrantSetInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';

type TemplateAdmission = Extract<DeploymentPreparationAdmissionV1, { operation: 'template' }>;

type SetupDeployment = Extract<DeploymentPreparationAdmissionV1, { operation: 'setup' }>['deployments'][number];

type CreateAdmission = Extract<DeploymentPreparationAdmissionV1, { operation: 'create' }>;

/** Candidate mutation is native preparation, including the explicitly requested template deploy. */

export function isDeploymentCandidatePublicationEffect(binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string): boolean {
    return binding.deploymentCandidatePublication !== undefined && effectActionId === binding.actionId
        || (binding.actionId === 'deployments.templates.instantiate' || binding.actionId === 'deployments.environments.create')
            && deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission) === 'deploy'
            && (effectActionId === 'deployments.deploy'
                || binding.actionId === 'deployments.environments.create' && effectActionId === binding.actionId);
}

/** Native preparation spends only canonical candidate identities for this signed root. */

async function readDeploymentCandidatePublicationHttpPurposeInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
    authentication: DeploymentAuthentication,
) {
    if (!isDeploymentCandidatePublicationEffect(binding, effectActionId)) return null;
    const minted = binding.deploymentCandidatePublication;
    const allocatedCreate = binding.actionId === 'deployments.environments.create';
    const allocated = allocatedCreate ? await readAdmittedCreateDeploymentEnvironmentCustodyInTx(tx, binding) : null;
    const environmentId = minted?.environmentId ?? allocated?.row.id ?? await readTemplateDeploymentEnvironmentIdInTx(tx, binding);
    if (!environmentId) return null;
    const current = allocatedCreate ? null
        : await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId, environmentId, authentication);
    if (current && (!current.ok || !canDeployDeploymentEnvironment(current.admission, current.row))) return null;
    const loaded = allocatedCreate ? allocated ? { ok: true as const, row: allocated.row,
        admission: { owner: allocated.owner, source: allocated.source } } : { ok: false as const }
        : current?.ok ? current : { ok: false as const };
    const preparation = binding.deploymentPreparationAdmission;
    const selectedSource = preparation && 'source' in preparation ? preparation.source : undefined;
    if (!loaded.ok
        || loaded.row.deletedAt || loaded.row.controllerMachineId !== binding.machineId
        || minted && (loaded.row.projectSourceId !== minted.source.id || loaded.admission.source.revision !== minted.source.revision)
        || !minted && (preparation?.operation !== 'template' && !allocatedCreate
            || selectedSource !== undefined && loaded.row.projectSourceId !== selectedSource.id)) return null;
    const scope = minted ?? createDeploymentCandidatePublicationV1({ ...binding, environmentId,
        source: { id: loaded.admission.source.id, revision: loaded.admission.source.revision } });
    const admit = async (allowed: boolean, artifactId: string) => {
        if (!allowed) return null;
        const publicationGrants: Pick<ArtifactAccessGrantSetInputV1, 'principal' | 'accessLevel'>[] = [];
        publicationGrants.push({ principal: loaded.admission.owner, accessLevel: 'admin' });
        if (artifactId === scope.contentArtifactId) {
            const audience = allocatedCreate ? { ok: true as const,
                value: { grants: await readArtifactAccessGrantsForAdmittedCustodyInTx(tx, loaded.row.contentArtifactId) } }
                : await listArtifactAccessGrantsInTx(tx, { actorAccountId: binding.accountId, artifactId: loaded.row.contentArtifactId });
            if (!audience.ok) return null;
            for (const grant of audience.value.grants) {
                if (!sameStrictJsonValue(grant.principal, loaded.admission.owner)) {
                    publicationGrants.push({ principal: grant.principal, accessLevel: 'view' });
                }
            }
        }
        return { ...loaded.admission, publicationGrants };
    };
    // Receipt admission consumes preparation authority. Native transitions keep
    // their existing, separate accepted-execution writer after this point.
    if (await tx.deployment.findFirst({ where: { contentArtifactId: scope.contentArtifactId }, select: { id: true } })) return null;
    const matches = (expected: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, expected);
    const method = proof.method.toUpperCase();
    const kindFor = (id: string) => id === scope.contentArtifactId ? DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1
        : id === scope.environmentContentArtifactId ? DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 : undefined;
    if (method === 'POST' && proof.path === '/v1/artifacts') {
        const parsed = ArtifactJsonCreateHttpInputV1Schema.safeParse(proof.body);
        if (!parsed.success) return null;
        const kind = kindFor(parsed.data.id);
        return admit(kind !== undefined && (parsed.data.kind === undefined || parsed.data.kind === kind)
            && parsed.data.approvalState === undefined && parsed.data.approvalSessionId === undefined && matches(parsed.data), parsed.data.id);
    }
    const path = /^\/v1\/artifacts\/([^/?#]+)(?:\/access\/(grants|recipients|key-envelopes))?$/u.exec(proof.path);
    if (!path) return null;
    let id: string;
    try { id = decodeURIComponent(path[1]); } catch { return null; }
    const kind = kindFor(id);
    if (!kind || encodeURIComponent(id) !== path[1]) return null;
    if (id === scope.environmentContentArtifactId && await tx.deploymentEnvironment.findFirst({
        where: { contentArtifactId: id }, select: { id: true },
    })) return null;
    if (method === 'POST' && path[2] === undefined) {
        const parsed = ArtifactJsonUpdateHttpInputV1Schema.safeParse(proof.body);
        return admit(parsed.success && (parsed.data.kind === undefined || parsed.data.kind === kind)
            && parsed.data.approvalState === undefined && parsed.data.approvalSessionId === undefined
            && matches({ id, ...parsed.data }), id);
    }
    const admitted = await admit(true, id);
    if (!admitted) return null;
    if (method === 'GET' && proof.body === undefined
        && (path[2] === 'recipients' || path[2] === 'grants' || allocatedCreate && path[2] === undefined)) return matches({ id }) ? admitted : null;
    if (method === 'PUT' && path[2] === 'grants') {
        const parsed = ArtifactAccessGrantSetInputV1Schema.safeParse(proof.body);
        return parsed.success && parsed.data.artifactId === id
            && admitted.publicationGrants.some(grant => parsed.data.accessLevel === grant.accessLevel
                && sameStrictJsonValue(parsed.data.principal, grant.principal))
            && matches({ id, ...parsed.data }) ? admitted : null;
    }
    if (method === 'POST' && path[2] === 'key-envelopes') {
        const parsed = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.safeParse(proof.body);
        return parsed.success && parsed.data.artifactId === id && matches({ id, ...parsed.data }) ? admitted : null;
    }
    return null;
}

/** Preparation and receipt admission take the same Environment lock before the Artifact parent. */

async function readCreateSource(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    admission: CreateAdmission, authentication: DeploymentAuthentication) {
    if (binding.actionId !== 'deployments.environments.create') return null;
    const source = admission.source ? await resolveProjectSourceAccessInTx(tx, binding.accountId, admission.source.id, authentication) : null;
    const owner = admission.newProject?.owner ?? (source?.ok ? source.owner : null);
    if (!owner || (admission.newProject ? !await canManageProjectSourceOwnerInTx(tx, binding.accountId, owner, authentication)
        : !source?.ok || !source.canManageOwner)) return null;
    if (admission.copyFrom) {
        const copied = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId,
            admission.copyFrom.environmentId, authentication);
        if (!copied.ok || copied.row.deletedAt || copied.row.revision !== admission.copyFrom.expectedRevision) return null;
    }
    if (admission.preview) {
        const template = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId,
            admission.preview.templateEnvironmentId, authentication);
        if (!template.ok || !template.admission.canManage || template.row.deletedAt || template.row.purpose !== 'standard'
            || template.row.projectSourceId !== admission.source?.id
            || template.row.revision !== admission.preview.expectedTemplateRevision
            || template.row.runtimeTargetLinkId !== admission.preview.runtimeTargetLinkId) return null;
    }
    return { owner };
}


export interface DeploymentCreateHttpPurpose {
    readonly rootActionId: 'deployments.environments.create';
    readonly effectActionId: string;
    readonly child?: Readonly<{ environmentId: string }>;
    readonly source?: ProjectSourceV1;
}


export function isDeploymentCreateHttpEffect(binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string): boolean {
    return binding.actionId === 'deployments.environments.create' && binding.deploymentPreparationAdmission?.operation === 'create'
        && (effectActionId === binding.actionId || effectActionId === 'projects.sources.read'
            || effectActionId === 'deployments.environments.get' || effectActionId === 'deployments.bindings.set'
            || binding.deploymentPreparationAdmission.catalogApp !== undefined && binding.deploymentPreparationAdmission.mode === 'apply'
                && (effectActionId === 'deployments.domains.add' || effectActionId === 'deployments.deploy'
                    || effectActionId === 'deployments.receipts.get' || effectActionId === 'deployments.receipts.list'));
}

/** Spend admitted create authority on exact operands; permissions and source CAS were decided at issuance. */

export async function readDeploymentCreateHttpPurposeInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown; reviewedChild?: ReviewedActionChildHttpProofV1 }>,
    isReadOnlyArtifactPurpose?: (proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>) => boolean,
    isNativeHttpPurpose?: (proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>) => boolean,
): Promise<DeploymentCreateHttpPurpose | null> {
    const admission = binding.deploymentPreparationAdmission;
    if (!admission || admission.operation !== 'create' || !isDeploymentCreateHttpEffect(binding, effectActionId)) return null;
    const domainEffect = effectActionId === 'deployments.domains.add';
    const deployEffect = effectActionId === 'deployments.deploy';
    const receiptRead = effectActionId === 'deployments.receipts.get' || effectActionId === 'deployments.receipts.list';
    const childEffect = effectActionId === 'deployments.bindings.set' || domainEffect || deployEffect;
    if (domainEffect && proof.reviewedChild?.actionId !== effectActionId) return null;
    const environmentId = childEffect || receiptRead || effectActionId === 'deployments.environments.get' || proof.path.startsWith('/v1/artifacts/')
        ? await readCreatedDeploymentEnvironmentIdInTx(tx, binding.accountId, admission.requestKey) : null;
    if (childEffect && (admission.mode !== 'apply' || !admission.copyFrom && !admission.catalogApp || !environmentId)) return null;
    const admit = (allowed: boolean): DeploymentCreateHttpPurpose | null => allowed
        ? { rootActionId: 'deployments.environments.create', effectActionId,
            ...(childEffect && environmentId ? { child: { environmentId } } : {}) } : null;
    const method = proof.method.toUpperCase();
    const matches = (expected: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, expected);
    if (effectActionId === 'projects.sources.read' && admission.newProject && method === 'GET' && proof.body === undefined) {
        const allocated = await readAdmittedCreateDeploymentEnvironmentCustodyInTx(tx, binding);
        return allocated && proof.path === `/v1/projects/sources/${encodeURIComponent(allocated.source.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            && matches({ serverId: binding.serverIdentityId, id: allocated.source.id })
            ? { rootActionId: 'deployments.environments.create', effectActionId, source: allocated.source } : null;
    }
    const reviewedDeploy = proof.reviewedChild?.actionId === effectActionId && proof.reviewedChild.role === 'template.deploy';
    if (deployEffect && proof.reviewedChild && !reviewedDeploy) return null;
    if (receiptRead) {
        if (!environmentId || !isNativeHttpPurpose?.(proof)) return null;
        if (effectActionId === 'deployments.receipts.list') {
            const read = DeploymentReceiptListInputV1Schema.safeParse(proof.routeInput);
            return admit(read.success && read.data.serverId === binding.serverIdentityId && read.data.environmentId === environmentId);
        }
        const read = DeploymentReceiptGetInputV1Schema.safeParse(proof.routeInput);
        return admit(read.success && read.data.serverId === binding.serverIdentityId
            && (read.data.environmentId !== undefined ? read.data.environmentId === environmentId
                : await tx.deployment.findFirst({ where: { id: read.data.deploymentId, environmentId }, select: { id: true } }) !== null));
    }
    if (deployEffect && (proof.path === '/v1/artifacts' || proof.path.startsWith('/v1/artifacts/'))
        && await readDeploymentCandidatePublicationHttpPurposeInTx(tx, binding, effectActionId, proof, {})) {
        return reviewedDeploy ? admit(true) : { rootActionId: 'deployments.environments.create', effectActionId };
    }
    if (deployEffect && !proof.path.startsWith('/v1/artifacts/')) {
        const parsed = DeploymentDeployAdmissionInputV1Schema.safeParse(proof.body);
        if (parsed.success) {
            const { actionOperationId: _operation, ...reviewedInput } = parsed.data;
            return admit(proof.path === `/v1/deployments/environments/${encodeURIComponent(environmentId!)}/deployments`
                && method === 'POST' && parsed.data.serverId === binding.serverIdentityId
                && parsed.data.environmentId === environmentId && parsed.data.requestKey === binding.requestId
                && matches(parsed.data) && proof.reviewedChild?.actionId === effectActionId
                && proof.reviewedChild.role === 'template.deploy'
                && computeActionInputApprovalDigestV1(effectActionId, reviewedInput) === proof.reviewedChild.inputDigest);
        }
        // Read-only native preparation precedes the candidate's reviewed digest.
        // Transitions are admitted separately against the accepted receipt.
        return isNativeHttpPurpose?.(proof)
            && (method === 'GET' || proof.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
                || proof.path === '/v1/auth/api-tokens/encryption-access')
            ? reviewedDeploy ? admit(true) : { rootActionId: 'deployments.environments.create', effectActionId } : null;
    }
    if (domainEffect && isReadOnlyArtifactPurpose?.(proof)) return admit(true);
    if (effectActionId === 'projects.sources.read') {
        if (method !== 'GET' || proof.body !== undefined) return null;
        if (admission.source && proof.path === `/v1/projects/sources/${encodeURIComponent(admission.source.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            && matches({ serverId: binding.serverIdentityId, id: admission.source.id })) return admit(true);
        if (!admission.copyFrom) return null;
        const copied = await tx.deploymentEnvironment.findUnique({ where: { id: admission.copyFrom.environmentId },
            select: { projectSourceId: true } });
        return admit(copied !== null && proof.path === `/v1/projects/sources/${encodeURIComponent(copied.projectSourceId)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            && matches({ serverId: binding.serverIdentityId, id: copied.projectSourceId }));
    }
    if (method === 'GET' && proof.body === undefined) {
        const selected = [environmentId, ...(!childEffect ? [admission.copyFrom?.environmentId, admission.preview?.templateEnvironmentId] : [])]
            .find(id => id !== undefined && id !== null && proof.path
                === `/v1/deployments/environments/${encodeURIComponent(id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
                && matches({ serverId: binding.serverIdentityId, environmentId: id }));
        if (selected) return admit(true);
    }
    if (effectActionId === 'deployments.environments.get') return null;
    if (method === 'GET' && proof.body === undefined) {
        if ((proof.path === '/v1/account/encryption' || proof.path === '/v1/account/encryption/currentness') && matches({})) return admit(true);
        if (!childEffect && admission.source && (proof.path === `/v1/projects/sources/${encodeURIComponent(admission.source.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            || proof.path === `/v1/projects/${encodeURIComponent(admission.source.id)}/deployment-defaults?serverId=${encodeURIComponent(binding.serverIdentityId)}`)
            && matches({ serverId: binding.serverIdentityId, id: admission.source.id })) return admit(true);
    }
    if (childEffect && method === 'POST') {
        const base = `/v1/deployments/environments/${encodeURIComponent(environmentId!)}`;
        if (domainEffect) {
            const parsed = DeploymentDomainAddAdmissionInputV1Schema.safeParse(proof.body);
            if (!parsed.success || proof.path !== `${base}/domains` || parsed.data.environmentId !== environmentId
                || parsed.data.serverId !== binding.serverIdentityId || parsed.data.requestId !== binding.requestId
                || !matches(parsed.data)) return null;
            // Template selection has no native placements. The ordinary Domain
            // owner derives them; reviewed Artifact refs and revisions remain exact.
            const { actionOperationId: _operation, requestId: _request, placements: _placements, ...reviewedInput } = parsed.data;
            return admit(computeActionInputApprovalDigestV1('deployments.domains.add', reviewedInput)
                === proof.reviewedChild?.inputDigest);
        }
        if (proof.path === `${base}/bindings`) {
            const parsed = DeploymentBindingsSetStorageInputV1Schema.safeParse(proof.body);
            return admit(parsed.success && parsed.data.environmentId === environmentId
                && parsed.data.serverId === binding.serverIdentityId && matches(parsed.data));
        }
        if (proof.path === `${base}/secret-launch-admission`) {
            const parsed = EnvironmentSecretLaunchAdmissionInputV1Schema.safeParse(proof.body);
            return admit(parsed.success && parsed.data.environmentId === environmentId && parsed.data.serverId === binding.serverIdentityId
                && parsed.data.materialization.kind === 'bindings' && matches(parsed.data));
        }
    }
    if (method === 'POST' && proof.path === '/v1/artifacts') {
        const parsed = ArtifactJsonCreateHttpInputV1Schema.safeParse(proof.body);
        if (await readDeploymentCandidatePublicationHttpPurposeInTx(tx, binding, effectActionId, proof, {})) return admit(true);
        return admit(parsed.success && (parsed.data.kind === undefined || parsed.data.kind === DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1
            || !childEffect && parsed.data.kind === DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1) && parsed.data.approvalState === undefined
            && parsed.data.approvalSessionId === undefined && matches(parsed.data));
    }
    if (method === 'POST' && proof.path === '/v1/deployments/environments') {
        const parsed = DeploymentEnvironmentCreateStorageInputV1Schema.safeParse(proof.body);
        return admit(!childEffect && admission.mode === 'apply' && parsed.success && parsed.data.serverId === binding.serverIdentityId
            && parsed.data.projectSourceId === admission.source?.id && sameStrictJsonValue(parsed.data.newProject, admission.newProject)
            && parsed.data.requestKey === admission.requestKey
            && parsed.data.protection === admission.protection && parsed.data.purpose === admission.purpose
            && parsed.data.deployerMode === admission.deployerMode
            && sameStrictJsonValue(parsed.data.copyFrom, admission.copyFrom)
            && sameStrictJsonValue(parsed.data.preview, admission.preview)
            && (admission.candidate === undefined || Object.entries(admission.candidate)
                .every(([key, value]) => parsed.data[key as keyof typeof parsed.data] === value))
            && sameStrictJsonValue(parsed.data.deployerPrincipals ?? [], admission.deployerPrincipals ?? []) && matches(parsed.data));
    }
    const match = /^\/v1\/artifacts\/([^/?#]+)(?:\/access\/(grants|recipients|key-envelopes))?$/u.exec(proof.path);
    if (!match) return null;
    let artifactId: string;
    try { artifactId = decodeURIComponent(match[1]); } catch { return null; }
    if (!artifactId || encodeURIComponent(artifactId) !== match[1]) return null;
    if (method === 'GET' && proof.body === undefined && (match[2] === undefined || match[2] === 'recipients' || match[2] === 'grants')
        && matches({ id: artifactId })) {
        if (!childEffect && (artifactId === admission.candidate?.contentArtifactId
            || admission.preview && await tx.deploymentEnvironment.findFirst({ where: {
                id: admission.preview.templateEnvironmentId, contentArtifactId: artifactId,
            }, select: { id: true } }))) return admit(true);
        const selectedEnvironmentIds = [environmentId, ...(!childEffect ? [admission.copyFrom?.environmentId] : [])]
            .filter((id): id is string => id !== undefined && id !== null);
        if (selectedEnvironmentIds.length && await tx.deploymentEnvironment.findFirst({ where: { id: { in: selectedEnvironmentIds },
            OR: [{ contentArtifactId: artifactId }, ...(!childEffect || deployEffect
                ? [{ targetLinks: { some: { contentArtifactId: artifactId } } }] : []),
                ...(deployEffect ? [{ deployments: { some: { contentArtifactId: artifactId } } }] : [])] },
            select: { id: true } })) return admit(true);
        if (!childEffect && admission.source && match[2] === undefined && await tx.projectDeploymentDefaults.findFirst({
            where: { projectSourceId: admission.source.id, contentArtifactId: artifactId }, select: { projectSourceId: true },
        })) return admit(true);
    }
    if (domainEffect) return null;
    if (await readDeploymentCandidatePublicationHttpPurposeInTx(tx, binding, effectActionId, proof, {})) return admit(true);
    if (deployEffect) return null;
    // The same authenticated Artifact owner still decides grant eligibility,
    // current access, recipient census and key-envelope fencing at its routes.
    // Stored kind is optional on existing canonical writers; no hint is not a
    // new authority fact. A positively different kind is never a create operand.
    if (childEffect && await tx.deploymentEnvironment.findFirst({ where: {
        id: { not: environmentId! }, contentArtifactId: artifactId,
    }, select: { id: true } })) return null;
    const owner = admission.newProject?.owner ?? (admission.source ? await readProjectSourceOwnerInTx(tx, admission.source.id) : null);
    if (owner?.kind !== 'team') return null;
    const artifact = await tx.artifact.findUnique({ where: { id: artifactId }, select: { kind: true, accountId: true } });
    if (!artifact || artifact.accountId !== binding.accountId
        || artifact.kind !== null && artifact.kind !== DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1
        && artifact.kind !== DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1) return null;
    if (method === 'GET' && proof.body === undefined && (match[2] === undefined || match[2] === 'recipients')) return admit(matches({ id: artifactId }));
    if (method === 'PUT' && match[2] === 'grants') {
        const parsed = ArtifactAccessGrantSetInputV1Schema.safeParse(proof.body);
        return admit(parsed.success && parsed.data.artifactId === artifactId && parsed.data.accessLevel === 'admin'
            && sameStrictJsonValue(parsed.data.principal, owner) && matches({ id: artifactId, ...parsed.data }));
    }
    if (method === 'POST' && match[2] === 'key-envelopes') {
        const parsed = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.safeParse(proof.body);
        return admit(parsed.success && parsed.data.artifactId === artifactId && matches({ id: artifactId, ...parsed.data }));
    }
    return null;
}

/** The optional finite setup carrier admits this one metadata effect, not a managed family. */

async function readSetupDeploymentEnvironment(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    selected: SetupDeployment, authentication: DeploymentAuthentication) {
    if (deploymentPreparationOperationForActionV1(binding.actionId) !== 'setup') return null;
    const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId, selected.environment.id, authentication);
    if (!loaded.ok || loaded.row.deletedAt || !loaded.admission.canManage || loaded.row.revision !== selected.environment.revision
        || loaded.row.runtimeTargetLinkId !== selected.target.id) return null;
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: selected.target.id, environmentId: loaded.row.id,
        deletedAt: null, detachedAt: null }, include: { machines: { where: { machineId: selected.machineId } } } });
    const member = link?.machines[0];
    if (!link || link.revision !== selected.target.revision || link.sourceKind !== 'host' || link.role !== 'runtime'
        || link.targetKind !== 'ownServer' || !member || await admitDeploymentMachineInTx(tx, loaded.admission.owner,
            member.machineId, 'target', member.installationId)) return null;
    return loaded.row;
}

async function readTemplateEnvironmentId(tx: Tx, binding: Pick<ExternalActionExecutionAuthorizationBindingV1, 'accountId'>, admission: TemplateAdmission) {
    return admission.environment.kind === 'existing' ? admission.environment.environmentId
        : readCreatedDeploymentEnvironmentIdInTx(tx, binding.accountId, admission.environment.requestKey);
}

/** Reuse the template's existing/create request relation; never infer it from native operands. */

export async function readTemplateDeploymentEnvironmentIdInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1): Promise<string | null> {
    const admission = binding.deploymentPreparationAdmission;
    if (deploymentOperationForRootActionV1(binding.actionId, admission) !== 'deploy') return null;
    return admission?.operation === 'template' ? readTemplateEnvironmentId(tx, binding, admission)
        : admission?.operation === 'create' ? readCreatedDeploymentEnvironmentIdInTx(tx, binding.accountId, admission.requestKey) : null;
}

/** The admitted create's allocation is custody, not another requester permission decision. */

export async function readAdmittedCreateDeploymentEnvironmentCustodyInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1) {
    if (binding.actionId !== 'deployments.environments.create') return null;
    const environmentId = await readTemplateDeploymentEnvironmentIdInTx(tx, binding);
    if (!environmentId) return null;
    const row = await tx.deploymentEnvironment.findUnique({ where: { id: environmentId } });
    const custody = row ? await readProjectSourceCustodyInTx(tx, row.projectSourceId) : null;
    return row && custody ? { row, ...custody } : null;
}


export async function isTemplateInstantiationAuthorizedInTx(tx: Tx,
    binding: Pick<ExternalActionExecutionAuthorizationBindingV1, 'accountId' | 'actionId' | 'machineId' | 'installationId' | 'serverIdentityId'>,
    admission: TemplateAdmission, authentication: DeploymentAuthentication): Promise<boolean> {
    if (binding.actionId !== 'deployments.templates.instantiate' || admission.machineId !== binding.machineId
        || admission.target.installationId !== binding.installationId) return false;
    const source = admission.source ? await resolveProjectSourceAccessInTx(tx, binding.accountId, admission.source.id, authentication) : null;
    const owner = admission.newProject?.owner ?? (source?.ok ? source.owner : null);
    if (!owner || (admission.newProject ? !await canManageProjectSourceOwnerInTx(tx, binding.accountId, owner, authentication)
        : !source?.ok || !source.canManageOwner) || await admitDeploymentMachineInTx(tx, owner,
        admission.machineId, 'target', admission.target.installationId)) return false;
    const environmentId = await readTemplateEnvironmentId(tx, binding, admission);
    if (!environmentId) return admission.environment.kind === 'create' && admission.target.kind === 'new';
    const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId, environmentId, authentication);
    if (!loaded.ok || loaded.row.deletedAt || !loaded.admission.canManage
        || admission.source && loaded.row.projectSourceId !== admission.source.id) return false;
    if (admission.target.kind !== 'existing') return true;
    if (loaded.row.runtimeTargetLinkId !== admission.target.targetLinkId) return false;
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: admission.target.targetLinkId, environmentId,
        deletedAt: null, detachedAt: null }, include: { machines: { orderBy: { position: 'asc' } } } });
    return Boolean(link && link.sourceKind === 'host' && link.role === 'runtime' && link.targetKind === 'ownServer'
        && link.machines.some(member => member.machineId === binding.machineId && member.installationId === binding.installationId));
}

/** References spend only current Source authority; domain routes retain content and row admission. */

export async function isDeploymentPreparationAuthorizedInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    admission: DeploymentPreparationAdmissionV1, authentication: DeploymentAuthentication = {},
): Promise<boolean> {
    if (admission.operation === 'create') return await readCreateSource(tx, binding, admission, authentication) !== null;
    if (admission.operation === 'setup') {
        for (const selected of admission.deployments) {
            if (!await readSetupDeploymentEnvironment(tx, binding, selected, authentication)) return false;
        }
        return true;
    }
    if (admission.operation === 'template') return isTemplateInstantiationAuthorizedInTx(tx, binding, admission, authentication);
    if (admission.operation === 'catalog') {
        if (binding.actionId !== 'deployments.publish.prepare' || admission.machineId !== binding.machineId
            || admission.installationId !== binding.installationId) return false;
        if (admission.newProject) return await canManageProjectSourceOwnerInTx(tx, binding.accountId, admission.newProject.owner, authentication)
            && !await admitDeploymentMachineInTx(tx, admission.newProject.owner, admission.machineId, 'target', admission.installationId);
        if (!admission.source) return false;
        const source = await resolveProjectSourceAccessInTx(tx, binding.accountId, admission.source.id, authentication);
        return source.ok && source.canManageOwner && source.source.revision === admission.source.revision
            && !await admitDeploymentMachineInTx(tx, source.owner, admission.machineId, 'target', admission.installationId);
    }
    if (binding.actionId !== `deployments.${admission.operation}`) return false;
    if (admission.source) {
        const source = await resolveProjectSourceAccessInTx(tx, binding.accountId, admission.source.id, authentication);
        if (!source.ok || source.source.revision !== admission.source.revision) return false;
    }
    if (admission.environment) {
        const loaded = await loadDeploymentEnvironmentInTx(tx, binding.accountId, binding.serverIdentityId,
            admission.environment.id, authentication);
        if (!loaded.ok || loaded.row.deletedAt || !admission.source || loaded.row.projectSourceId !== admission.source.id
            || admission.operation === 'publish' && loaded.row.revision !== admission.environment.revision) return false;
    }
    return true;
}

/** Preparation reads stay scoped; template apply admits only its named canonical child writes. */

export async function isDeploymentPreparationHttpPurposeInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown; reviewedChild?: ReviewedActionChildHttpProofV1 }>,
    authentication: DeploymentAuthentication,
    isReadOnlyArtifactPurpose?: (proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>) => boolean,
    isNativeHttpPurpose?: (proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
        readActionId?: 'deployments.environments.get' | 'deployments.receipts.get' | 'deployments.receipts.list') => boolean,
    /** A Setup target that signed the read; it spends only the app operands paired with it. */
    setupReceiverMachineId?: string,
): Promise<boolean> {
    const admission = binding.deploymentPreparationAdmission;
    if (setupReceiverMachineId !== undefined && admission?.operation !== 'setup') return false;
    if (!admission) return false;
    if (admission.operation === 'create') return await readDeploymentCreateHttpPurposeInTx(tx, binding, effectActionId, proof,
        isReadOnlyArtifactPurpose, isNativeHttpPurpose) !== null;
    const routeMatches = (expected: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, expected);
    const method = proof.method.toUpperCase();
    if (admission.operation === 'setup') {
        if (deploymentPreparationOperationForActionV1(binding.actionId) !== 'setup' || method !== 'GET' || proof.body !== undefined) return false;
        const receiver = setupReceiverMachineId !== undefined;
        if (effectActionId === binding.actionId && proof.path === '/v1/account/encryption/currentness' && routeMatches({})) return true;
        const catalogSources = (admission.catalogSources ?? []).filter(selected => !receiver || selected.machineId === setupReceiverMachineId);
        const deployments = admission.deployments.filter(selected => !receiver || selected.machineId === setupReceiverMachineId);
        if (effectActionId === 'projects.sources.read') return catalogSources.some(selected => proof.path
            === `/v1/projects/sources/${encodeURIComponent(selected.source.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            && routeMatches({ serverId: binding.serverIdentityId, id: selected.source.id }));
        if (effectActionId === binding.actionId || effectActionId === 'deployments.templates.instantiate') {
            if (catalogSources.some(selected => proof.path
                === `/v1/projects/${encodeURIComponent(selected.source.id)}/deployment-defaults?serverId=${encodeURIComponent(binding.serverIdentityId)}`
                && routeMatches({ serverId: binding.serverIdentityId, id: selected.source.id }))) return true;
        }
        if (effectActionId === 'deployments.environments.get') {
            const selected = deployments.find(selected => proof.path
                === `/v1/deployments/environments/${encodeURIComponent(selected.environment.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
                && routeMatches({ serverId: binding.serverIdentityId, environmentId: selected.environment.id }));
            return selected !== undefined && await readSetupDeploymentEnvironment(tx, binding, selected, authentication) !== null;
        }
        if (effectActionId !== binding.actionId || isReadOnlyArtifactPurpose && !isReadOnlyArtifactPurpose(proof)) return false;
        const match = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
        if (!match) return false;
        let artifactId: string;
        try { artifactId = decodeURIComponent(match[1]); } catch { return false; }
        if (encodeURIComponent(artifactId) !== match[1] || !routeMatches({ id: artifactId })) return false;
        for (const sourceId of new Set(catalogSources.map(selected => selected.source.id))) {
            const defaults = await readProjectDeploymentDefaultsInTx(tx, binding.accountId,
                { serverId: binding.serverIdentityId, projectSourceId: sourceId }, authentication);
            if (defaults.ok && defaults.content?.contentArtifactId === artifactId) return true;
        }
        let selected = deployments.find(selected => selected.candidate.contentArtifactId === artifactId);
        if (!selected) {
            // Resolve only owners of this exact Artifact, never an Environment
            // inventory or caller-supplied content relationship.
            const owners = await tx.deploymentEnvironment.findMany({ where: {
                id: { in: deployments.map(selected => selected.environment.id) }, contentArtifactId: artifactId,
            }, select: { id: true } });
            selected = deployments.find(selected => owners.some(owner => owner.id === selected.environment.id));
        }
        if (!selected) return false;
        const environment = await readSetupDeploymentEnvironment(tx, binding, selected, authentication);
        if (!environment) return false;
        const expected = selected.candidate.contentArtifactId === artifactId ? selected.candidate : environment;
        if (expected.contentArtifactId !== artifactId) return false;
        const artifact = await tx.artifact.findUnique({ where: { id: artifactId }, select: { headerVersion: true, bodyVersion: true } });
        return artifact?.headerVersion === expected.contentHeaderVersion && artifact.bodyVersion === expected.contentBodyVersion;
    }
    if (binding.actionId === 'deployments.templates.instantiate' && (effectActionId === 'deployments.deploy'
        || effectActionId === 'deployments.receipts.get' || effectActionId === 'deployments.receipts.list')) {
        if (admission.operation !== 'template' || deploymentOperationForRootActionV1(binding.actionId, admission) !== 'deploy') return false;
        const environmentId = await readTemplateDeploymentEnvironmentIdInTx(tx, binding);
        if (!environmentId) return false;
        // The reviewed deploy child retains its effect while using ordinary
        // preparation read transports. Bind those through the transport owner.
        const readActionId = method === 'GET' && proof.body === undefined
            ? (['deployments.environments.get', 'deployments.receipts.list', 'deployments.receipts.get'] as const)
                .find(actionId => (effectActionId === 'deployments.deploy' || effectActionId === actionId)
                    && isNativeHttpPurpose?.(proof, actionId)) : undefined;
        if (readActionId === 'deployments.environments.get') {
            const read = DeploymentEnvironmentGetInputV1Schema.safeParse(proof.routeInput);
            return read.success && read.data.serverId === binding.serverIdentityId && read.data.environmentId === environmentId;
        }
        if (readActionId === 'deployments.receipts.list') {
            const read = DeploymentReceiptListInputV1Schema.safeParse(proof.routeInput);
            return read.success && read.data.serverId === binding.serverIdentityId && read.data.environmentId === environmentId;
        }
        if (readActionId === 'deployments.receipts.get') {
            const read = DeploymentReceiptGetInputV1Schema.safeParse(proof.routeInput);
            if (!read.success || read.data.serverId !== binding.serverIdentityId) return false;
            // The public by-id read may omit its Environment; bind that form
            // to the same resolved template relation, not an Account inventory.
            return read.data.environmentId !== undefined ? read.data.environmentId === environmentId
                : await tx.deployment.findFirst({ where: { id: read.data.deploymentId, environmentId }, select: { id: true } }) !== null;
        }
        if (!isNativeHttpPurpose?.(proof)) return false;
        const native = DeploymentDeployAdmissionInputV1Schema.safeParse(proof.body);
        if (!native.success) return true;
        const { actionOperationId: _operation, ...reviewedInput } = native.data;
        return native.data.environmentId === environmentId
            && native.data.requestKey === admission.deploy?.requestKey
            && (admission.target.kind !== 'existing' || native.data.targetLinkId === admission.target.targetLinkId)
            && (!proof.reviewedChild
                || computeActionInputApprovalDigestV1(effectActionId, reviewedInput) === proof.reviewedChild.inputDigest);
    }
    // Publish already crossed admission at the signed-root mint. Its finite
    // review spends that proof, not another current Source permission decision.
    if (admission.operation !== 'publish'
        && !await isDeploymentPreparationAuthorizedInTx(tx, binding, admission, authentication)) return false;
    if (admission.operation === 'catalog') {
        if (method !== 'GET' || proof.body !== undefined) return false;
        if (!admission.source) return effectActionId === binding.actionId
            && (proof.path === '/v1/account/encryption' || proof.path === '/v1/account/encryption/currentness') && routeMatches({});
        if (effectActionId === 'projects.sources.read') return proof.path
            === `/v1/projects/sources/${encodeURIComponent(admission.source.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            && routeMatches({ serverId: binding.serverIdentityId, id: admission.source.id });
        if (effectActionId !== binding.actionId) return false;
        if ((proof.path === '/v1/account/encryption' || proof.path === '/v1/account/encryption/currentness') && routeMatches({})) return true;
        if (proof.path === `/v1/projects/${encodeURIComponent(admission.source.id)}/deployment-defaults?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            && routeMatches({ serverId: binding.serverIdentityId, id: admission.source.id })) return true;
        if (!/^\/v1\/artifacts\/[^/?#]+$/u.test(proof.path)) return false;
        const defaults = await readProjectDeploymentDefaultsInTx(tx, binding.accountId,
            { serverId: binding.serverIdentityId, projectSourceId: admission.source.id }, authentication);
        return defaults.ok && defaults.content !== null
            && proof.path === `/v1/artifacts/${encodeURIComponent(defaults.content.contentArtifactId)}`
            && routeMatches({ id: defaults.content.contentArtifactId })
            && (!isReadOnlyArtifactPurpose || isReadOnlyArtifactPurpose(proof));
    }
    if (admission.operation === 'template') {
        const environmentId = await readTemplateEnvironmentId(tx, binding, admission);
        if (effectActionId === 'projects.sources.read') return method === 'GET' && proof.body === undefined
            && admission.source !== undefined && proof.path === `/v1/projects/sources/${encodeURIComponent(admission.source.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            && routeMatches({ serverId: binding.serverIdentityId, id: admission.source.id });
        if (effectActionId === 'deployments.environments.get') return environmentId !== null && method === 'GET' && proof.body === undefined
            && proof.path === `/v1/deployments/environments/${encodeURIComponent(environmentId)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            && routeMatches({ serverId: binding.serverIdentityId, environmentId });
        const child = ['deployments.environments.create', 'deployments.environments.update', 'deployments.targets.link', 'deployments.bindings.set'].includes(effectActionId);
        if (effectActionId !== binding.actionId && !child) return false;
        if (method === 'GET' && proof.body === undefined) {
            if (effectActionId === binding.actionId && admission.source
                && proof.path === `/v1/projects/${encodeURIComponent(admission.source.id)}/deployment-defaults?serverId=${encodeURIComponent(binding.serverIdentityId)}`
                && routeMatches({ serverId: binding.serverIdentityId, id: admission.source.id })) return true;
            if (proof.path === '/v1/account/encryption' && routeMatches({})) return true;
            return isReadOnlyArtifactPurpose?.(proof) === true;
        }
        if (admission.mode !== 'apply') return false;
        if (effectActionId === binding.actionId && method === 'POST' && proof.path === '/v1/artifacts') {
            const parsed = ArtifactJsonCreateHttpInputV1Schema.safeParse(proof.body);
            return parsed.success && (parsed.data.kind === undefined || parsed.data.kind === DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1
                || parsed.data.kind === DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1) && parsed.data.approvalState === undefined
                && parsed.data.approvalSessionId === undefined && routeMatches(parsed.data);
        }
        if (effectActionId === 'deployments.environments.create') {
            const parsed = DeploymentEnvironmentCreateInputV1Schema.safeParse(proof.body);
            const selected = admission.environment;
            return selected.kind === 'create' && admission.target.kind === 'new' && method === 'POST'
                && proof.path === '/v1/deployments/environments' && parsed.success && parsed.data.serverId === binding.serverIdentityId
                && parsed.data.projectSourceId === admission.source?.id && sameStrictJsonValue(parsed.data.newProject, admission.newProject)
                && parsed.data.requestKey === selected.requestKey
                && parsed.data.protection === selected.protection && parsed.data.purpose === selected.purpose
                && parsed.data.deployerMode === selected.deployerMode
                && sameStrictJsonValue(parsed.data.deployerPrincipals ?? [], selected.deployerPrincipals ?? [])
                && parsed.data.controllerMachineId === selected.controllerMachineId
                && parsed.data.buildMachineId === (selected.buildMachineId ?? binding.machineId) && parsed.data.firstTargetLink !== undefined
                && sameStrictJsonValue(parsed.data.firstTargetLink.machines, [{ machineId: binding.machineId, installationId: binding.installationId }])
                && routeMatches(parsed.data);
        }
        if (!environmentId) return false;
        const path = `/v1/deployments/environments/${encodeURIComponent(environmentId)}`;
        if (effectActionId === 'deployments.environments.update') {
            const parsed = DeploymentEnvironmentUpdateInputV1Schema.safeParse(proof.body);
            return admission.environment.kind === 'existing' && method === 'PATCH' && proof.path === path && parsed.success
                && parsed.data.patch === undefined && parsed.data.environmentId === environmentId && parsed.data.serverId === binding.serverIdentityId
                && parsed.data.expectedRevision === admission.environment.expectedRevision && routeMatches(parsed.data);
        }
        if (effectActionId === 'deployments.targets.link') {
            const parsed = DeploymentTargetLinkInputV1Schema.safeParse(proof.body);
            return admission.target.kind === 'new' && method === 'POST' && proof.path === `${path}/targets` && parsed.success
                && parsed.data.serverId === binding.serverIdentityId && parsed.data.environmentId === environmentId
                && parsed.data.requestKey === binding.requestId && parsed.data.targetId === 'own-server' && parsed.data.source === undefined
                && parsed.data.role === 'runtime' && parsed.data.replacesLinkId === undefined
                && sameStrictJsonValue(parsed.data.machines, [{ machineId: binding.machineId, installationId: binding.installationId }]) && routeMatches(parsed.data);
        }
        if (effectActionId === 'deployments.bindings.set') {
            if (method !== 'POST') return false;
            const launch = EnvironmentSecretLaunchAdmissionInputV1Schema.safeParse(proof.body);
            if (proof.path === `${path}/secret-launch-admission`) return launch.success && launch.data.serverId === binding.serverIdentityId
                && launch.data.environmentId === environmentId && launch.data.machineId === binding.machineId
                && launch.data.installationId === binding.installationId && launch.data.materialization.kind === 'bindings' && routeMatches(launch.data);
            const parsed = DeploymentBindingsSetStorageInputV1Schema.safeParse(proof.body);
            return proof.path === `${path}/bindings` && parsed.success && parsed.data.environmentId === environmentId
                && parsed.data.serverId === binding.serverIdentityId && routeMatches(parsed.data);
        }
        const parsed = DeploymentEnvironmentTemplateSetInputV1Schema.safeParse(proof.body);
        return effectActionId === binding.actionId && method === 'POST' && proof.path === `${path}/template` && parsed.success
            && parsed.data.environmentId === environmentId && parsed.data.serverId === binding.serverIdentityId && routeMatches(parsed.data);
    }
    if (effectActionId === 'projects.sources.read') {
        return admission.source !== undefined && method === 'GET' && proof.body === undefined
            && proof.path === `/v1/projects/sources/${encodeURIComponent(admission.source.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            && routeMatches({ serverId: binding.serverIdentityId, id: admission.source.id });
    }
    if (effectActionId === 'deployments.environments.get') {
        return admission.environment !== undefined && method === 'GET' && proof.body === undefined
            && proof.path === `/v1/deployments/environments/${encodeURIComponent(admission.environment.id)}?serverId=${encodeURIComponent(binding.serverIdentityId)}`
            && routeMatches({ serverId: binding.serverIdentityId, environmentId: admission.environment.id });
    }
    if (effectActionId !== binding.actionId) return false;
    if (method === 'GET' && proof.body === undefined) {
        if ((proof.path === '/v1/account/encryption' || proof.path === '/v1/account/encryption/currentness')
            && routeMatches({})) return true;
        // Publish's existing host-facts owner selects placement from current admitted Account inventory.
        if (admission.operation === 'publish' && proof.path === '/v1/machines' && routeMatches({})) return true;
        if (admission.operation !== 'publish') return false;
        const match = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
        if (!match) return false;
        let artifactId: string;
        try { artifactId = decodeURIComponent(match[1]); } catch { return false; }
        if (encodeURIComponent(artifactId) !== match[1] || !routeMatches({ id: artifactId })) return false;
        if (artifactId === admission.candidate.contentArtifactId) {
            const candidate = await tx.artifact.findUnique({ where: { id: artifactId },
                select: { headerVersion: true, bodyVersion: true } });
            return candidate?.headerVersion === admission.candidate.contentHeaderVersion
                && candidate.bodyVersion === admission.candidate.contentBodyVersion;
        }
        if (!admission.environment || !admission.source) return false;
        // Match the canonical Environment projection's current references,
        // including retained target links needed by native review. No inventory,
        // local lineage policy or fresh permission evaluation is involved.
        return await tx.deploymentEnvironment.findFirst({ where: { id: admission.environment.id,
            projectSourceId: admission.source.id, deletedAt: null, OR: [
                { contentArtifactId: artifactId }, { targetLinks: { some: { contentArtifactId: artifactId } } },
            ] }, select: { id: true } }) !== null;
    }
    if (admission.operation !== 'prepare' || method !== 'POST'
        || proof.path !== `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) return false;
    const request = ProjectAccountRowReadRequestV1Schema.safeParse(proof.body);
    return request.success && sameStrictJsonValue(request.data, {
        key: { kind: 'workspace-ref', serverId: binding.serverIdentityId, id: admission.workspace.id },
    }) && routeMatches(request.data);
}
