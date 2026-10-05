import * as React from 'react';

import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import type { WorkflowRunListWindowId } from '@/sync/store/domains/workflowRuns';

/**
 * The Inbox's workflow input (ORC R-10; FIN 03 §6.4).
 *
 * Workflow attention has one owner: the server's `attention: 'required'` predicate, held on the
 * client in the canonical `workflowRunListWindows.attention` window that the Workflows column's
 * Needs you also reads. Inbox consumes that shared window's read status, membership and paging;
 * it owns neither another loader nor attention policy.
 *
 * A failed refresh keeps the rows it already proved (last known) and says so once through
 * `refreshFailed` + `knownAt`; only a first read with nothing known is `failed`.
 */
export type WorkflowAttentionSource = Readonly<{
    /** Home qualification of the window's rows, supplied by its canonical reader. */
    serverId: string | null;
    /** Workflows are offered on this Home; when false the source is empty and never read. */
    available: boolean;
    phase: 'idle' | 'loading' | 'loaded' | 'failed';
    /** The attention window's membership for the current Account, in server order. */
    runIds: readonly string[];
    refreshFailed: boolean;
    /** Epoch ms of the last successful read, for "Showing what was known at …". */
    knownAt: number | null;
    hasMore: boolean;
    loadingMore: boolean;
    loadMoreFailed: boolean;
    retry: () => void;
    loadMore: () => void;
}>;

const EMPTY_RUN_IDS: readonly string[] = Object.freeze([]);
const NOOP = () => {};

export const EMPTY_WORKFLOW_ATTENTION_SOURCE: WorkflowAttentionSource = Object.freeze({
    serverId: null,
    available: false,
    phase: 'idle',
    runIds: EMPTY_RUN_IDS,
    refreshFailed: false,
    knownAt: null,
    hasMore: false,
    loadingMore: false,
    loadMoreFailed: false,
    retry: NOOP,
    loadMore: NOOP,
});

function useAttentionSource(windowId: WorkflowRunListWindowId, available: boolean): WorkflowAttentionSource {
    const window = useWorkflowRunWindow(windowId, { enabled: available });
    const phase = !available ? 'idle' : window.knownAt !== null ? 'loaded' : window.status;
    return React.useMemo(() => available ? {
        serverId: window.serverId, available, phase, runIds: window.runIds,
        refreshFailed: window.status === 'failed', knownAt: window.knownAt,
        hasMore: window.hasMore, loadingMore: window.loadingMore, loadMoreFailed: window.loadMoreFailed,
        retry: window.retry, loadMore: window.loadMore,
    } : EMPTY_WORKFLOW_ATTENTION_SOURCE, [available, phase, window.serverId, window.runIds, window.status, window.knownAt,
        window.hasMore, window.loadingMore, window.loadMoreFailed, window.retry, window.loadMore]);
}

const WorkflowAttentionSourceContext = React.createContext<Readonly<{
    workflow: WorkflowAttentionSource; automation: WorkflowAttentionSource;
}> | null>(null);

/** Mounted once by the app shell's Inbox summary owner. */
export function WorkflowAttentionSourceProvider(props: Readonly<{ children: React.ReactNode }>) {
    const workflows = useWorkflowsAvailability();
    const automations = useFeatureDecision('automations', { scopeKind: 'runtime' });
    const workflow = useAttentionSource('attention', workflows.available);
    // Ordinary failures remain available when structured Workflows are disabled.
    const automation = useAttentionSource('automationAttention', automations?.state === 'enabled');
    const source = React.useMemo(() => ({ workflow, automation }), [workflow, automation]);
    return (
        <WorkflowAttentionSourceContext.Provider value={source}>
            {props.children}
        </WorkflowAttentionSourceContext.Provider>
    );
}

/**
 * A no-op beneath the shell's owner; an isolated Inbox (tests, stories) mounts its own, so there is
 * never a second loader under the shell.
 */
export function WorkflowAttentionSourceBoundary(props: Readonly<{ children: React.ReactNode }>) {
    const existing = React.useContext(WorkflowAttentionSourceContext);
    if (existing) return <>{props.children}</>;
    return <WorkflowAttentionSourceProvider>{props.children}</WorkflowAttentionSourceProvider>;
}

export function useWorkflowAttentionSource(): WorkflowAttentionSource {
    return React.useContext(WorkflowAttentionSourceContext)?.workflow ?? EMPTY_WORKFLOW_ATTENTION_SOURCE;
}

export function useAutomationAttentionSource(): WorkflowAttentionSource {
    return React.useContext(WorkflowAttentionSourceContext)?.automation ?? EMPTY_WORKFLOW_ATTENTION_SOURCE;
}
