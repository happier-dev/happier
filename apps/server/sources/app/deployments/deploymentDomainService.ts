import { isDeepStrictEqual } from 'node:util';
import { DeploymentDomainHeaderV1Schema, DeploymentDomainCapturedPlacementsV1Schema,
    type DeploymentDomainAddAdmissionInputV1, type DeploymentDomainRemoveAdmissionInputV1,
    type DeploymentDomainGetInputV1, type DeploymentDomainListInputV1, type DeploymentDomainPlacementV1,
    type DeploymentDomainTransitionInputV1, type DeploymentDomainPreparedContentInputV1, deploymentDomainObservationProofPayloadV1,
    type DeploymentDomainNetworkExposureV1,
    nativeCaddyDomainRouteIdsV1, verifyNativeCaddyRemovalProofV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1, deploymentChildEffectActionIdForRootV1 } from '@happier-dev/protocol';
import { isDeploymentDomainAddActionIdV1, isDeploymentDomainChildActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { defaultRepeatKeyExpiresAt, fetchRepeatKey, saveRepeatKey } from '@/storage/queue/repeatKey';
import { readTransactionDatabaseTime } from '@/storage/transactionDatabaseTime';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { readProjectSourceCustodyInTx } from '@/app/projects/sources/projectSourceService';
import { deploymentFailure, deploymentMachineUnavailable, admitDeploymentMachinesInTx, type DeploymentAuthentication } from './deploymentAdmission';
import { projectDeploymentListRow } from './deploymentListProjection';
import { deploymentIntentDigest, loadDeploymentEnvironmentInTx, loadDeploymentEnvironmentCustodyInTx, lockDeploymentEnvironmentInTx,
    type AdmittedDeploymentEnvironment } from './deploymentEnvironmentService';
import { deploymentContentReference, admitDeploymentStoredContentInTx, updateDeploymentStoredContentInTx } from './deploymentStoredContent';
import { publishDeploymentChangesInTx } from './deploymentPublication';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { EnvironmentDomainSecretLaunchAdmissionV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentChildAdmission } from './deploymentChildAuthorization';
import type { VerifiedExternalActionExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { readDeploymentMembershipAdmissionInTx } from './deploymentMembershipService';
import { DeploymentDomainProviderCaptureV1Schema, deploymentDomainProviderObservationProofPayloadV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';

type DeploymentDomainRow = NonNullable<Awaited<ReturnType<Tx['deploymentDomain']['findUnique']>>>;
type AcceptedDeploymentRead = NonNullable<VerifiedExternalActionExecutionRequest['acceptedDeploymentReceipt']>['read'];
type Captures = ReturnType<typeof DeploymentDomainCapturedPlacementsV1Schema.parse>;
function readCaptures(row: Readonly<{ capturedPlacements: unknown }>): Captures | null {
    const parsed = DeploymentDomainCapturedPlacementsV1Schema.safeParse(row.capturedPlacements);
    return parsed.success && parsed.data.length > 0 ? parsed.data : null;
}
function readProviderCapture(row: Readonly<{ capturedPlacements: unknown }>) {
    const parsed = DeploymentDomainProviderCaptureV1Schema.safeParse(row.capturedPlacements);
    return parsed.success ? parsed.data : null;
}
/** Reference disclosure projects only this Machine's admitted native placements. */
export function projectDeploymentDomainMachineReferences(row: Readonly<{ id: string; environmentId: string; capturedPlacements: unknown }>, machineId: string) {
    return (readCaptures(row) ?? []).filter(capture => capture.placement.machineId === machineId
        && capture.placement.domainId === row.id && capture.placement.environmentId === row.environmentId)
        .map(({ placement }) => ({ environmentId: row.environmentId, targetLinkId: placement.targetLinkId,
            domainId: row.id, machineId, installationId: placement.installationId }));
}
function publicCapture({ installationPublicKey: _key, execution: _execution, networkExposure: _exposure, dnsHealth: _dns,
    routedReplicas: _replicas,
    ...capture }: Captures[number]): DeploymentDomainPlacementV1 { return capture; }

const domainContentReferenceFields = ['content', 'environmentContent', 'targetLinkContent'] as const;
async function readDeploymentDomainContentRowsInTx(tx: Tx, input: Readonly<{
    environmentId: string; artifactId: string; referenceFields: readonly typeof domainContentReferenceFields[number][];
    placement?: Pick<Captures[number]['placement'], 'environmentId' | 'targetLinkId' | 'machineId' | 'installationId'>;
}>) {
    const needles = input.referenceFields.flatMap(field => {
        const reference = { ...(input.placement ? { placement: input.placement } : {}), [field]: { contentArtifactId: input.artifactId } };
        return [JSON.stringify([reference]), ...(input.placement ? [] : [JSON.stringify({ kind: 'provider', ...reference })])];
    });
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    let rows: { state: string; capturedPlacements: unknown }[];
    if (provider === 'postgres') rows = await tx.$queryRawUnsafe(
        `SELECT "state", "capturedPlacements" FROM "DeploymentDomain" WHERE "environmentId" = $1 AND "deletedAt" IS NULL AND (${needles.map((_, index) => `"capturedPlacements" @> $${index + 2}::jsonb`).join(' OR ')})`,
        input.environmentId, ...needles);
    else if (provider === 'mysql') rows = await tx.$queryRawUnsafe(
        `SELECT \`state\`, \`capturedPlacements\` FROM \`DeploymentDomain\` WHERE \`environmentId\` = ? AND \`deletedAt\` IS NULL AND (${needles.map(() => 'JSON_CONTAINS(`capturedPlacements`, CAST(? AS JSON))').join(' OR ')})`,
        input.environmentId, ...needles);
    else {
        const placement = Object.entries(input.placement ?? {});
        const placementConditions = placement.map(([key]) => `json_extract(c.value, '$.placement.${key}') = ?`);
        const contentConditions = input.referenceFields.map(field => `json_extract(c.value, '$.${field}.contentArtifactId') = ?`);
        const providerConditions = input.placement ? [] : input.referenceFields.map(field =>
            `json_extract(d."capturedPlacements", '$.${field}.contentArtifactId') = ?`);
        rows = await tx.$queryRawUnsafe(
            `SELECT d."state", d."capturedPlacements" FROM "DeploymentDomain" d WHERE d."environmentId" = ? AND d."deletedAt" IS NULL AND (EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(d."capturedPlacements") = 'array' THEN d."capturedPlacements" ELSE '[]' END) c WHERE ${[...placementConditions, `(${contentConditions.join(' OR ')})`].join(' AND ')})${providerConditions.length ? ` OR (json_extract(d."capturedPlacements", '$.kind') = 'provider' AND (${providerConditions.join(' OR ')}))` : ''})`,
            input.environmentId, ...placement.map(([, value]) => value), ...input.referenceFields.map(() => input.artifactId),
            ...providerConditions.map(() => input.artifactId));
    }
    return rows.map(row => ({ ...row, capturedPlacements: typeof row.capturedPlacements === 'string'
        ? JSON.parse(row.capturedPlacements) as unknown : row.capturedPlacements }));
}

/** The admitted member opens only its exact captured Domain operand, including retained legs. */
export async function readMemberDeploymentDomainContentInTx(tx: Tx, input: Readonly<{
    environmentId: string; targetLinkId: string; machineId: string; installationId: string; artifactId: string;
}>) {
    const placement = { environmentId: input.environmentId, targetLinkId: input.targetLinkId,
        machineId: input.machineId, installationId: input.installationId };
    const rows = await readDeploymentDomainContentRowsInTx(tx, { ...input, placement, referenceFields: ['content'] });
    for (const row of rows) {
        const capture = readCaptures(row)?.find(item => item.content.contentArtifactId === input.artifactId
            && Object.entries(placement).every(([key, value]) => Reflect.get(item.placement, key) === value));
        if (capture) return capture.content;
    }
    return null;
}
type DomainCaptureInput = Readonly<{ environmentId: string; domainId: string; expectedDomainRevision: number; capture: DeploymentDomainPlacementV1 }>;

async function readCurrentCaptureInTx(tx: Tx, input: DomainCaptureInput) {
    const row = await tx.deploymentDomain.findFirst({ where: { id: input.domainId, environmentId: input.environmentId,
        revision: input.expectedDomainRevision, deletedAt: null } });
    const captures = row ? readCaptures(row) : null;
    const capture = captures?.find(item => isDeepStrictEqual(publicCapture(item), input.capture));
    return row && capture && captures ? { row, capture, captures } : null;
}

async function readActiveJobCaptureInTx(tx: Tx, input: DomainCaptureInput & Readonly<{ actionOperationId: string }>) {
    const current = await readCurrentCaptureInTx(tx, input);
    if (!current || current.row.state !== 'pending' && current.row.state !== 'removing'
        || !current.capture.execution || current.capture.placement.actionOperationId !== input.actionOperationId) return null;
    return { ...current, execution: current.capture.execution };
}
export type DeploymentDomainJobAdmission = NonNullable<Awaited<ReturnType<typeof readActiveJobCaptureInTx>>>;

/** Project the accepted job using the controller key already verified by authentication; no new admission or key read. */
export function projectAcceptedDeploymentDomainSecretLaunchAdmission(job: DeploymentDomainJobAdmission,
    controller: Readonly<{ machineId: string; installationId: string; publicKey: Uint8Array }>,
): EnvironmentDomainSecretLaunchAdmissionV1 | null {
    if (job.execution.controller.machineId !== controller.machineId
        || job.execution.controller.installationId !== controller.installationId) return null;
    return { controller: { machineId: controller.machineId, installationId: controller.installationId,
        publicKey: encodeBase64(controller.publicKey, 'base64url') },
        target: { machineId: job.capture.placement.machineId, installationId: job.capture.placement.installationId,
            publicKey: job.capture.installationPublicKey },
        actionOperationId: job.capture.placement.actionOperationId };
}

/** Verify reads the current canonical capture after its caller's Source-read admission. */
export async function hasCurrentDeploymentDomainCaptureInTx(tx: Tx,
    input: DomainCaptureInput,
): Promise<boolean> {
    return await readCurrentCaptureInTx(tx, input) !== null;
}

/** Cheap continuation of the exact admitted Domain job, without new Source or Machine admission. */
export async function readAcceptedDeploymentDomainInTx(tx: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    input: Readonly<{ environmentId: string; domainId: string; expectedDomainRevision: number;
        actionOperationId: string; capture: DeploymentDomainPlacementV1 }>,
): Promise<DeploymentDomainJobAdmission | null> {
    if (binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId || !binding.requestEnvelopeDigest) return null;
    const job = await readActiveJobCaptureInTx(tx, input);
    if (!job) return null;
    return matchesAcceptedDeploymentDomainCapture(binding, job.capture) ? job : null;
}

function matchesAcceptedDeploymentDomainCapture(binding: ExternalActionExecutionAuthorizationBindingV1, capture: Captures[number]) {
    const execution = capture.execution;
    return execution !== undefined && capture.placement.requestId === binding.requestId
        && capture.placement.serverId === binding.serverIdentityId && capture.placement.accountId === binding.accountId
        && execution.controller.machineId === binding.machineId && execution.controller.installationId === binding.installationId
        && execution.requestEnvelopeDigest === binding.requestEnvelopeDigest
        && (execution.actionId === binding.actionId
            || isDeploymentDomainChildActionIdV1(execution.actionId)
                && deploymentChildEffectActionIdForRootV1(binding.actionId, binding.deploymentPreparationAdmission, execution.actionId)
                    === execution.actionId);
}

/** The admitted teardown controller reopens only operands held by its still-removing Domain captures. */
export async function readAcceptedDeploymentTeardownDomainContentInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, artifactId: string,
) {
    if (binding.actionId !== 'deployments.teardown' || !binding.environmentId || binding.target.kind !== 'machine'
        || binding.target.machineId !== binding.machineId || !binding.requestEnvelopeDigest) return null;
    const domains = await readDeploymentDomainContentRowsInTx(tx, { environmentId: binding.environmentId,
        artifactId, referenceFields: domainContentReferenceFields });
    for (const domain of domains) {
        if (domain.state !== 'removing') continue;
        const provider = readProviderCapture(domain);
        if (provider && provider.placement.environmentId === binding.environmentId
            && provider.placement.serverId === binding.serverIdentityId && provider.placement.accountId === binding.accountId
            && provider.placement.requestId === binding.requestId && provider.requestEnvelopeDigest === binding.requestEnvelopeDigest
            && provider.placement.controller.machineId === binding.machineId
            && provider.placement.controller.installationId === binding.installationId) {
            const content = domainContentReferenceFields.map(field => provider[field])
                .find(reference => reference.contentArtifactId === artifactId);
            if (content) return content;
        }
        for (const capture of readCaptures(domain) ?? []) {
            if (capture.placement.environmentId !== binding.environmentId || !matchesAcceptedDeploymentDomainCapture(binding, capture)) continue;
            const content = domainContentReferenceFields.map(field => capture[field])
                .find(reference => reference?.contentArtifactId === artifactId);
            if (content) return content;
        }
    }
    return null;
}

/** The authenticated installed receiver acquires secrets only for its captured, still-active desired Domain job. */
export async function readAcceptedDeploymentDomainSecretDestinationInTx(tx: Tx,
    input: Readonly<{ environmentId: string; domainId: string; expectedDomainRevision: number; actionOperationId: string;
        capture: DeploymentDomainPlacementV1; machineId: string; installationId: string; installationPublicKey: Uint8Array }>,
    admittedJob?: DeploymentDomainJobAdmission,
): Promise<ProjectSourceOwnerV1 | null> {
    const job = admittedJob ?? await readActiveJobCaptureInTx(tx, input);
    if (!job) return null;
    const { capture } = job;
    if (!capture.desired || capture.placement.machineId !== input.machineId || capture.placement.installationId !== input.installationId
        || capture.installationPublicKey !== encodeBase64(input.installationPublicKey, 'base64url')) return null;
    const environment = await tx.deploymentEnvironment.findUnique({ where: { id: input.environmentId }, select: { projectSourceId: true } });
    return environment ? (await readProjectSourceCustodyInTx(tx, environment.projectSourceId))?.owner ?? null : null;
}

export function projectDeploymentDomainHeader(row: DeploymentDomainRow) {
    const provider = readProviderCapture(row);
    const captures = readCaptures(row) ?? [];
    const desired = row.deletedAt ? [] : captures.filter(capture => capture.desired);
    const replicas = desired.length > 0 && desired.every(capture => capture.routedReplicas !== undefined)
        ? [...new Map(desired.flatMap(capture => capture.routedReplicas!.map(({ containerName }) => {
            const replica = { machineId: capture.placement.machineId, installationId: capture.placement.installationId, containerName };
            return [JSON.stringify([replica.machineId, replica.installationId, containerName]), replica] as const;
        }))).values()] : undefined;
    const first = captures[0];
    const operationAddress = first?.execution && captures.every(capture =>
        capture.execution?.controller.machineId === first.execution!.controller.machineId
        && capture.placement.serverId === first.placement.serverId
        && capture.placement.actionOperationId === first.placement.actionOperationId)
        ? { serverId: first.placement.serverId, machineId: first.execution.controller.machineId,
            operationId: first.placement.actionOperationId } : undefined;
    return DeploymentDomainHeaderV1Schema.parse({
        v: 1, id: row.id, environmentId: row.environmentId, targetLinkId: row.targetLinkId,
        revision: row.revision, state: row.state, ...deploymentContentReference(row),
        createdByAccountId: row.createdByAccountId,
        placements: captures.map(publicCapture),
        ...(replicas ? { routedReplicas: { source: 'recordedTopology', count: replicas.length, replicas } } : {}),
        ...(provider ? { provider: true, providerPlacement: provider.placement,
            operationAddress: { serverId: provider.placement.serverId, machineId: provider.placement.controller.machineId,
                operationId: provider.placement.actionOperationId } } : {}),
        ...(operationAddress ? { operationAddress } : {}),
        dnsHealth: (captures.find(capture => capture.desired && capture.dnsHealth?.status !== 'up')
            ?? captures.find(capture => capture.desired))?.dnsHealth,
        networkExposure: captures.map(capture => {
            const observation: DeploymentDomainNetworkExposureV1 = row.deletedAt ? { kind: 'unavailable', reason: 'route_absent' }
                : capture.networkExposure ?? { kind: 'unavailable', reason: 'required_fact_unavailable' };
            return { machineId: capture.placement.machineId,
                installationId: capture.placement.installationId, nativeServer: capture.placement.nativeServer,
                listener: capture.listener, observation: observation.kind === 'unavailable'
                    ? projectDeploymentFailureRecoveryV1({ ...observation, requiredFact: observation.requiredFact ?? 'networkExposure' })
                    : observation };
        }),
        ...(row.observedAt ? { observedAtMs: row.observedAt.getTime() } : {}),
        createdAtMs: row.createdAt.getTime(), updatedAtMs: row.updatedAt.getTime(),
        ...(row.deletedAt ? { deletedAtMs: row.deletedAt.getTime() } : {}),
    });
}

function domainResult(row: DeploymentDomainRow, revision: number) {
    return { ok: true as const, environmentId: row.environmentId, revision, domain: projectDeploymentDomainHeader(row) };
}

/** Exact native destinations for the sole binding/grant writer, never inferred from a grant already issued. */
export async function readDeploymentDomainOperationalDestinationsInTx(tx: Tx,
    input: Readonly<{ environmentId: string; domainIds: readonly string[] }>,
) {
    const domains: { domainId: string; placements: { machineId: string; installationId: string; installationPublicKey: string }[] }[] = [];
    let complete = true;
    for (const ids of portableQueryChunks({ values: [...new Set(input.domainIds)], bindingsPerValue: 1, fixedBindings: 1 })) {
        const rows = await tx.deploymentDomain.findMany({ where: { id: { in: [...ids] }, environmentId: input.environmentId, deletedAt: null } });
        if (rows.length !== ids.length) complete = false;
        for (const row of rows) {
            const captures = readCaptures(row);
            if (!captures) complete = false;
            const desired = (captures ?? []).filter(capture => capture.desired);
            const destinations = [...new Map(desired.map(capture => [`${capture.placement.machineId}:${capture.placement.installationId}`, capture])).values()];
            domains.push({ domainId: row.id, placements: destinations.map(capture => ({
                machineId: capture.placement.machineId, installationId: capture.placement.installationId,
                installationPublicKey: capture.installationPublicKey,
            })) });
        }
    }
    return { status: complete ? 'complete' as const : 'incomplete' as const, domains };
}

/** Database-side exact Machine selection keeps retained edge custody visible without an Account inventory scan. */
export async function readDeploymentDomainEnvironmentIdsForMachineInTx(tx: Tx,
    input: Readonly<{ machineId: string; afterEnvironmentId?: string; limit: number }>,
): Promise<string[]> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const needle = JSON.stringify([{ placement: { machineId: input.machineId } }]);
    let rows: { environmentId: string }[];
    if (provider === 'postgres') rows = await tx.$queryRawUnsafe(
        'SELECT DISTINCT "environmentId" FROM "DeploymentDomain" WHERE "deletedAt" IS NULL AND "capturedPlacements" @> $1::jsonb AND "environmentId" > $2 ORDER BY "environmentId" LIMIT $3',
        needle, input.afterEnvironmentId ?? '', input.limit);
    else if (provider === 'mysql') rows = await tx.$queryRawUnsafe(
        'SELECT DISTINCT `environmentId` FROM `DeploymentDomain` WHERE `deletedAt` IS NULL AND JSON_CONTAINS(`capturedPlacements`, CAST(? AS JSON)) AND `environmentId` > ? ORDER BY `environmentId` LIMIT ?',
        needle, input.afterEnvironmentId ?? '', input.limit);
    else rows = await tx.$queryRawUnsafe(
        'SELECT DISTINCT d."environmentId" FROM "DeploymentDomain" d, json_each(CASE WHEN json_type(d."capturedPlacements") = \'array\' THEN d."capturedPlacements" ELSE \'[]\' END) c WHERE d."deletedAt" IS NULL AND json_extract(c.value, \'$.placement.machineId\') = ? AND d."environmentId" > ? ORDER BY d."environmentId" LIMIT ?',
        input.machineId, input.afterEnvironmentId ?? '', input.limit);
    return rows.map(row => row.environmentId);
}

/** Current Source admission exposes references only; Artifact opening retains its own mode-aware owner. */
export async function readDeploymentDomainInTx(tx: Tx, actorAccountId: string, input: DeploymentDomainGetInputV1,
    authentication: DeploymentAuthentication = {},
    acceptedRead?: AcceptedDeploymentRead,
) {
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication,
        acceptedRead?.environmentId === input.environmentId ? { environmentId: input.environmentId } : undefined);
    if (!loaded.ok) return loaded;
    const row = await tx.deploymentDomain.findFirst({ where: { id: input.domainId, environmentId: loaded.row.id } });
    return row ? domainResult(row, loaded.row.revision) : deploymentFailure('deployment_unavailable');
}

