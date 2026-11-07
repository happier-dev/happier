import { isDeepStrictEqual } from 'node:util';
import { DeploymentPendingDeployStoredV1Schema, type DeploymentDeployAdmissionInputV1, type DeploymentReceiptResultV1,
    DeploymentPendingAdmissionV1Schema, type DeploymentPendingAdmissionV1, type DeploymentPendingCancelInputV1 } from '@happier-dev/protocol';
import { z } from 'zod/mini';
import { ActionOperationAddressV1Schema } from '@happier-dev/protocol/actions/specs/actionOperations';
import { jsonPathEquals } from '@/storage/jsonPathFilter';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/deployment-protocol';
import { getActivePrismaRuntime } from '@/storage/prisma';
import type { Tx } from '@/storage/inTx';
import { deploymentFailure, canDeployDeploymentEnvironment, type DeploymentAuthentication } from './deploymentAdmission';
import { loadDeploymentEnvironmentInTx, lockDeploymentEnvironmentInTx,
    type DeploymentEnvironmentRow } from './deploymentEnvironmentService';
import { admitDeploymentStoredContentInTx } from './deploymentStoredContent';
import { publishDeploymentChangesInTx } from './deploymentPublication';

type PendingAdmission = Extract<DeploymentReceiptResultV1, { ok: false }>
    | Readonly<{ ok: true; take: boolean }>
    | Readonly<{ ok: true; changed: boolean; result: Extract<DeploymentReceiptResultV1, { kind: 'pending' }> }>;

const storedPending = z.strictObject({ pendingDeploy: DeploymentPendingDeployStoredV1Schema,
    admission: z.optional(DeploymentPendingAdmissionV1Schema) });

/** A malformed retained envelope is unavailable, never an absent desired intent. */
export function readDeploymentPendingContent(row: Pick<DeploymentEnvironmentRow, 'pendingDeployContent'>) {
    if (row.pendingDeployContent === null) return { ok: true as const, pendingDeploy: undefined };
    const captured = storedPending.safeParse(row.pendingDeployContent);
    if (captured.success) return { ok: true as const, pendingDeploy: captured.data.pendingDeploy,
        ...(captured.data.admission ? { pendingAdmission: captured.data.admission } : {}) };
    return deploymentFailure('deployment_content_unavailable');
}

/** Fresh cancellation clears only the observed intent, never an effecting receipt or newer replacement. */
export async function cancelDeploymentPendingInTx(tx: Tx, actorAccountId: string,
    input: DeploymentPendingCancelInputV1, authentication: DeploymentAuthentication = {},
    binding?: ExternalActionExecutionAuthorizationBindingV1,
) {
    if (!binding || binding.actionId !== 'action.operations.cancel' || binding.accountId !== actorAccountId
        || binding.serverIdentityId !== input.serverId || binding.target.kind !== 'machine'
        || binding.target.machineId !== binding.machineId) return deploymentFailure('deployment_access_denied');
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if (!canDeployDeploymentEnvironment(loaded.admission, loaded.row)) return deploymentFailure('deployment_access_denied');
    const retained = readDeploymentPendingContent(loaded.row);
    if (!retained.ok) return retained;
    const admission = 'pendingAdmission' in retained ? retained.pendingAdmission : undefined;
    if (admission && (admission.requesterAccountId !== actorAccountId
        || admission.serverId !== input.serverId || binding.machineId !== admission.controller.machineId
        || binding.installationId !== admission.controller.installationId)) return deploymentFailure('deployment_access_denied');
    if (admission && admission.actionOperationId !== input.actionOperationId) return deploymentFailure('deployment_conflict');
    const contentFailure = await admitDeploymentStoredContentInTx(tx, actorAccountId, loaded.admission.owner,
        loaded.row, DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, 'read', input.pendingDeploy);
    if (contentFailure) return contentFailure;
    if (loaded.row.revision !== input.expectedRevision || !isDeepStrictEqual(retained.pendingDeploy, input.pendingDeploy)
        || input.pendingDeploy.t === 'plain' && input.pendingDeploy.v.actionOperationId !== input.actionOperationId) {
        return deploymentFailure('deployment_conflict');
    }
    // E2EE operation association is opened and bound by the accepted host;
    // storage retains current Source rights and exact pending ciphertext/CAS.
    const changed = await tx.deploymentEnvironment.updateMany({ where: { id: loaded.row.id, revision: input.expectedRevision },
        data: { pendingDeployContent: getActivePrismaRuntime().DbNull, revision: { increment: 1 } } });
    if (changed.count !== 1) throw new Error('Locked deployment Environment changed during pending cancellation');
    const revision = input.expectedRevision + 1;
    await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, revision);
    return { ok: true as const, environmentId: loaded.row.id, revision };
}

/** The retained admission is the cold locator; current controller placement
 * may have changed without moving this already admitted pending intent. */
