import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol';
import { parseAutomationObservationOnlyDefinitionV1 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import type { Tx } from '@/storage/inTx';
import { admitDeploymentMachineInTx, type DeploymentAuthentication } from '@/app/deployments/deploymentAdmission';
import { loadDeploymentEnvironmentInTx, lockDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { AutomationValidationError } from './automationValidation';
import { disableAutomationInTx } from './automationCrudService';
import { acquireWorkflowPublicationLocksInTx } from '@/app/workflows/acquireWorkflowPublicationLocksInTx';

/** Environment lifecycle withdraws its existing definitions through the Automation publication owner. */
export async function disableDeploymentEnvironmentAutomationsInTx(tx: Tx, environmentId: string,
    options: Readonly<{ observationOnly?: boolean }> = {},
): Promise<void> {
    const candidates = await tx.automation.findMany({ where: { deploymentEnvironmentId: environmentId, deletedAt: null, enabled: true },
        select: { id: true, accountId: true, templateCiphertext: true }, orderBy: { id: 'asc' } });
    const jobs = options.observationOnly ? candidates.filter(row => parseAutomationObservationOnlyDefinitionV1(row.templateCiphertext)) : candidates;
    if (!jobs.length) return;
    await acquireWorkflowPublicationLocksInTx(tx, { accountId: jobs[0]!.accountId,
        automationIds: jobs.map(job => job.id), runSourceTriggerWhere: { automation: { deploymentEnvironmentId: environmentId } } });
    for (const job of jobs) {
        if (!await disableAutomationInTx(tx, { accountId: job.accountId, automationId: job.id })) {
            throw new Error('Deployment disposition lost locked Automation authority');
        }
    }
}

/** The immutable Environment relationship is locked before the existing Automation publication locks. */
export async function lockAutomationDeploymentEnvironmentInTx(tx: Tx,
    input: Readonly<{ automationId?: string; deploymentEnvironment?: DeploymentEnvironmentRefV1 }>,
): Promise<void> {
    const existing = input.automationId ? await tx.automation.findUnique({ where: { id: input.automationId },
        select: { deploymentEnvironmentId: true } }) : null;
    const environmentId = existing?.deploymentEnvironmentId ?? input.deploymentEnvironment?.environmentId;
    if (environmentId) await lockDeploymentEnvironmentInTx(tx, environmentId);
}

/** Existing V3 authoring admits one Source-managed Environment; later edits retain that relationship. */
export async function admitAutomationDeploymentEnvironmentInTx(tx: Tx, input: Readonly<{
    accountId: string;
    authentication?: DeploymentAuthentication;
    deploymentEnvironment?: DeploymentEnvironmentRefV1;
    existing?: Readonly<{ deploymentEnvironmentId?: string | null; deploymentPreviewRole?: string | null }>;
    /** Pure removal or pause uses the Automation owner's Account custody, without Source admission. */
    removal?: true;
}>): Promise<Readonly<{ reference: DeploymentEnvironmentRefV1 }> | null> {
    // Cleanup callers load the Automation by accountId; withdrawing their own
    // definition neither authors the Environment nor needs current Source manage.
    if (input.removal) return null;
    const existingId = input.existing?.deploymentEnvironmentId ?? null;
    const existingRole = input.existing?.deploymentPreviewRole ?? null;
    const requested = input.deploymentEnvironment;
    if (input.existing && requested && requested.environmentId !== existingId) {
        throw new AutomationValidationError('An Automation Environment relationship cannot be changed');
    }
    if (input.existing && requested?.previewRole !== undefined && requested.previewRole !== existingRole) {
        throw new AutomationValidationError('An Automation preview role cannot be changed');
    }
    const previewRole = requested?.previewRole ?? existingRole;
    if (previewRole !== null && previewRole !== 'preview_admission' && previewRole !== 'preview_cleanup') {
        throw new AutomationValidationError('Automation preview role is unavailable');
    }
    const environmentId = existingId ?? requested?.environmentId;
    if (!environmentId) return null;
    const serverId = await readCurrentServerIdentityId(process.env, tx);
    if (!serverId || requested && requested.serverId !== serverId) {
        throw new AutomationValidationError('Automation Environment is unavailable');
    }
    const loaded = await loadDeploymentEnvironmentInTx(tx, input.accountId, serverId, environmentId, input.authentication);
    if (!loaded.ok || loaded.row.deletedAt || !loaded.admission.canManage
        || previewRole && loaded.row.purpose !== 'standard'
        || requested && requested.projectSourceId !== loaded.row.projectSourceId) {
        throw new AutomationValidationError('Automation Environment management is unavailable');
    }
    if (!input.existing && await admitDeploymentMachineInTx(tx, loaded.admission.owner, loaded.row.controllerMachineId, 'controller')) {
        throw new AutomationValidationError('Automation Environment controller is unavailable');
    }
    return { reference: { serverId, projectSourceId: loaded.row.projectSourceId, environmentId: loaded.row.id,
        ...(previewRole ? { previewRole } : {}) } };
}

/** Public mutations keep Account custody; authoring and manual runs also require Source authority. */
export async function admitAutomationDeploymentMutationInTx(tx: Tx, input: Readonly<{
    accountId: string;
    automationId: string;
    authentication?: DeploymentAuthentication;
    removal?: true;
}>): Promise<void> {
    const existing = await tx.automation.findFirst({ where: { id: input.automationId, accountId: input.accountId, deletedAt: null },
        select: { deploymentEnvironmentId: true, deploymentPreviewRole: true } });
    if (!existing?.deploymentEnvironmentId) return;
    await lockDeploymentEnvironmentInTx(tx, existing.deploymentEnvironmentId);
    await admitAutomationDeploymentEnvironmentInTx(tx, { accountId: input.accountId, authentication: input.authentication, existing,
        ...(input.removal ? { removal: true } : {}) });
}

/** The shared assignment owner rejects every independent move of an Environment-created Automation. */
export async function admitAutomationDeploymentAssignmentsInTx(tx: Tx, input: Readonly<{
    accountId: string;
    actorAccountId?: string;
    authentication?: DeploymentAuthentication;
    automationId: string;
    assignments: readonly Readonly<{ machineId: string; enabled?: boolean }>[];
}>): Promise<boolean> {
    const automation = await tx.automation.findUnique({ where: { id: input.automationId },
        select: { deploymentEnvironmentId: true, templateCiphertext: true } });
    if (!automation?.deploymentEnvironmentId) return false;
    const serverId = await readCurrentServerIdentityId(process.env, tx);
    if (!serverId) throw new AutomationValidationError('Automation Environment is unavailable');
    const loaded = await loadDeploymentEnvironmentInTx(tx, input.actorAccountId ?? input.accountId, serverId,
        automation.deploymentEnvironmentId, input.authentication);
    if (!loaded.ok || loaded.row.deletedAt || !loaded.admission.canManage) {
        throw new AutomationValidationError('Automation Environment management is unavailable');
    }
    const environment = loaded.row;
    const observationOnly = parseAutomationObservationOnlyDefinitionV1(automation.templateCiphertext) !== null;
    if (observationOnly ? input.assignments.length !== 0 : input.assignments.length !== 1
        || input.assignments[0]?.machineId !== environment.controllerMachineId) {
        throw new AutomationValidationError('Change the Environment controller to move this Automation');
    }
    if (await admitDeploymentMachineInTx(tx, loaded.admission.owner, environment.controllerMachineId, 'controller')) {
        throw new AutomationValidationError('Automation Environment controller is unavailable');
    }
    return true;
}
