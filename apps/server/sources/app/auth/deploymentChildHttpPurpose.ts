import * as deploymentActionIds from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import * as managedIds from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { DeploymentEnvironmentGetInputV1Schema, DeploymentReceiptGetInputV1Schema, DeploymentReceiptListInputV1Schema, DeploymentTransitionInputV1Schema,
    DeploymentDomainListInputV1Schema, type DeploymentChildRoutingV1, type DeploymentArtifactContentReferenceV1 } from '@happier-dev/protocol';
import { readMemberDeploymentDomainContentInTx } from '@/app/deployments/deploymentDomainService';
import { EnvironmentSecretLaunchAdmissionInputV1Schema, getDeploymentTargetLinkLineageV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentChildAdmission } from '@/app/deployments/deploymentChildAuthorization';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DirectRouteGrantRequestV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import type { Tx } from '@/storage/inTx';
import type { DeploymentChildExecutionProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { isDeploymentCandidatePublicationHttpPurposeInTx, isDeploymentWorkspaceListHttpPurpose } from '@/app/deployments/deploymentPreparationAuthorization';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

function readArtifactId(path: string): string | null {
    const match = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(path);
    if (!match) return null;
    try {
        const id = decodeURIComponent(match[1]);
        return encodeURIComponent(id) === match[1] ? id : null;
    } catch { return null; }
}

/** The existing finite-transfer carrier is the only peer grant a retained child may request. */
export function readDeploymentChildPeerGrantTarget(proof: Readonly<{
    method: string; path: string; body: unknown; routeInput?: unknown;
}>): string | null {
    if (proof.method.toUpperCase() !== 'POST' || proof.path !== '/v1/machines/peer/mediation/route-grants') return null;
    const parsed = DirectRouteGrantRequestV2Schema.safeParse(proof.body);
    if (!parsed.success) return null;
    const body = parsed.data;
    return body.flowKind === 'bounded_transfer' && body.routeKind === 'iroh_peer'
        && body.scope.kind === 'bounded_transfer' && body.scope.mode === 'carrier'
        && body.iroh?.initiator.kind === 'account_client' && body.iroh.operationKind === 'finite_transfer'
        && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, body)) ? body.machineId : null;
}

