import type { AutomationRunStateV3, AutomationV3RunOrigin } from '@happier-dev/protocol';

import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
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
export function formatAutomationTriggerLabel(trigger: AutomationDefinition['trigger']): string {
    switch (trigger.kind) {
        case 'manual':
            return t('automations.list.manual');
        case 'schedule':
            return formatAutomationScheduleLabel({ schedule: trigger.schedule });
        case 'pluginEvent':
            return t('automations.list.event', { eventId: trigger.eventRef.localId });
        case 'conversation':
            return t('automations.list.conversationTrigger');
    }
}

/** Shared presentation key for the immutable origin union on list and detail surfaces. */
export function getAutomationRunOriginTranslationKey(
    origin: AutomationV3RunOrigin,
): 'automations.detail.runMeta.origin.scheduled'
    | 'automations.detail.runMeta.origin.manual'
    | 'automations.detail.runMeta.origin.pluginEvent'
    | 'automations.detail.runMeta.origin.conversation' {
    switch (origin.kind) {
        case 'scheduled':
            return 'automations.detail.runMeta.origin.scheduled';
        case 'manual':
            return 'automations.detail.runMeta.origin.manual';
        case 'pluginEvent':
            return 'automations.detail.runMeta.origin.pluginEvent';
        case 'conversation':
            return 'automations.detail.runMeta.origin.conversation';
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