/** The demanded Domain page uses the incumbent Artifact page boundary; cleanup uses the complete inventory below. */
export async function listDeploymentDomainsInTx(tx: Tx, actorAccountId: string, input: DeploymentDomainListInputV1,
    authentication: DeploymentAuthentication = {},
    admittedChild?: DeploymentChildAdmission,
    acceptedRead?: AcceptedDeploymentRead,
) {
    const member = admittedChild?.routing.kind === 'member' ? admittedChild : undefined;
    const row = member ? await tx.deploymentEnvironment.findUnique({ where: { id: input.environmentId }, select: { id: true, revision: true } }) : null;
    const loaded = member ? row ? { ok: true as const, row } : deploymentFailure('deployment_unavailable')
        : await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication,
            acceptedRead?.environmentId === input.environmentId ? { environmentId: input.environmentId } : undefined);
    if (!loaded.ok) return loaded;
    const limit = Math.min(input.limit ?? ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, ARTIFACT_LIST_PAGE_MAX_ITEMS_V1);
    const rows = await tx.deploymentDomain.findMany({ where: { environmentId: loaded.row.id, deletedAt: null,
        ...(input.cursor ? { id: { gt: input.cursor } } : {}) }, orderBy: { id: 'asc' }, take: limit + 1 });
    return { ok: true as const, environmentId: loaded.row.id, revision: loaded.row.revision,
        domains: rows.slice(0, limit).flatMap(row => {
            const projected = projectDeploymentListRow(() => projectDeploymentDomainHeader(row));
            return projected ? [projected] : [];
        }), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
}

