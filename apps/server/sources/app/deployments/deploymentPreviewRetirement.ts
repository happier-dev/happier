import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { readTransactionDatabaseTime } from '@/storage/transactionDatabaseTime';
import { disableAutomationInTx } from '@/app/automations/automationCrudService';
import { admitAutomationRunsTx } from '@/app/automations/automationRunAdmissionService';
import { AutomationValidationError } from '@/app/automations/automationValidation';
import { acquireWorkflowPublicationLocksInTx } from '@/app/workflows/acquireWorkflowPublicationLocksInTx';
import { lockDeploymentEnvironmentInTx } from './deploymentEnvironmentService';

/**
 * The Source CAS calls this only for a changed repository, before publication.
 * Throwing is intentional: a cleanup refusal must unwind the Source CAS too.
 */
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
    const templateIds = templates.map(template => template.id);
    for (const ids of portableQueryChunks({ values: templateIds, bindingsPerValue: 1, fixedBindings: 3 })) {
        const jobs = await tx.automation.findMany({ where: { deploymentEnvironmentId: { in: [...ids] },
            deploymentPreviewRole: { in: ['preview_admission', 'preview_cleanup'] }, deletedAt: null, enabled: true },
        select: { id: true, accountId: true, deploymentEnvironmentId: true, deploymentPreviewRole: true }, orderBy: { id: 'asc' } });
        const live = await tx.deploymentEnvironment.groupBy({ by: ['previewTemplateEnvironmentId'],
            where: { previewTemplateEnvironmentId: { in: [...ids] }, deletedAt: null } });
        const liveTemplates = new Set(live.map(child => child.previewTemplateEnvironmentId));
        const cleanupByTemplate = new Map<string, typeof cleanupJobs>();
        const admissionByTemplate = new Map<string, typeof admissionJobs>();
        for (const job of jobs) {
            if (job.deploymentEnvironmentId === null) continue;
            const byTemplate = job.deploymentPreviewRole === 'preview_admission' ? admissionByTemplate : cleanupByTemplate;
            const forTemplate = byTemplate.get(job.deploymentEnvironmentId) ?? [];
            forTemplate.push({ id: job.id, accountId: job.accountId });
            byTemplate.set(job.deploymentEnvironmentId, forTemplate);
        }
        for (const id of ids) {
            admissionJobs.push(...admissionByTemplate.get(id) ?? []);
            if (!liveTemplates.has(id)) continue;
            const cleanup = cleanupByTemplate.get(id);
            if (!cleanup?.length) throw new AutomationValidationError('Live previews require an enabled cleanup Workflow');
            cleanupJobs.push(...cleanup);
        }
    }
    const changed = [...admissionJobs, ...cleanupJobs];
    if (changed.length === 0) return;
    // Compose the complete existing publication audience before any definition/Run writes.
    await acquireWorkflowPublicationLocksInTx(tx, { accountId: changed[0]!.accountId,
        automationIds: changed.map(job => job.id), sourceTriggerWhere: { automation: {
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
