import type { TriggerTargetV1, WorkflowTriggerSetV1, WorkflowRunSummaryV1 } from '@happier-dev/protocol';

import { t } from '@/text';

import type { TriggerRowOutcome } from './TriggerRow';
import { readTriggerThen } from './sessionTriggerForm';
import { resolveTriggerEventGroup, type TriggerEventGroup } from './triggerEventGroups';
import { formatTriggerSetSummary, formatNextScheduledRun, formatNextScheduledRunAccessibilityLabel, formatTriggerLastOutcome, type ScheduledRunQualifierTime } from './formatTriggerSummary';
import { workflowBlockReferenceLabel, workflowDefinitionPromptTitle } from '@/sync/domains/workflows/workflowBlockLabel';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';

export type SessionTriggerRowModel = Readonly<{
    /** Row identity: the trigger set and the trigger. */
    key: string;
    automationId: string;
    triggerId: WorkflowTriggerSetV1['triggers'][number]['id'];
    /** The set revision a write to this trigger expects. */
    revision: number;
    title: string;
    enabled: boolean;
    outcome: TriggerRowOutcome | null;
    /** The workflow it runs is gone: the row offers only Delete trigger (07 S16). */
    sourceUnavailable: boolean;
    legacy?: boolean;
    qualifier?: string;
    qualifierTime?: ScheduledRunQualifierTime;
    qualifierAccessibilityLabel?: string;
}>;

export type SessionTriggerGroupModel = TriggerEventGroup & Readonly<{ rows: readonly SessionTriggerRowModel[] }>;

/**
 * Where each event reads in the section (lab `convo-W9`): the turn and the session's own moments
 * first, then outside events, then schedules.
 */
function groupRank(group: TriggerEventGroup): number {
    if (group.id === 'lifecycle:turnEnds') return 0;
    if (group.id === 'lifecycle:needsYou') return 1;
    if (group.id === 'lifecycle:sessionStarts') return 2;
    if (group.id.startsWith('event:')) return 3;
    if (group.id.startsWith('schedule:')) return 4;
    return 5;
}

/** A row is named by what it runs (07 S16 presentation item 4). */
export function describeTriggerTarget(target: TriggerTargetV1 | undefined, resolveWorkflowTitle: (ref: string) => string | null): string {
    if (target === undefined) return t('workflows.triggers.row.workflowDeleted');
    const then = readTriggerThen(target);
    switch (then.kind) {
        case 'runWorkflow':
            return then.ref === null ? t('workflows.triggers.then.runWorkflow') : resolveWorkflowTitle(then.ref) ?? then.ref;
        case 'sendPrompt':
            return then.prompt.split('\n')[0]!.trim() || t('workflows.triggers.then.sendPrompt');
        case 'notifyMe':
            return t('workflows.triggers.then.notifyMe');
        case 'doAction':
            return t('workflows.triggers.then.doAction');
        case 'kept':
            if (target.kind !== 'inline') return t('workflows.triggers.then.runWorkflow');
            return workflowDefinitionPromptTitle(target.definition)
                ?? (target.definition.blocks[0] ? workflowBlockReferenceLabel(target.definition.blocks[0])
                    : t('workflows.triggers.row.steps', { count: 0 }));
    }
}