/** Admit desired Domain content once, capturing every native placement before any effect. */
export async function createDeploymentDomainInTx(tx: Tx, actorAccountId: string, input: DeploymentDomainAddAdmissionInputV1,
    authentication: DeploymentAuthentication = {},
    executionBinding?: ExternalActionExecutionAuthorizationBindingV1,
    admittedEffectActionId?: string,
) {
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const membership = input.membershipDeploymentId && executionBinding
        ? await readDeploymentMembershipAdmissionInTx(tx, executionBinding, input) : null;
    if (input.membershipDeploymentId && !membership) return deploymentFailure('deployment_access_denied');
    const loaded = membership ? await loadDeploymentEnvironmentCustodyInTx(tx, input)
        : await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if ('admission' in loaded && !loaded.admission.canManage || loaded.row.deletedAt) return deploymentFailure('deployment_access_denied');
    const owner = 'admission' in loaded ? loaded.admission.owner : loaded.owner;
    if (executionBinding && ((admittedEffectActionId ?? executionBinding.actionId) !== 'deployments.domains.add' || executionBinding.accountId !== actorAccountId
        || !membership && executionBinding.machineId !== loaded.row.controllerMachineId || executionBinding.requestId !== input.requestId
        || executionBinding.serverIdentityId !== input.serverId || !executionBinding.requestEnvelopeDigest)) return deploymentFailure('deployment_access_denied');
    const now = await readTransactionDatabaseTime(tx);
    const repeatKey = `deployments.domains.add:${actorAccountId}:${input.environmentId}:${input.requestKey}`;
    const digest = deploymentIntentDigest(input);
    const repeated = await fetchRepeatKey(tx, repeatKey, now);
    const previous = await tx.deploymentDomain.findUnique({ where: { id: input.domainId } });
    if (repeated) return repeated === digest && previous?.environmentId === loaded.row.id
        ? domainResult(previous, loaded.row.revision) : deploymentFailure('deployment_conflict');
    if (loaded.row.revision !== input.expectedRevision || loaded.row.runtimeTargetLinkId !== input.targetLinkId
        || previous && (previous.environmentId !== loaded.row.id || previous.deletedAt || previous.state === 'removing'
            || previous.revision !== input.expectedDomainRevision)
        || !previous && input.expectedDomainRevision !== undefined) return deploymentFailure('deployment_conflict');
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: input.targetLinkId, environmentId: loaded.row.id,
        role: 'runtime', deletedAt: null, detachedAt: null }, include: { machines: true } });
    if (!link || link.revision !== input.expectedTargetLinkRevision) {
        return deploymentFailure('deployment_conflict');
    }
    if (input.provider === true) {
        if (membership || link.sourceKind !== 'plugin' || previous && (!readProviderCapture(previous) || previous.targetLinkId !== link.id))
            return deploymentFailure('deployment_conflict');
        if (!loaded.row.controllerMachineId) return deploymentFailure('deployment_unavailable');
        const contentFailure = await admitDeploymentStoredContentInTx(tx, actorAccountId, owner, input, DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1);
        if (contentFailure) return contentFailure;
        const controller = await tx.machine.findFirst({ where: { id: loaded.row.controllerMachineId,
            revokedAt: null, replacedByMachineId: null }, select: { id: true, installationId: true, installationPublicKey: true } });
        if (!controller?.installationId || !controller.installationPublicKey
            || executionBinding && executionBinding.installationId !== controller.installationId) return deploymentMachineUnavailable(controller.id, 'controller');
        const capturedPlacements = DeploymentDomainProviderCaptureV1Schema.parse({ kind: 'provider',
            placement: { serverId: input.serverId, accountId: actorAccountId, environmentId: input.environmentId,
                targetLinkId: link.id, domainId: input.domainId, controller: { machineId: controller.id,
                    installationId: controller.installationId }, actionOperationId: input.actionOperationId, requestId: input.requestId },
            installationPublicKey: encodeBase64(controller.installationPublicKey, 'base64url'), content: deploymentContentReference(input),
            environmentContent: deploymentContentReference(loaded.row), targetLinkContent: deploymentContentReference(link),
            ...(executionBinding?.requestEnvelopeDigest ? { requestEnvelopeDigest: executionBinding.requestEnvelopeDigest } : {}) });
        const row = previous ? await tx.deploymentDomain.update({ where: { id: previous.id }, data: {
            ...deploymentContentReference(input), capturedPlacements, state: 'pending', revision: { increment: 1 },
        } }) : await tx.deploymentDomain.create({ data: { id: input.domainId, environmentId: loaded.row.id,
            targetLinkId: link.id, state: 'pending', createdByAccountId: actorAccountId,
            ...deploymentContentReference(input), capturedPlacements } });
        await tx.deploymentEnvironment.update({ where: { id: loaded.row.id }, data: { revision: { increment: 1 } } });
        await saveRepeatKey(tx, repeatKey, digest, defaultRepeatKeyExpiresAt(now));
        await publishDeploymentChangesInTx(tx, 'admission' in loaded ? loaded.admission : loaded, loaded.row.id, loaded.row.revision + 1);
        return domainResult(row, loaded.row.revision + 1);
    }
    if (link.sourceKind !== 'host' || link.targetKind !== 'ownServer') return deploymentFailure('deployment_conflict');
    const desiredMembers = membership?.members ?? link.machines;
    if (input.placements.some(item => !desiredMembers.some(member => member.machineId === item.machineId && member.installationId === item.installationId)
        && item.machineId !== loaded.row.edgeMachineId)
        || desiredMembers.some(member => !input.placements.some(item => item.machineId === member.machineId && item.installationId === member.installationId))
        || loaded.row.edgeMachineId && !input.placements.some(item => item.machineId === loaded.row.edgeMachineId)) {
        return deploymentFailure('deployment_conflict');
    }
    const machineFailure = membership ? null : await admitDeploymentMachinesInTx(tx, owner,
        input.placements.map(item => ({ ...item, role: 'target' as const })));
    if (machineFailure) return machineFailure;
    const contentFailure = membership ? null : await admitDeploymentStoredContentInTx(tx, actorAccountId, owner, input, DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1);
    if (contentFailure) return contentFailure;
    const keys = new Map<string, string>();
    for (const ids of portableQueryChunks({ values: [...new Set(input.placements.map(item => item.machineId))], bindingsPerValue: 1 })) {
        const machines = await tx.machine.findMany({ where: { id: { in: [...ids] }, revokedAt: null, replacedByMachineId: null },
            select: { id: true, installationId: true, installationPublicKey: true } });
        for (const machine of machines) if (machine.installationPublicKey && input.placements.some(item =>
            item.machineId === machine.id && item.installationId === machine.installationId)) {
            keys.set(machine.id, encodeBase64(machine.installationPublicKey, 'base64url'));
        }
    }
    if (input.placements.some(item => !keys.has(item.machineId))) return deploymentFailure('deployment_access_denied');
    const oldCaptures = previous ? readCaptures(previous) : [];
    // Legacy unknown custody cannot be overwritten into a false complete list.
    if (!oldCaptures) return deploymentFailure('deployment_conflict');
    const desired: Captures = input.placements.map(item => ({ placement: { serverId: input.serverId, accountId: actorAccountId,
        environmentId: input.environmentId, targetLinkId: input.targetLinkId, domainId: input.domainId,
        machineId: item.machineId, installationId: item.installationId, nativeServer: item.nativeServer,
        actionOperationId: input.actionOperationId, requestId: input.requestId }, listener: item.listener,
        content: deploymentContentReference(input), desired: true, installationPublicKey: keys.get(item.machineId)!,
        dockerEngineId: item.dockerEngineId, environmentContent: deploymentContentReference(loaded.row),
        targetLinkContent: deploymentContentReference(link) }));
    const execution: Captures[number]['execution'] = executionBinding ? {
        controller: { machineId: executionBinding.machineId, installationId: executionBinding.installationId },
        requestEnvelopeDigest: executionBinding.requestEnvelopeDigest!, actionId: 'deployments.domains.add',
    } : undefined;
    if (execution) desired.forEach(item => { item.execution = execution; });
    const sameResource = (left: Captures[number], right: Captures[number]) => left.placement.machineId === right.placement.machineId
        && left.placement.installationId === right.placement.installationId && left.placement.nativeServer === right.placement.nativeServer
        && left.listener === right.listener && left.dockerEngineId === right.dockerEngineId
        && isDeepStrictEqual(left.content, right.content)
        && isDeepStrictEqual(left.environmentContent, right.environmentContent)
        && isDeepStrictEqual(left.targetLinkContent, right.targetLinkContent);
    const retained: Captures = oldCaptures.filter(old => !desired.some(item => sameResource(old, item))).map(old => ({ ...old, desired: false,
        ...(execution ? { execution } : {}),
        placement: { ...old.placement, accountId: actorAccountId, actionOperationId: input.actionOperationId, requestId: input.requestId } }));
    if (!membership && previous?.state === 'active' && retained.length === 0 && desired.length === oldCaptures.length) {
        await saveRepeatKey(tx, repeatKey, digest, defaultRepeatKeyExpiresAt(now));
        return domainResult(previous, loaded.row.revision);
    }
    const capturedPlacements = [...retained, ...desired];
    const row = previous ? await tx.deploymentDomain.update({ where: { id: previous.id }, data: {
        targetLinkId: input.targetLinkId, ...deploymentContentReference(input), state: 'pending', capturedPlacements, revision: { increment: 1 },
    } }) : await tx.deploymentDomain.create({ data: { id: input.domainId, environmentId: loaded.row.id,
        targetLinkId: input.targetLinkId, state: 'pending', createdByAccountId: actorAccountId,
        ...deploymentContentReference(input), capturedPlacements } });
    await tx.deploymentEnvironment.update({ where: { id: loaded.row.id }, data: { revision: { increment: 1 } } });
    await saveRepeatKey(tx, repeatKey, digest, defaultRepeatKeyExpiresAt(now));
    await publishDeploymentChangesInTx(tx, 'admission' in loaded ? loaded.admission : loaded, loaded.row.id, loaded.row.revision + 1);
    return domainResult(row, loaded.row.revision + 1);
}

