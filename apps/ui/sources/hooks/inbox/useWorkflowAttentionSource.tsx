import * as React from 'react';

import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { WorkflowRunListWindowId } from '@/sync/store/domains/workflowRuns';

/**
 * The Inbox's workflow input (ORC R-10; FIN 03 §6.4).
 *
 * Workflow attention has one owner: the server's `attention: 'required'` predicate, held on the
 * client in the canonical Account-scoped `attention` window that the Workflows column's
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
const EMPTY_OCCURRENCES: ReadonlySet<string> = new Set();
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

function useAttentionSource(windowId: WorkflowRunListWindowId, available: boolean, projection?: 'membership'): WorkflowAttentionSource {
    const window = useWorkflowRunWindow(windowId, { enabled: available, projection });
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
    occurrenceRunIds: ReadonlySet<string>;
}> | null>(null);

/** Whether an open approval's header names this Home (the header list fact the Inbox lists it by). */
function approvalOnHome(artifact: DecryptedArtifact, serverId: string): boolean {
    const header = artifact.header;
    return [header?.serverIdentityId, header?.serverId].some(id => typeof id === 'string' && id.length > 0
        && areServerProfileIdentifiersEquivalent(id, serverId));
}

/**
 * The window's Runs the Inbox already lists as an open approval of this Account on the same Home: the store's
 * Run → open-approval index (`artifactWorkflowPublicationArtifactsByRunId`, from each header's Workflow caller).
 * The approval is the one row for that request (R21-D2); a Run with no matching open Artifact keeps its own row.
 * A newline-joined key keeps the selection primitive, so unrelated Artifact changes render nothing.
 */
function useApprovalHeldRunIds(window: WorkflowAttentionSource): ReadonlySet<string> {
    const { runIds, serverId } = window;
    const select = React.useCallback((state: ReturnType<typeof storage.getState>) => {
        if (!serverId || runIds.length === 0) return '';
        const groups = state.artifactWorkflowPublicationArtifactsByRunId;
        return runIds.filter(id => Object.values(groups[id] ?? {}).some(artifact => approvalOnHome(artifact, serverId))).join('\n');
    }, [runIds, serverId]);
    const key = storage(select);
    return React.useMemo(() => key ? new Set(key.split('\n')) : EMPTY_OCCURRENCES, [key]);
}

/**
 * The window without the Runs another Inbox row already presents: an Automation occurrence (which can open a failed
 * trigger that never acquired an accepted Workflow snapshot) or an open approval the Run is held on.
 */
function useWorkflowAttentionWithoutOccurrences(window: WorkflowAttentionSource, occurrenceRunIds: ReadonlySet<string>) {
    const approvalRunIds = useApprovalHeldRunIds(window);
    const selection = React.useMemo(() => {
        if (occurrenceRunIds.size === 0 && approvalRunIds.size === 0) {
            return { runIds: window.runIds, workflowRunIdsWithOccurrence: EMPTY_OCCURRENCES };
        }
        const workflowRunIdsWithOccurrence = new Set<string>();
        const runIds = window.runIds.filter(id => {
            if (occurrenceRunIds.has(id)) workflowRunIdsWithOccurrence.add(id);
            return !occurrenceRunIds.has(id) && !approvalRunIds.has(id);
        });
        return runIds.length !== window.runIds.length
            ? { runIds, workflowRunIdsWithOccurrence: workflowRunIdsWithOccurrence.size > 0 ? workflowRunIdsWithOccurrence : EMPTY_OCCURRENCES }
            : { runIds: window.runIds, workflowRunIdsWithOccurrence: EMPTY_OCCURRENCES };
    }, [window.runIds, occurrenceRunIds, approvalRunIds]);
    return React.useMemo(() => ({
        workflowAttention: selection.runIds === window.runIds ? window : { ...window, runIds: selection.runIds },
        workflowRunIdsWithOccurrence: selection.workflowRunIdsWithOccurrence,
        workflowRunIdsWithApproval: approvalRunIds,
    }), [window, selection, approvalRunIds]);
}

/** Mounted once by the app shell's Inbox summary owner. */
export function WorkflowAttentionSourceProvider(props: Readonly<{ children: React.ReactNode }>) {
    const workflows = useWorkflowsAvailability();
    const workflowWindow = useAttentionSource('attention', workflows.available, 'membership');
    const automation = useAttentionSource('automationAttention', workflows.available);
    const occurrenceRunIds = React.useMemo(() => automation.runIds.length > 0 && automation.serverId && workflowWindow.serverId
        && areServerProfileIdentifiersEquivalent(automation.serverId, workflowWindow.serverId)
        ? new Set(automation.runIds) : EMPTY_OCCURRENCES, [automation.runIds, automation.serverId, workflowWindow.serverId]);
    const { workflowAttention: workflow } = useWorkflowAttentionWithoutOccurrences(workflowWindow, occurrenceRunIds);
    const source = React.useMemo(() => ({ workflow, automation, occurrenceRunIds }), [workflow, automation, occurrenceRunIds]);
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

/** An open Inbox needs private rows; demand promotes the shell's same canonical window. */
export function useFullWorkflowAttentionSource() {
    const source = useWorkflowAttentionSource();
    const full = useAttentionSource('attention', source.available);
    return useWorkflowAttentionWithoutOccurrences(full, useInboxWorkflowOccurrenceRunIds());
}

export function useAutomationAttentionSource(): WorkflowAttentionSource {
    return React.useContext(WorkflowAttentionSourceContext)?.automation ?? EMPTY_WORKFLOW_ATTENTION_SOURCE;
}

export function useInboxWorkflowOccurrenceRunIds(): ReadonlySet<string> {
    return React.useContext(WorkflowAttentionSourceContext)?.occurrenceRunIds ?? EMPTY_OCCURRENCES;
}
