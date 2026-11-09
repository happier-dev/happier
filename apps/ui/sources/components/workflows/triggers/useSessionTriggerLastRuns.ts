import * as React from 'react';
import type { WorkflowRunAutomationSummariesResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { useWorkflowAutomationSummaries } from '@/components/workflows/library/useWorkflowLibrarySummaries';

type LastRun = NonNullable<WorkflowRunAutomationSummariesResultV1['automationSummaries'][number]['lastRun']>;
const EMPTY_LAST_RUNS: Readonly<Record<string, LastRun>> = Object.freeze({});

/** Habits demand batched public status facts from the existing scoped summary owner. */
export function useSessionTriggerLastRuns(automationIds: readonly string[]) {
    const read = useWorkflowAutomationSummaries(automationIds);
    const lastRunsByAutomationId = React.useMemo(() => {
        if (!read.summaries) return EMPTY_LAST_RUNS;
        return Object.fromEntries([...read.summaries].flatMap(([id, summary]) => summary.lastRun ? [[id, summary.lastRun] as const] : []));
    }, [read.summaries]);
    const lastRunAtByAutomationId = React.useMemo(() => Object.fromEntries(
        Object.entries(lastRunsByAutomationId).map(([id, run]) => [id, Date.parse(run.startedAt)]),
    ), [lastRunsByAutomationId]);
    return { lastRunsByAutomationId, lastRunAtByAutomationId, failed: read.failed, retry: read.retry };
}