/** Read-only predecessor presentation shared by the column, session and editor. Never write authority. */
export function describeLegacyTriggerSet(set: WorkflowTriggerSetV1, resolveMachineTitle?: (id: string) => string | null): Readonly<{
    title: string; qualifier: string; qualifierTime?: ScheduledRunQualifierTime;
}> | null {
    if (!set.legacy) return null;
    const first = set.target?.kind === 'inline' ? set.target.definition.blocks[0] : undefined;
    const prompt = first?.kind === 'step' ? first.document.text : null;
    const placements = set.legacy.placements ?? (set.project ? [set.project] : null);
    const timezones = [...new Set(set.triggers.flatMap((trigger) => trigger.kind === 'schedule' && trigger.schedule.timezone ? [trigger.schedule.timezone] : []))];
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

/**
 * A session's triggers (03 §5.4, §5.7) as `session.trigger.list` returns them: one row per trigger
 * under its event. A firing timestamp alone never supplies terminal lifecycle;
 * last-result status comes from the accepted Run summary when it is loaded.
 */
export function projectSessionTriggerGroups(params: Readonly<{
    sets: readonly WorkflowTriggerSetV1[];
    lastRunAtByAutomationId: Readonly<Record<string, number | null>>;
    lastRunsByAutomationId?: Readonly<Record<string, WorkflowRunSummaryV1>>;
    resolveWorkflowTitle: (ref: string) => string | null;
    resolveMachineTitle?: (id: string) => string | null;
    formatAge: (at: number) => string;
}>): readonly SessionTriggerGroupModel[] {
    const groups = new Map<string, TriggerEventGroup & { rows: SessionTriggerRowModel[] }>();
    for (const set of params.sets) {
        const legacy = describeLegacyTriggerSet(set, params.resolveMachineTitle);
        const sourceUnavailable = set.health === 'source_unavailable';
        const title = legacy?.title ?? (sourceUnavailable
            ? t('workflows.triggers.row.workflowDeleted')
            : describeTriggerTarget(set.target, params.resolveWorkflowTitle));
        const lastRunAt = params.lastRunAtByAutomationId[set.automationId] ?? null;
        const lastRun = params.lastRunsByAutomationId?.[set.automationId];
        const lastState = lastRun ? describeWorkflowRunState(lastRun.state) : null;
        const lastTone = lastRun && lastState ? resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: lastRun.state, word: lastState.label, inAttentionWindow: lastRun.attentionRequired === true,
        } }).tone : null;
        for (const trigger of set.triggers) {
            const group = resolveTriggerEventGroup(trigger);
            const running = trigger.kind === 'sessionLifecycle'
                && (trigger.status.state === 'running' || trigger.status.state === 'triggered');
            const outcome: TriggerRowOutcome | null = running
                ? { text: t('workflows.triggers.row.running'), tone: 'neutral' }
                : lastState !== null
                    ? { text: lastRunAt === null ? lastState.label : formatTriggerLastOutcome(params.formatAge(lastRunAt), lastState.label), tone: lastTone ?? 'neutral',
                        ...(lastRunAt === null ? {} : { relativeAge: { atMs: lastRunAt, state: lastState.label } }) }
                    : lastRunAt !== null
                    ? { text: formatTriggerLastOutcome(params.formatAge(lastRunAt)), tone: 'neutral', relativeAge: { atMs: lastRunAt } }
                    : null;
            const row: SessionTriggerRowModel = {
                key: `${set.automationId}:${trigger.id}`,
                automationId: set.automationId,
                triggerId: trigger.id,
                revision: set.revision,
                title,
                enabled: set.enabled && trigger.enabled,
                outcome,
                sourceUnavailable,
                ...(legacy ? { legacy: true, qualifier: legacy.qualifier,
                    ...(legacy.qualifierTime ? { qualifierTime: legacy.qualifierTime } : {}) } : trigger.kind === 'schedule' ? {
                    qualifier: formatNextScheduledRun(trigger.nextRunAt, set.enabled && trigger.enabled),
                    ...(trigger.nextRunAt === null ? {} : { qualifierTime: { atMs: trigger.nextRunAt } }),
                    qualifierAccessibilityLabel: formatNextScheduledRunAccessibilityLabel(trigger.nextRunAt, set.enabled && trigger.enabled),
                } : {}),
            };
            const existing = groups.get(group.id);
            if (existing) existing.rows.push(row);
            else groups.set(group.id, { ...group, rows: [row] });
        }
    }
    return [...groups.values()]
        .map((group, order) => ({ group, order }))
        .sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.order - b.order)
        .map(({ group }) => group);
}
