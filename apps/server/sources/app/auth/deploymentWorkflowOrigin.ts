import type { ExternalActionExecutionAuthorizationBindingV1, ExternalActionTargetV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';
import { DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1,
    DEPLOYMENT_TEARDOWN_ACTION_ID_V1,
    DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { isAutomationOriginRunPublisherTx } from '@/app/automations/automationTriggerCauseChain';
import { canDeployDeploymentEnvironment, canTeardownDeploymentEnvironment, admitDeploymentMachineInTx } from '@/app/deployments/deploymentAdmission';
import { loadDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import type { Tx } from '@/storage/inTx';
import { hasAcceptedDeploymentReceiptInTx, type DeploymentReceiptContinuation } from '@/app/deployments/deploymentAcceptedExecution';
import { isAdmittedTemplateInstantiationScopeCurrentInTx, isTemplateInstantiationAuthorizedInTx } from '@/app/deployments/deploymentPreparationAuthorization';

export type MachineWorkflowOriginPhase = 'admission' | 'execution';

export type DeploymentWorkflowOriginInput = Readonly<{
    accountId: string; machineId: string; actionId: string; requestId: string; target: ExternalActionTargetV1;
    requestEnvelopeDigest?: string; idempotencyKey?: string; publisherMachineId?: string;
    serverIdentityId?: string; installationId?: string; custodianAccountId?: string; environmentId?: string;
    admittedMachineRole?: ExternalActionExecutionAuthorizationBindingV1['admittedMachineRole'];
    authentication?: Readonly<{ evidence?: readonly AuthTokenAuthenticationEvidenceV1[] }>;
    deploymentNativeAdmission?: Readonly<{ environmentId: string }>;
    deploymentCandidatePublication?: ExternalActionExecutionAuthorizationBindingV1['deploymentCandidatePublication'];
    deploymentPreparationAdmission?: ExternalActionExecutionAuthorizationBindingV1['deploymentPreparationAdmission'];
    workflowActionOrigin?: ExternalActionExecutionAuthorizationBindingV1['workflowActionOrigin'];
}>;

/** Home proves accepted Run placement; the receiving daemon opens and matches its exact child. */
export async function readCurrentMachineWorkflowOriginInTx(reader: Tx, input: Readonly<{
    accountId: string; machineId: string; requestId: string; target: ExternalActionTargetV1;
    requestEnvelopeDigest?: string; publisherMachineId?: string;
    installationId?: string; custodianAccountId?: string;
    workflowActionOrigin?: ExternalActionExecutionAuthorizationBindingV1['workflowActionOrigin'];
}>, phase: MachineWorkflowOriginPhase = 'admission'): Promise<Readonly<{
    installationId: string; accountId: string;
}> | null> {
    const origin = input.workflowActionOrigin;
    if (!origin || origin.requestId !== input.requestId || !input.requestEnvelopeDigest || input.target.kind !== 'machine') return null;
    const run = await reader.automationRun.findFirst({ where: { id: origin.runId,
        workflowAcceptedSnapshotEnvelope: { not: null } }, select: {
        accountId: true, state: true, claimedByMachineId: true, workflowCustodyState: true,
    } });
    if (!run || run.accountId !== input.accountId || !run.claimedByMachineId
        || !(phase === 'execution' ? ['claimed', 'running', 'paused'] : ['claimed', 'running']).includes(run.state)
        || run.workflowCustodyState !== 'pending'
        || input.publisherMachineId !== undefined && input.publisherMachineId !== run.claimedByMachineId
        || !await isAutomationOriginRunPublisherTx(reader, { accountId: input.accountId,
            machineId: run.claimedByMachineId, runId: origin.runId, requireCurrentScopeEnd: true })) return null;
    // Minting names the signed publisher; verification names the installed
    // receiver. Both retain the same claimed publisher above.
    if (input.machineId !== run.claimedByMachineId && input.machineId !== input.target.machineId) return null;
    const [source, target] = await Promise.all([
        reader.machine.findFirst({ where: { id: run.claimedByMachineId, accountId: input.accountId,
            revokedAt: null, replacedByMachineId: null }, select: { installationId: true } }),
        reader.machine.findFirst({ where: { id: input.target.machineId,
            revokedAt: null, replacedByMachineId: null }, select: { installationId: true, accountId: true } }),
    ]);
    if (!source?.installationId || !target?.installationId
        || input.custodianAccountId !== undefined && input.custodianAccountId !== target.accountId
        || input.installationId !== undefined && input.installationId !== target.installationId) return null;
    return { installationId: target.installationId, accountId: target.accountId };
}

/** Installed Run provenance is not approval. The receiver owns materialization and consent. */
export async function hasCurrentDeploymentWorkflowOriginInTx(reader: Tx, input: DeploymentWorkflowOriginInput,
    continuation?: DeploymentReceiptContinuation, phase: MachineWorkflowOriginPhase = 'admission'): Promise<boolean> {
    const origin = input.workflowActionOrigin;
    if (!origin || origin.requestId !== input.requestId || !input.requestEnvelopeDigest || input.target.kind !== 'machine') return false;
    if (continuation) return hasAcceptedDeploymentReceiptInTx(reader, input, continuation);
    const target = await readCurrentMachineWorkflowOriginInTx(reader, input, phase);
    if (!target) return false;
    // Mint admitted definition Manage. Move runs finite SCM work on the selected
    // workspace; the active Run and installed receiver retain that admission.
    if (input.actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1) return input.environmentId !== undefined;
    // Prepare is source/workspace work; its existing preparation admission owns
    // those operands and does not require an Environment to exist yet.
    if (input.actionId === 'deployments.prepare') return input.deploymentPreparationAdmission?.operation === 'prepare';
    // Create's mint owns Source admission; its installed Run may precede the child Environment.
    if (input.actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) return input.deploymentPreparationAdmission?.operation === 'create';
    if (input.actionId === 'deployments.templates.instantiate') {
        const admission = input.deploymentPreparationAdmission;
        if (admission?.operation !== 'template') return false;
        if (phase === 'execution') return isAdmittedTemplateInstantiationScopeCurrentInTx(reader, {
            ...input, machineId: input.target.machineId,
        }, admission);
        return isTemplateInstantiationAuthorizedInTx(reader, {
            ...input, serverIdentityId: input.serverIdentityId ?? await getOrCreateServerIdentityId(),
            machineId: input.target.machineId, installationId: target.installationId,
        }, admission, { authenticationAuthority: 'account_automation', authenticationEvidence: input.authentication?.evidence });
    }
    const scope = input.deploymentCandidatePublication;
    const environmentId = input.deploymentNativeAdmission?.environmentId ?? input.environmentId ?? scope?.environmentId;
    if (!environmentId || scope && scope.environmentId !== environmentId) return false;
    const environment = await loadDeploymentEnvironmentInTx(reader, input.accountId,
        input.serverIdentityId ?? await getOrCreateServerIdentityId(), environmentId, {
            authenticationAuthority: 'account_automation', authenticationEvidence: input.authentication?.evidence,
        }, phase === 'execution' ? { environmentId } : undefined);
    const teardown = input.actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1;
    if (!environment.ok || !teardown && environment.row.deletedAt
        || phase === 'admission' && !(teardown
            ? canTeardownDeploymentEnvironment(environment.admission, environment.row)
            : canDeployDeploymentEnvironment(environment.admission, environment.row))
        || scope && (scope.source.id !== environment.admission.source.id || scope.source.revision !== environment.admission.source.revision)
        || environment.row.controllerMachineId !== input.target.machineId) return false;
    if (!teardown) {
        const link = await reader.deploymentTargetLink.findFirst({ where: { id: environment.row.runtimeTargetLinkId ?? '',
            environmentId, role: 'runtime', deletedAt: null, detachedAt: null }, select: { id: true } });
        if (!link) return false;
    }
    if (phase === 'admission' && await admitDeploymentMachineInTx(reader, environment.admission.owner,
        input.target.machineId, 'controller', target.installationId)) return false;
    return true;
}
