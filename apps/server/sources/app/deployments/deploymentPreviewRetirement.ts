import type { Tx } from '@/storage/inTx';
import { readTransactionDatabaseTime } from '@/storage/transactionDatabaseTime';
import { disableAutomationInTx } from '@/app/automations/automationCrudService';
import { admitAutomationRunsTx } from '@/app/automations/automationRunAdmissionService';
import { AutomationValidationError } from '@/app/automations/automationValidation';
import { acquireWorkflowPublicationLocksInTx } from '@/app/workflows/acquireWorkflowPublicationLocksInTx';
import { lockDeploymentEnvironmentInTx } from './deploymentEnvironmentService';

export async function retireDeploymentPreviewsForSourceReplacementInTx(tx: Tx, input: Readonly<{
    projectSourceId: string;
}>): Promise<void> {
    const templates = await tx.deploymentEnvironment.findMany({ where: {
        projectSourceId: input.projectSourceId, purpose: 'standard', deletedAt: null,
        OR: [{ automations: { some: { deletedAt: null,
            deploymentPreviewRole: { in: ['preview_admission', 'preview_cleanup'] } } } },
        { previewChildren: { some: { deletedAt: null } } }],
    }, select: { id: true }, orderBy: { id: 'asc' } });
    // Child creation and definition mutation take this same existing template lock.
    for (const template of templates) await lockDeploymentEnvironmentInTx(tx, template.id);
    const admissionJobs: { id: string; accountId: string }[] = [];
    const cleanupJobs: { id: string; accountId: string }[] = [];
    for (const template of templates) {
        const jobs = await tx.automation.findMany({ where: { deploymentEnvironmentId: template.id,
            deploymentPreviewRole: { in: ['preview_admission', 'preview_cleanup'] }, deletedAt: null },
        select: { id: true, accountId: true, deploymentPreviewRole: true, enabled: true }, orderBy: { id: 'asc' } });
        admissionJobs.push(...jobs.filter(job => job.deploymentPreviewRole === 'preview_admission' && job.enabled));
        const child = await tx.deploymentEnvironment.findFirst({ where: { previewTemplateEnvironmentId: template.id,
            deletedAt: null }, select: { id: true } });
        if (!child) continue;
        const cleanup = jobs.filter(job => job.deploymentPreviewRole === 'preview_cleanup' && job.enabled);
        if (cleanup.length === 0) throw new AutomationValidationError('Live previews require an enabled cleanup Workflow');
        cleanupJobs.push(...cleanup);
    }
    const changed = [...admissionJobs, ...cleanupJobs];
    if (changed.length === 0) return;
    // Compose the complete existing publication audience before any definition/Run writes.
    await acquireWorkflowPublicationLocksInTx(tx, { accountId: changed[0]!.accountId,
        automationIds: changed.map(job => job.id), runSourceTriggerWhere: { automation: {
            deploymentEnvironment: { projectSourceId: input.projectSourceId },
            deploymentPreviewRole: 'preview_admission', deletedAt: null,
        } } });
    for (const job of admissionJobs) {
        if (!await disableAutomationInTx(tx, { accountId: job.accountId, automationId: job.id })) {
            throw new AutomationValidationError('Preview admission Workflow is unavailable');
        }
    }
    const now = await readTransactionDatabaseTime(tx);
    const owners = [...new Set(cleanupJobs.map(job => job.accountId))].sort();
    for (const accountId of owners) {
        const admitted = await admitAutomationRunsTx({ tx, accountId,
            admissions: cleanupJobs.filter(job => job.accountId === accountId).map(job => ({
                automationId: job.id, now, cause: { kind: 'manual', invokedAt: now.getTime() },
                // The successful Source CAS already admits this transaction once.
                // A public manual retry key could rejoin an older completed Run.
            })) });
        if (admitted.some(result => result.kind === 'ineligible')) {
            throw new AutomationValidationError('Preview cleanup Workflow could not be admitted');
        }
    }
}