/** A retained controller packet authorizes only this child's exact reads and single-stage publication. */
export async function readDeploymentChildHttpPurposeInTx(tx: Tx, routing: DeploymentChildRoutingV1,
    proof: Readonly<{ method: string; path: string; body: unknown; routeInput?: unknown;
        nativeIncumbentSource?: DeploymentChildExecutionProofV1['nativeIncumbentSource'] }>,
    admittedChild?: DeploymentChildAdmission,
): Promise<boolean | Readonly<{ artifactContentReference: DeploymentArtifactContentReferenceV1 }>
    | Readonly<{ metadataRead: Readonly<{ environmentId: string; deploymentId?: string; contentCustody: true }> }>> {
    const method = proof.method.toUpperCase();
    const readScope = getActionSpec(routing.actionId).deploymentReadScope;
    if (routing.kind === 'snapshot') {
        const input = { homeId: routing.input.serverId, managedId: routing.managedId };
        return method === 'POST' && !proof.nativeIncumbentSource
            && proof.path === managedMachineActionEndpointPathV1(managedIds.MANAGED_GET_ACTION_ID_V1)
            && admittedChild?.snapshotManagedMachine?.id === routing.managedId
            && sameStrictJsonValue(proof.body, input)
            && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, input));
    }
    if (routing.kind === 'dataRole') {
        if (method !== 'GET' || proof.body !== undefined || proof.nativeIncumbentSource) return false;
        if (proof.path === '/v1/account/encryption/currentness' || proof.path === '/v1/features/authenticated') return true;
        const artifactId = readArtifactId(proof.path);
        if (artifactId) {
            if (proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, { id: artifactId })) return false;
            const content = admittedChild?.dataRoleArtifactContents?.find(reference => reference.contentArtifactId === artifactId);
            return content ? { artifactContentReference: content } : false;
        }
        const metadata = (readScope?.childMetadataReads.dataRole ?? []).map(({ actionId, operand }) => ({
            actionId, value: { serverId: routing.input.serverId, environmentId: routing.input.environmentId,
                ...(operand === 'receipt' ? { deploymentId: routing.deploymentId } : {}) },
        }));
        const selected = metadata.find(({ actionId, value }) => {
            const spec = getActionSpec(actionId);
            return spec.serverTransport !== undefined && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, value))
                && bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input: value }).path === proof.path;
        });
        return selected ? { metadataRead: { environmentId: routing.input.environmentId,
            ...('deploymentId' in selected.value ? { deploymentId: routing.deploymentId } : {}),
            contentCustody: true } } : false;
    }
    if (routing.kind === 'domain' || routing.kind === 'domainDiscover' || routing.kind === 'domainDns') {
        if (method === 'POST' && routing.kind === 'domain' && !proof.nativeIncumbentSource) {
            const domainAdmission = admittedChild?.domainAdmission;
            if (proof.path === `/v1/deployments/machines/${encodeURIComponent(routing.machineId)}/connector-secret-grant`) {
                // The route owns operation, signer and subject admission.
                return !!admittedChild?.domainJob;
            }
            const secret = EnvironmentSecretLaunchAdmissionInputV1Schema.safeParse(proof.body);
            if (!secret.success || secret.data.materialization.kind !== 'domain') return false;
            const body = secret.data, materialization = secret.data.materialization;
            if (materialization.use && (!readScope?.childMayMaterializeDomainUse || !routing.capture.desired)) return false;
            const recipient = materialization.use ? { machineId: routing.machineId, installationId: routing.installationId }
                : domainAdmission?.controller;
            return body.serverId === routing.input.serverId && body.environmentId === routing.input.environmentId
                && body.targetLinkId === routing.capture.placement.targetLinkId && body.machineId === recipient?.machineId
                && body.installationId === recipient?.installationId && materialization.domainId === routing.input.domainId
                && (materialization.use ? materialization.use.domainId === routing.input.domainId
                    : domainAdmission?.actionOperationId === routing.actionOperationId)
                && materialization.expectedDomainRevision === routing.expectedDomainRevision
                && materialization.actionOperationId === routing.actionOperationId
                && sameStrictJsonValue(materialization.capture, routing.capture)
                && proof.path === `/v1/deployments/environments/${encodeURIComponent(routing.input.environmentId)}/secret-launch-admission`
                && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, body));
        }
        if (method !== 'GET' || proof.body !== undefined || proof.nativeIncumbentSource) return false;
        if (proof.path === '/v1/account/encryption/currentness' || proof.path === '/v1/features/authenticated') return true;
        const input = routing.input;
        const artifactId = readArtifactId(proof.path);
        if (artifactId && proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, { id: artifactId })) return false;
        if (artifactId && routing.kind === 'domain') {
            const content = [routing.capture.content, routing.capture.environmentContent, routing.capture.targetLinkContent]
                .find(reference => reference?.contentArtifactId === artifactId);
            return content ? { artifactContentReference: content } : false;
        }
        const environment = await tx.deploymentEnvironment.findUnique({ where: { id: input.environmentId },
            select: { projectSourceId: true, contentArtifactId: true } });
        if (!environment) return false;
        if (proof.path === `/v1/projects/sources/${encodeURIComponent(environment.projectSourceId)}?serverId=${encodeURIComponent(input.serverId)}`) return true;
        const metadata = (readScope?.childMetadataReads[routing.kind] ?? []).map(({ actionId, operand }) => ({
            actionId, value: operand === 'domain' ? input : { serverId: input.serverId, environmentId: input.environmentId },
        }));
        for (const { actionId, value } of metadata) {
            const spec = getActionSpec(actionId);
            if (spec.serverTransport && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, value))
                && bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input: value }).path === proof.path) return true;
        }
        if (!artifactId) return false;
        const content = routing.kind === 'domain' ? routing.capture.content : routing.kind === 'domainDiscover' ? routing.input : undefined;
        if (artifactId === content?.contentArtifactId || artifactId === environment.contentArtifactId) return true;
        const targetLinkId = routing.kind === 'domain' ? routing.capture.placement.targetLinkId : routing.input.targetLinkId;
        return await tx.deploymentTargetLink.findFirst({ where: { id: targetLinkId, environmentId: input.environmentId,
            contentArtifactId: artifactId }, select: { id: true } }) !== null;
    }
    const input = routing.input;
    // Native teardown children report observations to their captured controller;
    // they never publish aggregate transitions or acquire fresh secret custody.
    if ((routing.kind === 'teardown' || routing.kind === 'prepare' && readScope?.childReadOnly) && method !== 'GET') return false;
    const native = proof.nativeIncumbentSource;
    if (native && (routing.kind !== 'review' || native.environmentId !== input.environmentId
        || method !== 'GET' || proof.body !== undefined)) return false;
    if (!native && (routing.kind === 'prepare' || routing.kind === 'review' || routing.kind === 'build' || routing.kind === 'member')
        && isDeploymentWorkspaceListHttpPurpose(input.serverId, proof)) return true;
    if (method === 'POST') {
        if (routing.kind === 'prepare' || routing.kind === 'retention') return false;
        const secret = EnvironmentSecretLaunchAdmissionInputV1Schema.safeParse(proof.body);
        if (secret.success) {
            const body = secret.data;
            return body.serverId === input.serverId && body.environmentId === input.environmentId && body.targetLinkId === input.targetLinkId
                && body.machineId === routing.machineId && body.installationId === routing.installationId
                && proof.path === `/v1/deployments/environments/${encodeURIComponent(input.environmentId)}/secret-launch-admission`
                && (routing.kind === 'review'
                    ? body.materialization.kind === 'review' && body.materialization.contentArtifactId === routing.input.contentArtifactId
                    : body.materialization.kind === 'deployment' && body.materialization.deploymentId === routing.deploymentId
                        && body.materialization.actionOperationId === routing.actionOperationId)
                && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, body));
        }
        if (routing.kind === 'review') return false;
        const transition = DeploymentTransitionInputV1Schema.safeParse(proof.body);
        if (!transition.success) return false;
        const body = transition.data;
        return body.serverId === input.serverId && body.environmentId === input.environmentId && body.deploymentId === routing.deploymentId
            && body.actionOperationId === routing.actionOperationId && body.machineId === routing.machineId && body.installationId === routing.installationId
            && body.kind === 'stage' && body.state === 'running' && body.expectedTargetLinkRevision === undefined && !body.teardownProof
            && (body.contentArtifactId === undefined || body.contentArtifactId === routing.input.contentArtifactId)
            && proof.path === `/v1/deployments/environments/${encodeURIComponent(input.environmentId)}/deployments/${encodeURIComponent(routing.deploymentId)}/transitions`
            && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, body));
    }
    if (method !== 'GET' || proof.body !== undefined) return false;
    if (!native && routing.kind === 'member') {
        const list = DeploymentDomainListInputV1Schema.safeParse(proof.routeInput);
        const spec = getActionSpec(deploymentActionIds.DEPLOYMENT_DOMAIN_LIST_ACTION_ID_V1);
        if (list.success && list.data.serverId === input.serverId && list.data.environmentId === input.environmentId
            && spec.serverTransport && bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
                inputSchema: spec.inputSchema, input: list.data }).path === proof.path) return true;
        const artifactId = readArtifactId(proof.path);
        if (artifactId && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, { id: artifactId }))) {
            const content = await readMemberDeploymentDomainContentInTx(tx, { environmentId: input.environmentId,
                targetLinkId: input.targetLinkId, machineId: routing.machineId, installationId: routing.installationId, artifactId });
            if (content) return { artifactContentReference: content };
        }
    }
    if (!native && (proof.path === '/v1/account/encryption/currentness' || proof.path === '/v1/features/authenticated')) return true;
    const environmentRead = DeploymentEnvironmentGetInputV1Schema.safeParse(proof.routeInput);
    if (!native && environmentRead.success && environmentRead.data.serverId === input.serverId && environmentRead.data.environmentId === input.environmentId) {
        const spec = getActionSpec(deploymentActionIds.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1);
        const transport = spec.serverTransport;
        if (transport && bindHomeDomainHttpRequestV1({ transport, inputSchema: spec.inputSchema, input: environmentRead.data }).path === proof.path) return true;
    }
    const environment = await tx.deploymentEnvironment.findUnique({ where: { id: input.environmentId },
        select: { projectSourceId: true, contentArtifactId: true, controllerMachineId: true, buildMachineId: true } });
    if (!environment) return false;
    if (!native && proof.path === `/v1/projects/sources/${encodeURIComponent(environment.projectSourceId)}?serverId=${encodeURIComponent(input.serverId)}`) return true;
    if (!native && [routing.machineId, environment.controllerMachineId, environment.buildMachineId].some(id => id
        && proof.path === `/v1/machines/${encodeURIComponent(id)}`)) return true;
    const readLineage = async () => {
        const links = await tx.deploymentTargetLink.findMany({ where: { environmentId: input.environmentId, role: 'runtime' },
            select: { id: true, environmentId: true, predecessorTargetLinkId: true, contentArtifactId: true, activeDeploymentId: true } });
        const selected = links.find(link => link.id === input.targetLinkId);
        const lineage = selected ? getDeploymentTargetLinkLineageV1({ ...selected, predecessorTargetLinkId: selected.predecessorTargetLinkId ?? undefined },
            links.map(link => ({ ...link, predecessorTargetLinkId: link.predecessorTargetLinkId ?? undefined }))) : new Set<string>();
        return { links, lineage, selected };
    };
    let lineageRead: ReturnType<typeof readLineage> | undefined;
    const getLineage = () => lineageRead ??= readLineage();
    if (native) {
        const deploymentId = native.restorationForDeploymentId ?? native.sourceDeploymentId;
        const receiptInput = DeploymentReceiptGetInputV1Schema.safeParse(proof.routeInput);
        const spec = getActionSpec(deploymentActionIds.DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1);
        const metadata = receiptInput.success && receiptInput.data.serverId === input.serverId
            && receiptInput.data.environmentId === input.environmentId && receiptInput.data.deploymentId === deploymentId
            && spec.serverTransport !== undefined && bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
                inputSchema: spec.inputSchema, input: receiptInput.data }).path === proof.path;
        const artifactId = readArtifactId(proof.path);
        if (!metadata && !artifactId) return false;
        const receipt = await tx.deployment.findFirst({ where: { id: deploymentId, environmentId: input.environmentId,
            targetLinkId: { in: [...(await getLineage()).lineage] } }, select: { contentArtifactId: true } });
        return !!receipt && (metadata || artifactId === receipt.contentArtifactId);
    }
    const parent = routing.kind === 'review' || routing.kind === 'prepare' ? null : await tx.deployment.findUnique({ where: { id: routing.deploymentId } });
    const promotedFromDeploymentId = parent && 'promotedFromDeploymentId' in parent && typeof parent.promotedFromDeploymentId === 'string'
        ? parent.promotedFromDeploymentId : null;
    const promotionReceipt = routing.kind !== 'prepare' && routing.kind !== 'teardown' && routing.promotion
        && (routing.kind === 'review' || promotedFromDeploymentId === routing.promotion.sourceDeploymentId)
        ? await tx.deployment.findFirst({ where: {
            id: routing.promotion.sourceDeploymentId, environmentId: routing.promotion.sourceEnvironmentId,
            ...(routing.kind === 'review' ? { state: { in: ['succeeded', 'running_unverified'] } } : {}),
        }, select: { id: true, environmentId: true, contentArtifactId: true,
            environment: { select: { projectSourceId: true } } } }) : null;
    // Promote reopens its selected source metadata during finite child work.
    // Accepted work derives that source from the stored parent, never another request tuple.
    if (promotionReceipt && environmentRead.success && environmentRead.data.serverId === input.serverId
        && environmentRead.data.environmentId === promotionReceipt.environmentId) {
        const spec = getActionSpec(deploymentActionIds.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1);
        if (spec.serverTransport && bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
            inputSchema: spec.inputSchema, input: environmentRead.data }).path === proof.path) return true;
    }
    // Preparation reconstructs member versions from the same runtime history
    // that execution and retention consume. Passive review needs only the selected
    // rollback and currently serving release.
    const sourceCustodyRead = routing.kind === 'prepare' || routing.kind === 'retention' || routing.kind === 'member'
        || routing.kind === 'build' || routing.kind === 'teardown';
    if (sourceCustodyRead) {
        const list = DeploymentReceiptListInputV1Schema.safeParse(proof.routeInput);
        if (list.success && list.data.serverId === input.serverId && list.data.environmentId === input.environmentId) {
            const spec = getActionSpec(deploymentActionIds.DEPLOYMENT_RECEIPT_LIST_ACTION_ID_V1);
            if (spec.serverTransport && bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema,
                input: list.data }).path === proof.path) return true;
        }
    }
    const reviewScope = routing.kind === 'review' ? await getLineage() : null;
    const receiptIds = [...new Set([parent?.id, parent?.rollbackOfDeploymentId, promotedFromDeploymentId,
        ...(routing.kind === 'review' ? [routing.input.deploymentId, reviewScope?.selected?.activeDeploymentId] : []),
        ...(routing.kind === 'member' ? [routing.selectedDeploymentId] : [])].filter((id): id is string => !!id))];
    const reviewReceiptScope = reviewScope ? { environmentId: input.environmentId,
        targetLinkId: { in: [...reviewScope.lineage] }, state: { in: ['succeeded', 'running_unverified'] } } : {};
    const receiptRead = DeploymentReceiptGetInputV1Schema.safeParse(proof.routeInput);
    const sourceReceipt = sourceCustodyRead && receiptRead.success && receiptRead.data.environmentId === input.environmentId
        && !receiptIds.includes(receiptRead.data.deploymentId)
        && await tx.deployment.findFirst({ where: { id: receiptRead.data.deploymentId, environmentId: input.environmentId,
            targetLinkId: { in: [...(await getLineage()).lineage] } }, select: { id: true } }) !== null;
    if (receiptRead.success && receiptRead.data.serverId === input.serverId && (sourceReceipt
        || promotionReceipt?.id === receiptRead.data.deploymentId && promotionReceipt.environmentId === receiptRead.data.environmentId
        || receiptIds.includes(receiptRead.data.deploymentId) && (!reviewScope
            || receiptRead.data.environmentId === input.environmentId && await tx.deployment.findFirst({ where: {
                id: receiptRead.data.deploymentId, ...reviewReceiptScope }, select: { id: true } }) !== null))) {
        const spec = getActionSpec(deploymentActionIds.DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1);
        const transport = spec.serverTransport;
        if (transport && bindHomeDomainHttpRequestV1({ transport, inputSchema: spec.inputSchema, input: receiptRead.data }).path === proof.path) return true;
    }
    const artifactId = readArtifactId(proof.path);
    if (!artifactId) return false;
    // Review reopens the exact replacement Environment content captured in the
    // signed promotion packet, alongside its selected same-Source receipt.
    if (promotionReceipt && routing.kind === 'review' && admittedChild
        && promotionReceipt.environment.projectSourceId === environment.projectSourceId
        && routing.promotion?.destinationContent.contentArtifactId === artifactId
        && await isDeploymentCandidatePublicationHttpPurposeInTx(tx, admittedChild.binding, routing.actionId, proof)) return true;
    if (promotionReceipt?.contentArtifactId === artifactId) return true;
    if ((routing.kind !== 'prepare' && artifactId === routing.input.contentArtifactId) || artifactId === environment.contentArtifactId) return true;
    const { links, lineage } = await getLineage();
    if (links.some(link => lineage.has(link.id) && link.contentArtifactId === artifactId)) return true;
    if (sourceCustodyRead && await tx.deployment.findFirst({ where: { environmentId: input.environmentId,
        targetLinkId: { in: [...lineage] }, contentArtifactId: artifactId }, select: { id: true } }) !== null) return true;
    return receiptIds.length > 0 && await tx.deployment.findFirst({ where: { id: { in: receiptIds },
        ...reviewReceiptScope, contentArtifactId: artifactId }, select: { id: true } }) !== null;
}

export async function isDeploymentChildHttpPurposeInTx(...args: Parameters<typeof readDeploymentChildHttpPurposeInTx>): Promise<boolean> {
    return Boolean(await readDeploymentChildHttpPurposeInTx(...args));
}
