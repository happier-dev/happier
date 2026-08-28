import type {
    AutomationRunCause,
    AutomationRunStateV3,
    AutomationSessionLifecycleTriggerStatus,
    AutomationTriggerListItem,
} from '@happier-dev/protocol';
import { t, type TranslationKey } from '@/text';

export function formatAutomationScheduleLabel(automation: {
    schedule: { kind: 'cron' | 'interval'; everyMs: number | null; scheduleExpr: string | null; timezone?: string | null };
}): string {
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
        case 'schedule':
            return formatAutomationScheduleLabel({ schedule: trigger.schedule });
        case 'pluginEvent':
            return t('automations.list.event', { eventId: trigger.eventRef.localId });
        case 'sessionLifecycle':
            return t('automations.list.sessionLifecycleParentTurn', { sessionId: trigger.scope.sourceSessionId });
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
    if (trigger.kind === 'sessionLifecycle') {
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

/** Shared presentation key for the sole immutable Run-cause union. */
export function getAutomationRunCauseTranslationKey(
    cause: AutomationRunCause,
): 'automations.detail.runMeta.cause.schedule'
    | 'automations.detail.runMeta.cause.pluginEvent'
    | 'automations.detail.runMeta.cause.sessionLifecycle'
    | 'automations.detail.runMeta.cause.manual'
    | 'automations.detail.runMeta.cause.conversation' {
    switch (cause.kind) {
        case 'manual':
            return 'automations.detail.runMeta.cause.manual';
        case 'conversation':
            return 'automations.detail.runMeta.cause.conversation';
        case 'trigger':
            if (cause.triggerKind === 'schedule') return 'automations.detail.runMeta.cause.schedule';
            if (cause.triggerKind === 'pluginEvent') return 'automations.detail.runMeta.cause.pluginEvent';
            return 'automations.detail.runMeta.cause.sessionLifecycle';
    }
}

export function getAutomationRunCauseAt(cause: AutomationRunCause): number {
    return cause.kind === 'manual' ? cause.invokedAt : cause.occurredAt;
}

export function formatAutomationRunCauseLabel(cause: AutomationRunCause): string {
    if (cause.kind === 'trigger' && cause.triggerKind === 'pluginEvent') {
        return t('automations.list.event', { eventId: cause.evidence.eventRef.localId });
    }
    return t(getAutomationRunCauseTranslationKey(cause));
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

export function formatAutomationRunStateLabel(state: AutomationRunStateV3): string {
    return t(AUTOMATION_RUN_STATE_TRANSLATION_KEYS[state]);
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