/** Removal admission fills missing read operands while retaining historical captured content. */
async function captureDeploymentDomainRemovalContentInTx(tx: Tx, loaded: AdmittedDeploymentEnvironment,
    jobs: readonly Readonly<{ row: DeploymentDomainRow; captures: Captures }>[],
) {
    const targetLinkIds = [...new Set(jobs.flatMap(job => job.captures
        .filter(capture => !capture.targetLinkContent).map(capture => capture.placement.targetLinkId)))];
    const targetContents = new Map<string, ReturnType<typeof deploymentContentReference>>();
    for (const ids of portableQueryChunks({ values: targetLinkIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        const links = await tx.deploymentTargetLink.findMany({ where: { environmentId: loaded.row.id, id: { in: [...ids] } } });
        for (const link of links) targetContents.set(link.id, deploymentContentReference(link));
    }
    if (targetLinkIds.some(id => !targetContents.has(id))) return null;
    return jobs.map(job => ({ ...job, captures: job.captures.map(capture => ({ ...capture,
        environmentContent: capture.environmentContent ?? deploymentContentReference(loaded.row),
        targetLinkContent: capture.targetLinkContent ?? targetContents.get(capture.placement.targetLinkId)!,
    })) }));
}

/** Both removal entry points retain the same captures and installation custody. */
async function markDeploymentDomainRemovingInTx(tx: Tx, row: DeploymentDomainRow, captures: Captures,
    input: Readonly<{ actorAccountId: string; actionOperationId: string; requestId: string; retireSharedTunnel: boolean;
        binding?: ExternalActionExecutionAuthorizationBindingV1 }>,
) {
    const binding = input.binding;
    return tx.deploymentDomain.update({ where: { id: row.id }, data: { state: 'removing', revision: { increment: 1 },
        capturedPlacements: captures.map(capture => ({ ...publicCapture(capture), retireSharedTunnel: input.retireSharedTunnel,
            installationPublicKey: capture.installationPublicKey,
            ...(binding ? { execution: { controller: { machineId: binding.machineId, installationId: binding.installationId },
                requestEnvelopeDigest: binding.requestEnvelopeDigest!, actionId: 'deployments.domains.remove' as const } } : {}),
            desired: false, placement: { ...capture.placement, accountId: input.actorAccountId,
                actionOperationId: input.actionOperationId, requestId: input.requestId } })) } });
}

/** Teardown's one admission owns every retained Environment Domain, including predecessor links. */
export async function prepareDeploymentTeardownDomainsInTx(tx: Tx, actorAccountId: string,
    actionOperationId: string, loaded: AdmittedDeploymentEnvironment,
    binding?: ExternalActionExecutionAuthorizationBindingV1,
) {
    const rows = await tx.deploymentDomain.findMany({ where: { environmentId: loaded.row.id, deletedAt: null }, orderBy: { id: 'asc' } });
    if (rows.length === 0) return { ok: true as const };
    if (!binding?.requestEnvelopeDigest) return deploymentFailure('unsupported_action');
    if (!loaded.admission.canManage) return deploymentFailure('deployment_access_denied');
    const captured = rows.map(row => ({ row, captures: readCaptures(row), provider: readProviderCapture(row) }));
    if (captured.some(job => !job.captures && !job.provider)) return deploymentFailure('deployment_conflict');
    const jobs = await captureDeploymentDomainRemovalContentInTx(tx, loaded,
        captured.flatMap(job => job.captures ? [{ row: job.row, captures: job.captures }] : []));
    if (!jobs) return deploymentFailure('deployment_conflict');
    const providers = captured.flatMap(job => job.provider ? [{ row: job.row, capture: job.provider }] : []);
    if (providers.length) {
        // Home already admitted this controller. Capture its key once for the retained Domain job.
        const controller = await tx.machine.findUnique({ where: { id: binding.machineId },
            select: { installationId: true, installationPublicKey: true } });
        if (!controller?.installationPublicKey || controller.installationId !== binding.installationId)
            return deploymentMachineUnavailable(binding.machineId, 'controller');
        for (const job of providers) await tx.deploymentDomain.update({ where: { id: job.row.id }, data: {
            state: 'removing', revision: { increment: 1 }, capturedPlacements: { ...job.capture,
                installationPublicKey: encodeBase64(controller.installationPublicKey, 'base64url'),
                requestEnvelopeDigest: binding.requestEnvelopeDigest, placement: { ...job.capture.placement,
                    accountId: actorAccountId, controller: { machineId: binding.machineId, installationId: binding.installationId },
                    actionOperationId, requestId: binding.requestId } } } });
    }
    for (const [index, job] of jobs.entries()) {
        await markDeploymentDomainRemovingInTx(tx, job.row, job.captures, { actorAccountId, actionOperationId,
            requestId: binding.requestId, retireSharedTunnel: index === jobs.length - 1, binding });
    }
    return { ok: true as const };
}

/** Mark exact retained placements removing before the daemon effects; nothing is tombstoned by intent alone. */
export async function removeDeploymentDomainInTx(tx: Tx, actorAccountId: string, input: DeploymentDomainRemoveAdmissionInputV1,
    authentication: DeploymentAuthentication = {},
    executionBinding?: ExternalActionExecutionAuthorizationBindingV1,
) {
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if (!loaded.admission.canManage || loaded.row.deletedAt) return deploymentFailure('deployment_access_denied');
    if (executionBinding && (executionBinding.actionId !== 'deployments.domains.remove' || executionBinding.accountId !== actorAccountId
        || executionBinding.machineId !== loaded.row.controllerMachineId || executionBinding.requestId !== input.requestId
        || executionBinding.serverIdentityId !== input.serverId || !executionBinding.requestEnvelopeDigest)) return deploymentFailure('deployment_access_denied');
    const row = await tx.deploymentDomain.findFirst({ where: { id: input.domainId, environmentId: loaded.row.id } });
    if (!row) return deploymentFailure('deployment_unavailable');
    const now = await readTransactionDatabaseTime(tx);
    const repeatKey = `deployments.domains.remove:${actorAccountId}:${input.environmentId}:${input.requestKey}`;
    const digest = deploymentIntentDigest(input);
    const repeated = await fetchRepeatKey(tx, repeatKey, now);
    if (repeated) return repeated === digest ? domainResult(row, loaded.row.revision) : deploymentFailure('deployment_conflict');
    const provider = readProviderCapture(row);
    if (provider) {
        if (row.deletedAt || row.revision !== input.expectedDomainRevision || loaded.row.revision !== input.expectedRevision)
            return deploymentFailure('deployment_conflict');
        if (!loaded.row.controllerMachineId) return deploymentFailure('deployment_unavailable');
        const controller = await tx.machine.findFirst({ where: { id: loaded.row.controllerMachineId,
            revokedAt: null, replacedByMachineId: null }, select: { id: true, installationId: true, installationPublicKey: true } });
        if (!controller?.installationId || !controller.installationPublicKey
            || executionBinding && executionBinding.installationId !== controller.installationId) return deploymentMachineUnavailable(controller.id, 'controller');
        const changed = await tx.deploymentDomain.update({ where: { id: row.id }, data: { state: 'removing', revision: { increment: 1 },
            capturedPlacements: { ...provider, installationPublicKey: encodeBase64(controller.installationPublicKey, 'base64url'),
                placement: { ...provider.placement, accountId: actorAccountId, controller: {
                    machineId: controller.id, installationId: controller.installationId },
                    actionOperationId: input.actionOperationId, requestId: input.requestId },
                ...(executionBinding?.requestEnvelopeDigest ? { requestEnvelopeDigest: executionBinding.requestEnvelopeDigest } : {}) } } });
        await tx.deploymentEnvironment.update({ where: { id: loaded.row.id }, data: { revision: { increment: 1 } } });
        await saveRepeatKey(tx, repeatKey, digest, defaultRepeatKeyExpiresAt(now));
        await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, loaded.row.revision + 1);
        return domainResult(changed, loaded.row.revision + 1);
    }
    const captures = readCaptures(row);
    if (!captures || row.deletedAt || row.revision !== input.expectedDomainRevision || loaded.row.revision !== input.expectedRevision) {
        return deploymentFailure('deployment_conflict');
    }
    const jobs = await captureDeploymentDomainRemovalContentInTx(tx, loaded, [{ row, captures }]);
    if (!jobs) return deploymentFailure('deployment_conflict');
    // Plan 21 selects one shared tunnel per Environment, whose controller is
    // already held on the Environment row. Private provider content is not an
    // authority for this decision. Retained/removing Domains still consume it.
    const retainedConsumer = await tx.deploymentDomain.findFirst({ where: {
        environmentId: loaded.row.id, deletedAt: null, id: { not: row.id },
    }, select: { id: true } });
    const retireSharedTunnel = retainedConsumer === null;
    const changed = await markDeploymentDomainRemovingInTx(tx, row, jobs[0]!.captures, { actorAccountId,
        actionOperationId: input.actionOperationId, requestId: input.requestId, retireSharedTunnel, binding: executionBinding });
    await tx.deploymentEnvironment.update({ where: { id: loaded.row.id }, data: { revision: { increment: 1 } } });
    await saveRepeatKey(tx, repeatKey, digest, defaultRepeatKeyExpiresAt(now));
    await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, loaded.row.revision + 1);
    return domainResult(changed, loaded.row.revision + 1);
}

