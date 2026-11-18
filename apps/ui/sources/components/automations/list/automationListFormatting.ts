import type {
    AutomationRunCause} from '@happier-dev/protocol/automations/run-cause';
import type {
    AutomationRunStateV3} from '@happier-dev/protocol/automations/automationRunStateV3';
import type {
    AutomationSessionLifecycleEvent,
    AutomationSessionLifecyclePolicy,
    AutomationSessionLifecyclePolicySnapshot} from '@happier-dev/protocol/automations/automationSessionLifecycle';
import type {
    AutomationSessionLifecycleTriggerStatus,
    AutomationTriggerListItem,
} from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import { hasTranslation, t, tLoose, type TranslationKey } from '@/text';
import { formatTriggerSummary, readActionTriggerSummaryFacts } from '@/components/workflows/triggers/formatTriggerSummary';
import { formatOnceScheduleStateLabel, readOnceScheduleState } from '@/components/workflows/triggers/triggerSchedule';
import type { AutomationV3RunListItem } from '@happier-dev/protocol/automations/automationApiV3';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';

export function formatAutomationSessionLifecycleEventLabel(
    event: AutomationSessionLifecycleEvent,
): string {
    return t(`automations.pluralEditor.lifecycleEvent.${event}`);
}

function formatAutomationSessionLifecycleEventSetLabel(
    events: ReadonlyArray<AutomationSessionLifecycleEvent>,
): string {
    return events.map(formatAutomationSessionLifecycleEventLabel).join(' · ');
}

function formatAutomationSessionLifecyclePolicyLabel(
    policy: AutomationSessionLifecyclePolicy | AutomationSessionLifecyclePolicySnapshot,
): string {
    const label = t(`automations.pluralEditor.lifecyclePolicy.${policy.kind}`);
    return policy.kind === 'nextMatches'
        ? `${label} · ${policy.count}`
        : label;
}

export function formatAutomationScheduleLabel(automation: {
    schedule: { kind: 'once'; scheduledAt: number }
        | { kind: 'cron' | 'interval'; everyMs: number | null; scheduleExpr: string | null; timezone?: string | null };
}): string {
    if (automation.schedule.kind === 'once') return formatTriggerSummary({ kind: 'schedule', schedule: automation.schedule });
    if (automation.schedule.kind === 'interval' && typeof automation.schedule.everyMs === 'number') {
        const minutes = Math.max(1, Math.round(automation.schedule.everyMs / 60_000));
        const timezone = typeof automation.schedule.timezone === 'string' && automation.schedule.timezone.trim().length > 0
            ? automation.schedule.timezone.trim()
            : null;
        return t('automations.list.interval', { minutes, timezone });
    }
    if (automation.schedule.kind === 'cron' && typeof automation.schedule.scheduleExpr === 'string') {
        const expr = automation.schedule.scheduleExpr.trim();
        const timezone = typeof automation.schedule.timezone === 'string' && automation.schedule.timezone.trim().length > 0
            ? automation.schedule.timezone.trim()
            : null;
        return t('automations.list.cron', {
            expression: expr.length > 0 ? expr : null,
            timezone,
        });
    }
    return t('automations.list.schedule');
}

/** Public definition summaries expose trigger identity, never source configuration. */
export function formatAutomationTriggerLabel(trigger: AutomationTriggerListItem): string {
    switch (trigger.kind) {
        case 'prComment':
        case 'ciFailed':
        case 'runLifecycle':
            return formatTriggerSummary(trigger);
        case 'schedule':
            return formatAutomationScheduleLabel({ schedule: trigger.schedule });
        case 'pluginEvent':
            return formatTriggerSummary(trigger);
        case 'sessionLifecycle':
            return [
                formatAutomationSessionLifecycleEventSetLabel(trigger.events),
                formatAutomationSessionLifecyclePolicyLabel(trigger.policy),
                trigger.sourceSessionId,
            ].join(' · ');
    }
}

/**
 * Status is projected by each canonical trigger owner. Keeping this formatter
 * beside the shared trigger label prevents list/detail surfaces from inventing
 * their own lifecycle or Event state machines.
 */
export function formatAutomationTriggerStatusLabel(
    trigger: AutomationTriggerListItem,
    automationEnabled = true,
): string {
    const onceLabel = formatOnceScheduleStateLabel(readOnceScheduleState(trigger));
    if (onceLabel !== null) return onceLabel;
    if (trigger.kind === 'sessionLifecycle' || trigger.kind === 'runLifecycle') {
        return t(AUTOMATION_SESSION_LIFECYCLE_STATUS_KEYS[trigger.status.state]);
    }
    if (!automationEnabled) return t('automations.detail.status.paused');
    if (!trigger.enabled) return t('automations.detail.status.paused');
    if (trigger.kind === 'pluginEvent') {
        return trigger.sourceStatus === null
            ? t('automations.detail.event.sourceStatusUnreported')
            : t(`settingsPlugins.eventAutomationComposer.sourceStatusState.${trigger.sourceStatus.state}`);
    }
    return t('automations.detail.status.active');
}