export async function cancelDeploymentPendingOperationInTx(tx: Tx, actorAccountId: string,
    input: z.infer<typeof ActionOperationAddressV1Schema>, binding: ExternalActionExecutionAuthorizationBindingV1 | undefined,
    authentication: DeploymentAuthentication = {},
) {
    if (!binding || input.machineId !== binding.machineId) return deploymentFailure('deployment_access_denied');
    const row = await tx.deploymentEnvironment.findFirst({
        where: { AND: [
            { pendingDeployContent: jsonPathEquals(['admission', 'actionOperationId'], input.operationId) },
            { pendingDeployContent: jsonPathEquals(['admission', 'requesterAccountId'], actorAccountId) },
            { pendingDeployContent: jsonPathEquals(['admission', 'serverId'], input.serverId) },
            { pendingDeployContent: jsonPathEquals(['admission', 'controller', 'machineId'], input.machineId) },
            { pendingDeployContent: jsonPathEquals(['admission', 'controller', 'installationId'], binding.installationId) },
        ] },
        select: { id: true, revision: true, pendingDeployContent: true },
    });
    if (!row) return { kind: 'not_found' as const };
    const retained = readDeploymentPendingContent(row);
    if (!retained.ok) return retained;
    if (!retained.pendingDeploy) return { kind: 'not_found' as const };
    const result = await cancelDeploymentPendingInTx(tx, actorAccountId, {
        serverId: input.serverId, environmentId: row.id, expectedRevision: row.revision,
        actionOperationId: input.operationId, pendingDeploy: retained.pendingDeploy,
    }, authentication, binding);
    return result.ok ? { kind: 'requested' as const } : result;
}

/** Same receipt admission transaction owns replacement and take; no effect or background work runs here. */
export async function admitDeploymentPendingInTx(tx: Tx, row: DeploymentEnvironmentRow,
    input: DeploymentDeployAdmissionInputV1, busy: boolean, actorAccountId: string,
    binding?: ExternalActionExecutionAuthorizationBindingV1,
): Promise<PendingAdmission> {
    const retained = readDeploymentPendingContent(row);
    if (!retained.ok) return retained;
    const pending = input.pendingDeploy;
    if (!pending) return busy ? deploymentFailure('deployment_invalid')
        : retained.pendingDeploy ? deploymentFailure('deployment_conflict') : { ok: true as const, take: false };
    if ('pendingAdmission' in retained && retained.pendingAdmission
        && isDeepStrictEqual(retained.pendingDeploy, pending)) {
        const captured = retained.pendingAdmission;
        if (captured.requesterAccountId !== actorAccountId) return deploymentFailure('deployment_access_denied');
        if (captured.serverId !== input.serverId || captured.requestKey !== input.requestKey
            || captured.actionOperationId !== input.actionOperationId) return deploymentFailure('deployment_conflict');
        if (!binding || binding.accountId !== actorAccountId || binding.serverIdentityId !== captured.serverId
            || binding.actionId !== 'deployments.deploy' || binding.target.kind !== 'machine'
            || binding.target.machineId !== captured.controller.machineId || binding.machineId !== captured.controller.machineId
            || binding.installationId !== captured.controller.installationId) return deploymentFailure('deployment_access_denied');
        if (busy) return { ok: true as const, changed: false as const, result: { ok: true as const,
            environmentId: row.id, revision: row.revision, kind: 'pending' as const, actionOperationId: captured.actionOperationId } };
    }
    // Occurrence authentication/order belongs to Automation's producer, which has
    // not yet supplied storage admission. An asserted reference confers no authority.
    if (pending.t === 'plain' && pending.v.triggerOccurrence) return deploymentFailure('unsupported_action');
    if (row.revision !== input.expectedRevision) return deploymentFailure('deployment_conflict');
    if (!busy) {
        // A controller re-admits the exact protected intent under current grants
        // and row/link/Artifact CAS before this field is taken with receipt create.
        if (retained.pendingDeploy && !isDeepStrictEqual(retained.pendingDeploy, pending)) return deploymentFailure('deployment_conflict');
        return { ok: true as const, take: retained.pendingDeploy !== undefined };
    }
    const revision = input.expectedRevision + 1;
    // Only a successful locked CAS commits this exact revision and stamp.
    const admission: DeploymentPendingAdmissionV1 | undefined = binding ? DeploymentPendingAdmissionV1Schema.parse({
        requesterAccountId: actorAccountId, serverId: binding.serverIdentityId, requestKey: input.requestKey,
        actionOperationId: input.actionOperationId, controller: { machineId: binding.machineId, installationId: binding.installationId },
        environmentRevision: revision,
    }) : undefined;
    const changed = await tx.deploymentEnvironment.updateMany({ where: { id: row.id, revision: input.expectedRevision },
        data: { pendingDeployContent: { pendingDeploy: pending, ...(admission ? { admission } : {}) }, revision: { increment: 1 } } });
    if (changed.count !== 1) throw new Error('Locked deployment Environment changed during pending replacement');
    return { ok: true as const, changed: true as const, result: { ok: true as const, environmentId: row.id,
        revision, kind: 'pending' as const, actionOperationId: input.actionOperationId } };
}
