import type { HappierSetupStep } from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';

import type { PlanChecklistExecutionState, PlanChecklistItem } from './types';

const NO_LOGS: PlanChecklistExecutionState['logs'] = [];

/** Adapt reported progress to the shared checklist without deciding the underlying run's state. */
export function projectReportedSteps(steps: readonly Pick<HappierSetupStep, 'key' | 'state' | 'title' | 'detail' | 'meta'>[]): Readonly<{
    items: readonly PlanChecklistItem[];
    selectedIds: readonly string[];
    executionById: Readonly<Record<string, PlanChecklistExecutionState>>;
}> {
    const executionById: Record<string, PlanChecklistExecutionState> = {};
    const items = steps.map((step): PlanChecklistItem => {
        const state = step.state ?? 'upcoming';
        executionById[step.key] = {
            status: state === 'done' ? 'done' : state === 'failed' ? 'error'
                : state === 'running' ? 'running' : state === 'cancelled' ? 'idle' : 'queued',
            logs: NO_LOGS,
        };
        // A step waiting on the person is the shared row's "Needs you", never a second badge for the same state.
        const needsAttention = state === 'waiting' || state === 'current';
        const stateLabel = state === 'cancelled' ? t('status.canceled') : undefined;
        const badge = [stateLabel, step.meta].filter(Boolean).join(' · ');
        return { id: step.key, title: step.title, satisfied: state === 'done', disabled: true,
            ...(needsAttention ? { needsAttention } : {}),
            ...(step.detail ? { subtitle: step.detail } : {}), ...(badge ? { badge } : {}) };
    });
    return { items, selectedIds: items.map((item) => item.id), executionById };
}