/** Commit private vendor provenance and refresh desired operands before the controller dispatches native work. */
export async function prepareDeploymentDomainContentInTx(tx: Tx, actorAccountId: string,
    input: DeploymentDomainPreparedContentInputV1, binding?: ExternalActionExecutionAuthorizationBindingV1,
) {
    const actionId = binding && deploymentChildEffectActionIdForRootV1(binding.actionId, binding.deploymentPreparationAdmission,
        'deployments.domains.add');
    if (!binding || actionId === undefined || !isDeploymentDomainAddActionIdV1(actionId) || binding.accountId !== actorAccountId
        || binding.serverIdentityId !== input.serverId) return deploymentFailure('deployment_access_denied');
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const job = await readAcceptedDeploymentDomainInTx(tx, binding, input);
    if (!job || job.row.state !== 'pending' || !job.capture.desired
        || !isDeepStrictEqual(deploymentContentReference(job.row), input.capture.content)) {
        return deploymentFailure('deployment_conflict');
    }
    const environment = await tx.deploymentEnvironment.findUnique({ where: { id: input.environmentId } });
    const custody = environment ? await readProjectSourceCustodyInTx(tx, environment.projectSourceId) : null;
    if (!environment || !custody) return deploymentFailure('deployment_unavailable');
    const updated = await updateDeploymentStoredContentInTx(tx, actorAccountId, custody,
        input.capture.content, input.contentUpdate, DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1);
    if (!updated.ok) return updated;
    const changed = await tx.deploymentDomain.update({ where: { id: job.row.id }, data: {
        ...updated.reference, capturedPlacements: job.captures.map(capture => capture.desired
            && isDeepStrictEqual(capture.content, input.capture.content) ? { ...capture, content: updated.reference } : capture),
    } });
    await publishDeploymentChangesInTx(tx, custody, environment.id, environment.revision);
    return domainResult(changed, environment.revision);
}