/** Source attention uses the pushed status; history gaps have their own recovery presentation. */
export function formatAutomationTriggerObservationWarning(
    trigger: AutomationTriggerListItem | undefined,
    automationEnabled = true,
): string | null {
    if (!automationEnabled || !trigger?.enabled || trigger.kind !== 'pluginEvent') return null;
    const status = trigger.sourceStatus;
    if (!status || (status.state !== 'backingOff' && status.state !== 'attention') || status.code === 'historyGap') return null;
    const codeKey = `settingsPlugins.eventAutomationComposer.sourceStatusCode.${status.code}`;
    return [
        formatAutomationTriggerStatusLabel(trigger, automationEnabled),
        status.code !== null && hasTranslation(codeKey) ? tLoose(codeKey) : null,
        status.nextRetryAt !== null ? t('settingsPlugins.eventAutomationComposer.sourceStatusNextRetry', {
            time: new Date(status.nextRetryAt).toLocaleString(),
        }) : null,
    ].filter(Boolean).join(' · ');
}

const AUTOMATION_SESSION_LIFECYCLE_STATUS_KEYS = {
    waiting: 'automations.detail.trigger.status.waiting',
    paused: 'automations.detail.trigger.status.paused',
    triggered: 'automations.detail.trigger.status.triggered',
    running: 'automations.detail.trigger.status.running',
    finished: 'automations.detail.trigger.status.finished',
    sourceFailed: 'automations.detail.trigger.status.sourceFailed',
    sourceCancelled: 'automations.detail.trigger.status.sourceCancelled',
    sourceUnavailable: 'automations.detail.trigger.status.sourceUnavailable',
} as const satisfies Record<AutomationSessionLifecycleTriggerStatus['state'], TranslationKey>;

export function formatAutomationRunCauseLabel(cause: AutomationRunCause): string {
    switch (cause.kind) {
        case 'manual':
            return t('automations.detail.runMeta.cause.manual');
        case 'conversation':
            return t('automations.detail.runMeta.cause.conversation');
        case 'trigger':
            switch (cause.triggerKind) {
                case 'schedule':
                    return t('automations.detail.runMeta.cause.schedule');
                case 'pluginEvent':
                    return t('automations.list.event', { eventId: cause.evidence.eventRef.localId });
                case 'sessionLifecycle':
                    return [
                        formatAutomationSessionLifecycleEventLabel(cause.evidence.event),
                        formatAutomationSessionLifecyclePolicyLabel(cause.evidence.policy),
                    ].join(' · ');
                case 'runLifecycle':
                    return formatTriggerSummary({ kind: 'runLifecycle', condition: cause.evidence.condition });
                case 'action': {
                    // Immutable provenance names the phase and Action, never an authored wait policy.
                    const facts = readActionTriggerSummaryFacts({ phase: cause.evidence.phase, actionIds: [cause.evidence.actionId] });
                    return t(facts.phase === 'before' ? 'workflows.triggers.link.beforeAction' : 'workflows.triggers.link.afterAction',
                        { action: facts.actions[0]!.title });
                }
            }
    }
}

/**
 * Shared presentation key for the canonical Run state union on list and detail surfaces.
 * The union is closed by the Protocol, so every state has exactly one product label and no
 * surface paints the raw state token.
 */
const AUTOMATION_RUN_STATE_TRANSLATION_KEYS = {
    queued: 'automations.detail.runMeta.state.queued',
    claimed: 'automations.detail.runMeta.state.claimed',
    running: 'automations.detail.runMeta.state.running',
    succeeded: 'automations.detail.runMeta.state.succeeded',
    failed: 'automations.detail.runMeta.state.failed',
    cancelled: 'automations.detail.runMeta.state.cancelled',
    expired: 'automations.detail.runMeta.state.expired',
    dispatch_failed: 'automations.detail.runMeta.state.dispatch_failed',
    skipped: 'automations.detail.runMeta.state.skipped',
    missed: 'automations.detail.runMeta.state.missed',
    outcome_uncertain: 'automations.detail.runMeta.state.outcome_uncertain',
} as const satisfies Record<AutomationRunStateV3, TranslationKey>;

export function formatAutomationRunStateLabel(run: Pick<AutomationV3RunListItem, 'state' | 'workflowRunState'>): string {
    if (run.workflowRunState !== undefined) return describeWorkflowRunState(run.workflowRunState).label;
    return t(AUTOMATION_RUN_STATE_TRANSLATION_KEYS[run.state]);
}

export function formatAutomationNextRun(nextRunAt: number | null): string {
    if (nextRunAt === null) return t('automations.list.noNextRun');
    if (!Number.isFinite(nextRunAt)) return t('automations.list.nextRunPending');
    try {
        return t('automations.list.nextRun', { time: new Date(nextRunAt).toLocaleString() });
    } catch {
        return t('automations.list.nextRunPending');
    }
}
