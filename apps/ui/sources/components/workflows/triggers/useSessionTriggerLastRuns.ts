import * as React from 'react';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** Habits consume the shared Account Run window, not a request per trigger row. */
export function useSessionTriggerLastRuns(automationIds: readonly string[]) {
    const read = useWorkflowRunWindow('all', { enabled: automationIds.length > 0 });
    const previous = React.useRef<Readonly<Record<string, WorkflowRunSummaryV1>>>({});
    const lastRunsByAutomationId = React.useMemo(() => {
        const needed = new Set(automationIds);
        const next: Record<string, WorkflowRunSummaryV1> = {};
        // The owner's window is newest-first by immutable acceptance order. The first
        // occurrence is the last Run of that Automation, never its last firing timestamp.
        for (const row of read.rows) {
            const run = row.summary;
            if (run?.origin.kind === 'automation' && needed.delete(run.origin.automationId)) next[run.origin.automationId] = run;
        }
        if (!sameStrictJsonValue(previous.current, next)) previous.current = next;
        return previous.current;
    }, [automationIds, read.rows]);
    const missing = automationIds.some(id => lastRunsByAutomationId[id] === undefined);
    React.useEffect(() => {
        if (missing && read.status === 'loaded' && read.hasMore && !read.loadingMore && !read.loadMoreFailed) read.loadMore();
    }, [missing, read.status, read.hasMore, read.loadingMore, read.loadMoreFailed, read.loadMore, read.runIds]);
    return { lastRunsByAutomationId, failed: read.status === 'failed' || read.loadMoreFailed, retry: read.retry };
}
