import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * The one final comprehension checkpoint before an Event Automation definition
 * is written. It is derived from the exact resolved facts the writer is about
 * to persist — trigger source, watcher, executors, target, permission effects,
 * and the server-visible webhook fact — so the confirmation cannot describe a
 * different Automation than the one that lands.
 */
export type PluginEventAutomationSubmissionSummary = Readonly<{
    mode: 'create' | 'edit';
    automationName: string;
    enabled: boolean;
    trigger: Readonly<{ pluginId: string; eventLocalId: string }>;
    observation: 'checkpointedPull' | 'durablePush';
    watcherMachineId: string;
    executorMachineIds: readonly string[];
    target:
        | Readonly<{ kind: 'newSession' }>
        | Readonly<{ kind: 'existingSession' }>
        | Readonly<{ kind: 'executionRun'; permissionMode: string }>;
}>;

function targetLine(target: PluginEventAutomationSubmissionSummary['target']): string {
    if (target.kind === 'newSession') {
        return t('automations.form.confirm.targetNewSession');
    }
    if (target.kind === 'existingSession') {
        return t('automations.form.confirm.targetExistingSession');
    }
    return t('automations.form.confirm.targetExecutionRun', { permissionMode: target.permissionMode });
}

/**
 * Pure projection so the confirmation content is testable without a modal host.
 */
export function formatPluginEventAutomationSubmissionConfirmation(
    summary: PluginEventAutomationSubmissionSummary,
): Readonly<{ title: string; message: string; confirmText: string }> {
    const lines = [
        t('automations.form.confirm.trigger', {
            pluginId: summary.trigger.pluginId,
            eventLocalId: summary.trigger.eventLocalId,
        }),
        summary.observation === 'durablePush'
            ? t('automations.form.confirm.observationDurablePush')
            : t('automations.form.confirm.observationCheckpointedPull'),
        t('automations.form.confirm.watcher', { machineId: summary.watcherMachineId }),
        t('automations.form.confirm.executors', { machineIds: summary.executorMachineIds.join(', ') }),
        targetLine(summary.target),
        summary.enabled
            ? t('automations.form.confirm.enabled')
            : t('automations.form.confirm.disabled'),
    ];
    return {
        title: summary.mode === 'edit'
            ? t('automations.form.confirm.editTitle', { name: summary.automationName })
            : t('automations.form.confirm.createTitle', { name: summary.automationName }),
        message: lines.join('\n'),
        confirmText: summary.mode === 'edit'
            ? t('automations.form.confirm.editConfirm')
            : t('automations.form.confirm.createConfirm'),
    };
}

export async function confirmPluginEventAutomationSubmission(
    summary: PluginEventAutomationSubmissionSummary,
): Promise<boolean> {
    const content = formatPluginEventAutomationSubmissionConfirmation(summary);
    return await Modal.confirm(content.title, content.message, { confirmText: content.confirmText });
}