/** Captured installations settle semantic facts; requester departure and current placement edits cannot erase custody. */
export async function transitionDeploymentDomainInTx(tx: Tx, input: DeploymentDomainTransitionInputV1) {
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return deploymentFailure('deployment_unavailable');
    const row = await tx.deploymentDomain.findFirst({ where: { id: input.domainId, environmentId: input.environmentId } });
    const environment = await tx.deploymentEnvironment.findUnique({ where: { id: input.environmentId } });
    if (!row || !environment) return deploymentFailure('deployment_unavailable');
    const provider = readProviderCapture(row);
    if (provider) {
        const observation = input.providerObservation;
        if (!observation || input.observations.length || row.deletedAt || row.revision !== input.expectedDomainRevision)
            return deploymentFailure('deployment_conflict');
        const { proof, ...body } = observation;
        if (!isDeepStrictEqual(body.placement, provider.placement) || !verifyMachineInstallationProof({
            payload: deploymentDomainProviderObservationProofPayloadV1({ expectedDomainRevision: input.expectedDomainRevision, observation: body }),
            proof, publicKey: provider.installationPublicKey })) return deploymentFailure('deployment_access_denied');
        const removed = body.state === 'removed';
        if (removed !== (row.state === 'removing')) return deploymentFailure('deployment_conflict');
        let reference = deploymentContentReference(row);
        const custody = await readProjectSourceCustodyInTx(tx, environment.projectSourceId);
        if (!custody) return deploymentFailure('deployment_unavailable');
        if (body.contentUpdate) {
            const updated = await updateDeploymentStoredContentInTx(tx, provider.placement.accountId, custody,
                reference, body.contentUpdate, DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1);
            if (!updated.ok) return updated;
            reference = updated.reference;
        }
        if (!removed && row.state === body.state && !body.contentUpdate) return domainResult(row, environment.revision);
        const now = await readTransactionDatabaseTime(tx);
        const changed = await tx.deploymentDomain.update({ where: { id: row.id }, data: {
            state: removed ? 'removing' : body.state, ...(removed ? { deletedAt: now } : {}), observedAt: now,
            ...reference, capturedPlacements: { ...provider, content: reference }, revision: { increment: 1 } } });
        await publishDeploymentChangesInTx(tx, custody, environment.id, environment.revision);
        return domainResult(changed, environment.revision);
    }
    if (input.providerObservation) return deploymentFailure('deployment_conflict');
    const captures = readCaptures(row);
    if (!captures || captures.some(capture => !capture.dockerEngineId) || row.deletedAt
        || row.revision !== input.expectedDomainRevision || input.observations.length !== captures.length) {
        return deploymentFailure('deployment_conflict');
    }
    const unused = [...input.observations];
    const observedCaptures: Captures = [];
    for (const capture of captures) {
        const index = unused.findIndex(observation => isDeepStrictEqual(observation.capture, publicCapture(capture)));
        if (index < 0) return deploymentFailure('deployment_access_denied');
        const observation = unused.splice(index, 1)[0]!;
        const { proof, ...body } = observation;
        if (!verifyMachineInstallationProof({ payload: deploymentDomainObservationProofPayloadV1({
            expectedDomainRevision: input.expectedDomainRevision, observation: body }), proof, publicKey: capture.installationPublicKey })) {
            return deploymentFailure('deployment_access_denied');
        }
        if (observation.state === 'removed') {
            if (capture.desired && row.state !== 'removing') return deploymentFailure('deployment_conflict');
            const ids = nativeCaddyDomainRouteIdsV1(row.id, capture.listener);
            if (!observation.removal || !verifyNativeCaddyRemovalProofV1(observation.removal, capture.placement,
                ids.removalIds, decodeBase64(capture.installationPublicKey, 'base64url'))) {
                return deploymentFailure('deployment_access_denied');
            }
        } else if (!capture.desired || row.state === 'removing') return deploymentFailure('deployment_conflict');
        const { networkExposure: _previous, dnsHealth: _previousDns, routedReplicas: _previousReplicas, ...retainedCapture } = capture;
        const routedReplicas = observation.state === 'removed' ? undefined : observation.routedReplicas ?? capture.routedReplicas;
        observedCaptures.push({ ...retainedCapture,
            ...(routedReplicas ? { routedReplicas } : {}),
            ...(observation.networkExposure ? { networkExposure: observation.networkExposure } : {}),
            ...(observation.dnsHealth ? { dnsHealth: observation.dnsHealth } : {}) });
    }
    const deleted = input.observations.every(observation => observation.state === 'removed');
    if (deleted && row.state !== 'removing') return deploymentFailure('deployment_conflict');
    const state = deleted ? 'removing' : input.observations.some(item => item.state === 'failed') ? 'failed'
        : input.observations.some(item => item.state === 'warning'
            || item.capture.desired && item.dnsHealth?.status !== 'up') ? 'warning' : 'active';
    const retained = deleted ? observedCaptures : observedCaptures.filter(item => item.desired);
    // Identical observations are not content changes, freshness writes or publications.
    if (!deleted && state === row.state && isDeepStrictEqual(retained, captures)) return domainResult(row, environment.revision);
    const now = await readTransactionDatabaseTime(tx);
    const changed = await tx.deploymentDomain.update({ where: { id: row.id }, data: { state,
        ...(deleted ? { deletedAt: now } : {}), observedAt: now, capturedPlacements: retained, revision: { increment: 1 } } });
    const custody = await readProjectSourceCustodyInTx(tx, environment.projectSourceId);
    if (custody) await publishDeploymentChangesInTx(tx, custody, environment.id, environment.revision);
    return domainResult(changed, environment.revision);
}

