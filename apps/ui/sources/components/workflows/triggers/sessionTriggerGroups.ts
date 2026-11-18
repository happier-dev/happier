import type { TriggerTargetV1} from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { isWorkflowTriggerSourceGoneV1 as isWorkflowTriggerSourceGone } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { workflowTriggerDisplayNameV1 } from '@happier-dev/protocol/workflows/workflowStepLabel';

import { t } from '@/text';

import { formatTriggerSetSummary, formatNextScheduledRun, type ScheduledRunQualifierTime } from './formatTriggerSummary';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';

/**
 * The one reading of the source-lookup result. The lookup answers the same not-found for a deleted Workflow
 * and for access withdrawn from it, so what a surface draws for this state stays neutral and identical
 * for both. A retained 0.2 automation keeps its own locked copy.
 */
export { isWorkflowTriggerSourceGone };

/** A row is named by what it runs (07 S16 presentation item 4). */
export function describeTriggerTarget(target: TriggerTargetV1 | undefined, resolveWorkflowTitle: (ref: string) => string | null): string {
    return workflowTriggerDisplayNameV1({ target }, {
        then: { runWorkflow: t('workflows.triggers.then.runWorkflow'), sendPrompt: t('workflows.triggers.then.sendPrompt'),
            notifyMe: t('workflows.triggers.then.notifyMe'), doAction: t('workflows.triggers.then.doAction') },
        block: workflowBlockReferenceLabel, resolveWorkflowTitle,
        empty: t('workflows.triggers.row.steps', { count: 0 }),
    }) ?? t('workflows.triggers.row.workflowUnavailable');
}

/** Read-only predecessor presentation shared by the column, session and editor. Never write authority. */
export function describeLegacyTriggerSet(set: WorkflowTriggerSetV1, resolveMachineTitle?: (id: string) => string | null): Readonly<{
    title: string; qualifier: string; qualifierTime?: ScheduledRunQualifierTime;
}> | null {
    if (!set.legacy) return null;
    const first = set.target?.kind === 'inline' ? set.target.definition.blocks[0] : undefined;
    const prompt = first?.kind === 'step' ? first.document.text : null;
    const placements = set.legacy.placements ?? (set.project ? [set.project] : null);
    const timezones = [...new Set(set.triggers.flatMap((trigger) => trigger.kind === 'schedule' && trigger.schedule.kind !== 'once' && trigger.schedule.timezone ? [trigger.schedule.timezone] : []))];
    const nextRuns = set.triggers.flatMap((trigger) => trigger.kind === 'schedule' && trigger.nextRunAt !== null ? [trigger.nextRunAt] : []);
    const next = nextRuns.length === 0 ? null : Math.min(...nextRuns);
    const prefix = [formatTriggerSetSummary(set.triggers), ...timezones].join(' · ');
    const suffix = [
        placements === null ? null : `${t('workflows.triggers.editor.runsOn')}: ${placements.length === 1 ? '' : t('workflows.triggers.row.machines', { count: placements.length })}`,
        ...(placements ?? []).map((placement) => `${resolveMachineTitle?.(placement.machineId) ?? placement.machineId} · ${placement.directory}`),
        t('workflows.triggers.row.legacyCreated'),
    ].filter(Boolean).join('\n');
    return {
        title: set.legacy.lockedReason === 'session_key_required' ? t('workflows.triggers.row.sessionKeyRequired')
            : set.legacy.lockedReason === 'migration_required' ? t('workflows.triggers.row.templateRecoveryRequired')
                : set.legacy.lockedReason === 'decryption_failed' ? t('workflows.triggers.row.templateDecryptionFailed')
                    : prompt === null ? t('workflows.triggers.row.legacyUnavailable') : prompt || t('workflows.triggers.then.sendPrompt'),
        qualifier: [prefix,
            formatNextScheduledRun(next, set.enabled && set.triggers.some((trigger) => trigger.enabled && trigger.kind === 'schedule')),
            suffix,
        ].filter(Boolean).join('\n'),
        ...(next === null ? {} : { qualifierTime: { atMs: next, prefix, suffix } }),
    };
}
