import * as React from 'react';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';

import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { retryServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type {
    WorkflowRunInvocationIndexV1,
    WorkflowRunSummaryV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowRunPrivateMetadataV1, WorkflowRunGetResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getStorage, useActiveServerAccountScope, useActiveServerAccountScopeLifetime, useWorkflowRunRows } from '@/sync/domains/state/storage';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import { discussionWorkflowRunListFilterId, selectWorkflowRunWindowInvocations, sessionWorkflowRunListFilterId } from '@/sync/store/domains/workflowRuns';
import {
    projectWorkflowFlow,
    type WorkflowFlowNodeRunState,
    type WorkflowFlowProjection,
} from '@/components/workflows/flow/workflowFlowProjection';
import {
    projectWorkflowFlowRunStates,
    projectWorkflowInvocationStructure,
} from '@/components/workflows/run/workflowInvocationStructure';

/**
 * Contextual managed Workflow Runs from a Session or Discussion, using one list lifecycle.
 *
 * `originSessionId` selects provenance, `targetSessionId` selects destinations, and Discussions
 * select `originDiscussionId` from the same storage owner. The
 * complete relation's summaries carry the canonical server attention fact.
 * They are asked of the same Action front door, so this hook adds no
 * second run store and invents no local attention rule. Following every byte
 * continuation also keeps an off-page approval discoverable.
 *
 * Row bodies land in the one Account-scoped Run row owner and are read back
 * from it, so a control the Run screen settles, or an exact invalidation,
 * reaches a mounted Session row at once. The same store retains the ordered
 * membership for this exact Home/Account/resource/relation, including across
 * consumer remounts. The Workflows collection's window reader owns initial
 * pages, continuations and typed Account changes for every mounted consumer.
 *
 * A Session origin is provenance, not ownership: these Runs keep their own
 * custody and stay inspectable from the Workflows collection after the Session
 * ends. This reader exists so the Session that started them offers the exact
 * entry point while it is still useful.
 */

export type SessionManagedWorkflowRunsState = Readonly<{
    phase: 'idle' | 'loading' | 'loaded' | 'failed';
    runs: readonly WorkflowRunSummaryV1[];
    metadataByRunId?: Readonly<Record<string, WorkflowRunPrivateMetadataV1 | null>>;
    supportsAnotherRoundByRunId?: Readonly<Record<string, boolean>>;
    callerAccessByRunId?: Readonly<Record<string, WorkflowRunGetResultV1['callerAccess']>>;
    /** Exactly the Run ids the server's attention predicate returned. */
    attentionRunIds: ReadonlySet<string>;
    /**
     * The most recent read failed.
     *
     * It is separate from `phase` because a failed refresh does not unlearn
     * what the previous one proved: `phase` stays `loaded` with its membership
     * intact and this says the content may be stale. Only a first read with
     * nothing known yet is `failed`.
     */
    refreshFailed: boolean;
    /** Time this window last completed a successful read; refresh attempts never advance it. */
    lastSuccessfulReadAt?: number | null;
    /** Re-ask this window through its existing read owner, without dropping retained rows. */
    retry: () => void;
}>;

const EMPTY_RUN_IDS: readonly string[] = Object.freeze([]);
const EMPTY_ATTENTION: ReadonlySet<string> = new Set<string>();
const EMPTY_RUNS: readonly WorkflowRunSummaryV1[] = Object.freeze([]);
const EMPTY_METADATA: Readonly<Record<string, WorkflowRunPrivateMetadataV1>> = Object.freeze({});
const EMPTY_CONTINUATION: Readonly<Record<string, boolean>> = Object.freeze({});
const EMPTY_ACCESS: Readonly<Record<string, WorkflowRunGetResultV1['callerAccess']>> = Object.freeze({});

export function useSessionManagedWorkflowRuns(params: Readonly<{
    sessionId: string | null;
    serverId: string | null;
    enabled?: boolean;
    /** "Writes here" uses the same Run-list owner, with its destination relation. */
    relation?: 'origin' | 'destination';
}>): SessionManagedWorkflowRunsState {
    return useContextManagedWorkflowRuns({
        resource: params.sessionId ? { kind: 'session', id: params.sessionId } : null,
        serverId: params.serverId, enabled: params.enabled, relation: params.relation,
    });
}

/** One canonical contextual query lifecycle; relation membership stays in the shared Run store. */
export function useContextManagedWorkflowRuns(params: Readonly<{
    resource: Readonly<{ kind: 'session' | 'discussion'; id: string }> | null;
    serverId: string | null;
    enabled?: boolean;
    relation?: 'origin' | 'destination';
    accountLifetime?: ServerAccountScopeLifetime;
}>): SessionManagedWorkflowRunsState {
    const resourceId = params.resource?.id.trim() ? params.resource.id : null;
    const resourceKind = params.resource?.kind ?? 'session';
    const relation = params.relation ?? 'origin';
    const workflows = useWorkflowsAvailability(params.accountLifetime
        ? { scopeKind: 'spawn', serverId: params.accountLifetime.scope.serverId } : undefined);
    const enabled = (params.enabled ?? true) && workflows.available;
    const retainWhileResolving = (params.enabled ?? true) && workflows.resolving;
    const activeScope = useActiveServerAccountScope(params.serverId);
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = params.accountLifetime ?? activeLifetime;
    const accountScope = params.accountLifetime?.scope ?? activeScope;
    const selected = resourceId !== null;
    const windowId = resourceKind === 'discussion' ? discussionWorkflowRunListFilterId(resourceId ?? '')
        : sessionWorkflowRunListFilterId(resourceId ?? '', relation);
    const window = useWorkflowRunWindow(windowId, {
        accountLifetime: accountScope === null ? null : lifetime,
        enabled: selected && (enabled || retainWhileResolving),
        demanded: selected && enabled,
        readMode: 'complete',
    });
    // Capability resolution releases demand without withdrawing already-proven rows.
    // Both selectors read the shared row owner; this hook owns no request or membership.
    const retainedRows = useWorkflowRunRows(retainWhileResolving ? window.runIds : EMPTY_RUN_IDS, accountScope);
    const rows = retainWhileResolving ? retainedRows : window.rows;
    const retry = React.useCallback(() => {
        if (retainWhileResolving && lifetime?.isCurrent()) {
            fireAndForget(retryServerFeaturesSnapshot({ serverId: lifetime.scope.serverId }), {
                tag: 'useContextManagedWorkflowRuns.retryCapabilities',
            });
            return;
        }
        window.retry();
    }, [lifetime, retainWhileResolving, window.retry]);
    const runs = React.useMemo(
        () => rows.length === 0 ? EMPTY_RUNS : rows.flatMap(row => row.summary ? [row.summary] : []),
        [rows],
    );
    const metadataByRunId = React.useMemo(() => {
        const entries = rows.flatMap(row => row.metadata ? [[row.id, row.metadata] as const] : []);
        return entries.length === 0 ? EMPTY_METADATA : Object.fromEntries(entries);
    }, [rows]);
    const supportsAnotherRoundByRunId = React.useMemo(() => {
        const entries = rows.flatMap(row => row.supportsAnotherRound === undefined ? [] : [[row.id, row.supportsAnotherRound] as const]);
        return entries.length === 0 ? EMPTY_CONTINUATION : Object.fromEntries(entries);
    }, [rows]);
    const callerAccessByRunId = React.useMemo(() => {
        const entries = rows.flatMap(row => row.callerAccess === undefined ? [] : [[row.id, row.callerAccess] as const]);
        return entries.length === 0 ? EMPTY_ACCESS : Object.fromEntries(entries);
    }, [rows]);
    const attentionRunIds = React.useMemo(() => {
        const ids = runs.filter(run => run.attentionRequired).map(run => run.id);
        return ids.length ? new Set(ids) : EMPTY_ATTENTION;
    }, [runs]);
    const unavailable = enabled && selected && (accountScope === null || lifetime?.isCurrent() !== true);
    const phase: SessionManagedWorkflowRunsState['phase'] = !selected || (!enabled && !retainWhileResolving) ? 'idle'
        : unavailable ? 'failed' : window.knownAt !== null ? 'loaded' : window.status;
    const refreshFailed = unavailable || (selected && window.status === 'failed')
        || (retainWhileResolving && window.knownAt !== null);
    const lastSuccessfulReadAt = window.knownAt;
    return React.useMemo(
        () => ({ phase, runs, metadataByRunId, supportsAnotherRoundByRunId, callerAccessByRunId, attentionRunIds, refreshFailed, lastSuccessfulReadAt, retry }),
        [attentionRunIds, lastSuccessfulReadAt, metadataByRunId, supportsAnotherRoundByRunId, callerAccessByRunId, phase, refreshFailed, retry, runs],
    );
}

export type SessionManagedWorkflowRunFlow = Readonly<{
    projection: WorkflowFlowProjection;
    runStates: ReadonlyMap<string, readonly WorkflowFlowNodeRunState[]>;
}>;

const EMPTY_INVOCATIONS: readonly WorkflowRunInvocationIndexV1[] = Object.freeze([]);

/**
 * One managed Run's live flow: the compact map a Work row draws under it (INT §6 I4).
 *
 * The definition is frozen at admission, so it is read once per mount through
 * the exact-Run reader. Lifecycles are the leading page of the Run's invocation
 * window in the one Account-scoped owner — the same window Run detail pages —
 * restated on the Run's own Account-change wake, so the map and Run detail
 * cannot disagree and nothing polls. The caller mounts this only while the row
 * is on screen: an off-screen row holds no read and no wake.
 */
export function useSessionManagedWorkflowRunFlow(runId: string, serverId: string | null): SessionManagedWorkflowRunFlow | null {
    const accountScope = useActiveServerAccountScope(serverId);
    const lifetime = useActiveServerAccountScopeLifetime();
    const accountScopeKey = accountScope === null ? null : serverAccountScopeKeySuffix(accountScope);
    const contentKey = accountScopeKey === null ? null : `${accountScopeKey}\u0000${runId}`;
    const [definition, setDefinition] = React.useState<Readonly<{ key: string; value: WorkflowDefinitionV1 }> | null>(null);
    const [invalidationToken, setInvalidationToken] = React.useState(0);
    const invocations = getStorage()((state) => (
        contentKey === null ? EMPTY_INVOCATIONS : selectWorkflowRunWindowInvocations(state.workflowRunInvocationsByRunId[workflowRunStoreKey(runId)], 'history')
    ));

    React.useEffect(() => {
        if (contentKey === null) {
            setDefinition(null);
            return;
        }
        if (lifetime === null || serverAccountScopeKeySuffix(lifetime.scope) !== accountScopeKey) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        void workflowRunDetailActions.getRun(runId, controller.signal).then(
            (detail) => {
                if (controller.signal.aborted || !lifetime.isCurrent()) return;
                setDefinition({ key: contentKey, value: detail.definition });
            },
            // A Run this device cannot open keeps its row, without a map.
            () => undefined,
        );
        return () => {
            controller.abort();
            retirement.dispose();
        };
    }, [accountScopeKey, contentKey, lifetime, runId]);

    React.useEffect(() => {
        if (contentKey === null) return;
        if (lifetime === null || serverAccountScopeKeySuffix(lifetime.scope) !== accountScopeKey) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        void workflowRunDetailActions.listInvocations({ runId }, controller.signal).then(
            (page) => {
                if (controller.signal.aborted || !lifetime.isCurrent()) return;
                const state = getStorage().getState();
                // A traversal Run detail already paged keeps its later pages; this restates the first.
                state.applyWorkflowRunInvocationPage({
                    runId,
                    invocations: page.invocations,
                    nextCursor: page.nextCursor ?? null,
                    parentRevision: page.parentRevision,
                    mode: state.workflowRunInvocationsByRunId[workflowRunStoreKey(runId)]?.history.loaded === true ? 'refresh' : 'replace',
                });
            },
            // A failed restatement keeps the last-known lifecycles.
            () => undefined,
        );
        return () => {
            controller.abort();
            retirement.dispose();
        };
    }, [accountScopeKey, contentKey, invalidationToken, lifetime, runId]);

    React.useEffect(() => {
        if (contentKey === null) return;
        if (lifetime === null || serverAccountScopeKeySuffix(lifetime.scope) !== accountScopeKey) return;
        return subscribeVisibleWorkflowRunListInvalidation({
            lifetime,
            runId,
            isVisibleWindowLoaded: () => true,
            invalidate: () => setInvalidationToken((token) => token + 1),
        });
    }, [accountScopeKey, contentKey, lifetime, runId]);

    const definitionValue = definition !== null && definition.key === contentKey ? definition.value : null;
    const projection = React.useMemo(
        () => (definitionValue === null ? null : projectWorkflowFlow(definitionValue, undefined, undefined, { presentation: 'run' })),
        [definitionValue],
    );
    return React.useMemo(() => {
        if (projection === null || definitionValue === null) return null;
        const structure = projectWorkflowInvocationStructure({ definition: definitionValue, invocations });
        return { projection, runStates: projectWorkflowFlowRunStates({ invocations, structure }) };
    }, [definitionValue, invocations, projection]);
}