/**
 * The locked cleanup admission reads every non-tombstoned Domain, including
 * removing Domains and Domains on predecessor or detached links. This opens
 * no private content and applies no list-page bound. An empty result is true
 * only for this transaction: Environment revision is not a Domain generation.
 * Every destructive disposal must re-admit here under the same Environment
 * lock; native mutation/removal uses its canonical installed-operation proof.
 */
export async function readDeploymentDomainInventoryInTx(tx: Tx, actorAccountId: string,
    input: Readonly<{ serverId: string; environmentId: string; expectedRevision: number }>,
    authentication: DeploymentAuthentication = {},
    admitted?: Readonly<{ ok: true; row: Readonly<{ id: string; revision: number }> }>,
) {
    // Receipt admission/installation-signed settlement already hold this lock
    // and their authority in this transaction; neither needs another census.
    if (!admitted) await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const loaded = admitted ?? await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if (loaded.row.id !== input.environmentId || loaded.row.revision !== input.expectedRevision) return deploymentFailure('deployment_conflict');
    const rows = await tx.deploymentDomain.findMany({
        where: { environmentId: input.environmentId, deletedAt: null },
        orderBy: { id: 'asc' },
    });
    return { ok: true as const, environmentId: loaded.row.id, environmentRevision: loaded.row.revision,
        domains: rows.map(projectDeploymentDomainHeader),
        capturedMachineIds: rows.every(row => readCaptures(row) !== null)
            ? [...new Set(rows.flatMap(row => readCaptures(row)!.map(capture => capture.placement.machineId)))] : null };
}
