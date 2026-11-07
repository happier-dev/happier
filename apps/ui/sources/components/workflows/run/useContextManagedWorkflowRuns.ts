import * as React from 'react';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';

import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { isTriggeredWorkflowRun } from '@/components/sessions/work/workflowRunTriggerScope';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type {
    WorkflowRunInvocationIndexV1,
    WorkflowRunSummaryV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowRunPrivateMetadataV1, WorkflowRunGetResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getStorage, useActiveServerAccountScope, useActiveServerAccountScopeLifetime, useWorkflowRunRows } from '@/sync/domains/state/storage';
import { listAllWorkflowRuns } from '@/sync/domains/workflows/workflowRunListActions';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import { selectWorkflowRunWindowInvocations, sessionWorkflowRunWindowId, discussionWorkflowRunWindowId } from '@/sync/store/domains/workflowRuns';
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
 * select exact ids already carried by their messages or acknowledged starts. The
 * complete relation's summaries carry the canonical server attention fact.
 * They are asked of the same Action front door, so this hook adds no
 * second run store and invents no local attention rule. Following every byte
 * continuation also keeps an off-page approval discoverable.
 *
 * Row bodies land in the one Account-scoped Run row owner and are read back
 * from it, so a control the Run screen settles, or an exact invalidation,
 * reaches a mounted Session row at once. The same store retains the ordered
 * membership and attention ids for this exact Home/Account/resource/relation,
 * including across consumer remounts. This hook re-asks on the same
 * Account-change wake the Workflows collection observes. There is no poller,
 * no second store and no local bus.
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

type SessionManagedWorkflowRunsReadState = Readonly<{
    phase: SessionManagedWorkflowRunsState['phase'];
    /** The Account and resource this window was read for; anything else shows nothing. */
    accountScopeKey: string | null;
    resourceId: string | null;
    resourceKind: 'session' | 'discussion';
    relation: 'origin' | 'destination';
    refreshFailed: boolean;
    exactRunIdsKey?: string;
}>;

const EMPTY_RUN_IDS: readonly string[] = Object.freeze([]);
const EMPTY_ATTENTION: ReadonlySet<string> = new Set<string>();
const EMPTY_RUNS: readonly WorkflowRunSummaryV1[] = Object.freeze([]);
const EMPTY_METADATA: Readonly<Record<string, WorkflowRunPrivateMetadataV1>> = Object.freeze({});
const EMPTY_CONTINUATION: Readonly<Record<string, boolean>> = Object.freeze({});
const EMPTY_ACCESS: Readonly<Record<string, WorkflowRunGetResultV1['callerAccess']>> = Object.freeze({});

const EMPTY_READ_STATE: SessionManagedWorkflowRunsReadState = {
    phase: 'idle',
    accountScopeKey: null,
    resourceId: null,
    resourceKind: 'session',
    relation: 'origin',
    refreshFailed: false,
};

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
    /** Known message/start identities; never discover these through private-origin inventory scans. */
    runIds?: readonly string[];
}>): SessionManagedWorkflowRunsState {
    const exactRunIdsKey = params.resource?.kind === 'discussion' ? JSON.stringify([...new Set(params.runIds ?? [])].sort()) : undefined;
    const exactRunIds = React.useMemo<readonly string[] | undefined>(() => exactRunIdsKey === undefined
        ? undefined : JSON.parse(exactRunIdsKey), [exactRunIdsKey]);
    const resourceId = params.resource?.id.trim() ? params.resource.id : null;
    const resourceKind = params.resource?.kind ?? 'session';
    const relation = params.relation ?? 'origin';
    // Contextual managed-Run reads answer the same canonical Workflows decision
    // the dedicated routes do, and fail closed while it is unresolved: a
    // Session's ordinary one-shot Automations stay untouched, but this surface
    // must not read or link a Workflow the Home does not offer.
    const workflows = useWorkflowsAvailability(params.accountLifetime
        ? { scopeKind: 'spawn', serverId: params.accountLifetime.scope.serverId } : undefined);
    const enabled = (params.enabled ?? true) && workflows.available;
    const retainWhileResolving = (params.enabled ?? true) && workflows.resolving;
    const activeScope = useActiveServerAccountScope(params.serverId);
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = params.accountLifetime ?? activeLifetime;
    const accountScope = params.accountLifetime?.scope ?? activeScope;
    const accountScopeKey = accountScope === null ? null : serverAccountScopeKeySuffix(accountScope);
    const windowId = accountScope !== null && resourceId !== null
        ? resourceKind === 'discussion' ? discussionWorkflowRunWindowId(accountScope, resourceId)
            : sessionWorkflowRunWindowId(accountScope, resourceId, relation) : null;
    const listWindow = getStorage()((state) => windowId !== null && (enabled || retainWhileResolving)
        ? state.workflowRunListWindows[windowId] : undefined);
    const [readState, setReadState] = React.useState<SessionManagedWorkflowRunsReadState>(EMPTY_READ_STATE);
    const [invalidationToken, setInvalidationToken] = React.useState(0);
    const retry = React.useCallback(() => {
        if (retainWhileResolving && lifetime?.isCurrent()) {
            // The shared capability owner publishes recovery and re-enables this window's read.
            fireAndForget(getServerFeaturesSnapshot({ serverId: lifetime.scope.serverId, force: true }), {
                tag: 'useContextManagedWorkflowRuns.retryCapabilities',
            });
            return;
        }
        setInvalidationToken((token) => token + 1);
    }, [lifetime, retainWhileResolving]);
    const current = listWindow?.loaded === true && lifetime?.isCurrent() === true;
    const currentRead = accountScopeKey !== null && readState.accountScopeKey === accountScopeKey
        && readState.resourceId === resourceId && readState.resourceKind === resourceKind && readState.relation === relation
        && readState.exactRunIdsKey === exactRunIdsKey;
    // Only this Session's own window, never the Account's whole Run map: an
    // exact refresh of a Run outside this relation must not rerender a
    // mounted transcript section.
    const rows = useWorkflowRunRows(current ? exactRunIds ?? listWindow.runIds : EMPTY_RUN_IDS, accountScope);

    React.useEffect(() => {
        if (!enabled || resourceId === null || accountScopeKey === null || exactRunIds?.length === 0) {
            // An unresolved capability probe cannot authorize another read, but it also cannot
            // disprove this Account's already-read membership. Keep that window as stale; an
            // explicit disable, different Session/Home/Account or retired scope withdraws it here.
            setReadState(EMPTY_READ_STATE);
            return;
        }
        // Decrypted Account content never survives a scope change: the lifetime
        // retires this read before another Account's rows could be applied.
        if (lifetime === null || windowId === null
            || serverAccountScopeKeySuffix(lifetime.scope) !== accountScopeKey) return;
        const requestScopeKey = accountScopeKey;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => { controller.abort(); setReadState(EMPTY_READ_STATE); });
        let cancelled = false;
        // A re-read keeps last-known-good rows; only a first read is loading.
        setReadState(previous => ({ phase: 'loading', accountScopeKey: requestScopeKey, resourceId, resourceKind, relation, exactRunIdsKey,
            refreshFailed: previous.accountScopeKey === requestScopeKey && previous.resourceId === resourceId
                && previous.resourceKind === resourceKind && previous.relation === relation && previous.refreshFailed }));
        void (async () => {
            try {
                const filter = relation === 'destination' ? { targetSessionId: resourceId } : { originSessionId: resourceId };
                const all = await listAllWorkflowRuns({
                    filter: exactRunIds === undefined ? filter : { runIds: exactRunIds },
                    signal: controller.signal,
                    accountLifetime: lifetime,
                });
                if (cancelled || !lifetime.isCurrent()) return;
                // A trigger Run without retained scope cannot establish Work membership.
                // Keep the last proven window and its existing failed-read state, rather than infer
                // ownership from a mutable or not-yet-hydrated client Automation catalog.
                if (all.runs.some(run => isTriggeredWorkflowRun(run)
                    && run.automationScopeSessionId === undefined)) throw new Error('workflow_run_scope_unavailable');
                // Every page's bodies land in the one Account-scoped row owner,
                // so an off-page actionable Run is the same body the exact Run
                // route resolves rather than a second, thinner copy.
                // Summary attention is the server's admitted fact, including all continuation pages.
                getStorage().getState().applyWorkflowRunListPage({
                    scope: lifetime.scope, windowId,
                    runs: all.runs,
                    metadataByRunId: all.metadataByRunId,
                    supportsAnotherRoundByRunId: all.supportsAnotherRoundByRunId,
                    callerAccessByRunId: all.callerAccessByRunId,
                    nextCursor: null, mode: 'replace',
                    attentionRunIds: all.runs.filter(run => run.attentionRequired).map(run => run.id),
                    lastSuccessfulReadAt: Date.now(),
                });
                setReadState({ phase: 'loaded', accountScopeKey: requestScopeKey, resourceId, resourceKind, relation, exactRunIdsKey, refreshFailed: false });
            } catch {
                if (cancelled || !lifetime.isCurrent()) return;
                // A failed refresh is not evidence that the Session started
                // nothing: the window keeps the membership it already proved
                // and reports staleness beside it.
                setReadState({ phase: 'failed', refreshFailed: true, accountScopeKey: requestScopeKey, resourceId, resourceKind, relation, exactRunIdsKey });
            }
        })();
        return () => {
            cancelled = true;
            controller.abort();
            retirement.dispose();
        };
    }, [accountScopeKey, enabled, exactRunIds, exactRunIdsKey, invalidationToken, lifetime, relation, resourceId, resourceKind, retainWhileResolving, windowId]);

    React.useEffect(() => {
        if (!enabled || resourceId === null || accountScopeKey === null || exactRunIds?.length === 0) return;
        if (lifetime === null || serverAccountScopeKeySuffix(lifetime.scope) !== accountScopeKey) return;
        return subscribeVisibleWorkflowRunListInvalidation({
            lifetime,
            runIds: exactRunIds,
            // This mounted, enabled window already has read demand. A wake during its first
            // read must supersede that read too, or its stale empty result can hide a new Run.
            isVisibleWindowLoaded: () => true,
            invalidate: () => setInvalidationToken((token) => token + 1),
        });
    }, [accountScopeKey, enabled, exactRunIds, lifetime, relation, resourceId, resourceKind]);

    const runs = React.useMemo(
        () => (rows.length === 0 ? EMPTY_RUNS : rows.flatMap((row) => (row.summary ? [row.summary] : []))),
        [rows],
    );
    const metadataByRunId = React.useMemo(() => {
        const entries = rows.flatMap((row) => (row.metadata ? [[row.id, row.metadata] as const] : []));
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

    const unavailable = enabled && resourceId !== null && (accountScopeKey === null || lifetime?.isCurrent() !== true);
    let exactReadPending = false;
    if ((enabled || retainWhileResolving) && exactRunIds !== undefined && !(currentRead && readState.phase === 'loaded')) {
        const loadedRunIds = new Set(runs.map(run => run.id));
        exactReadPending = exactRunIds.some(id => !loadedRunIds.has(id));
    }
    const phase: SessionManagedWorkflowRunsState['phase'] = unavailable ? 'failed' : exactRunIds?.length === 0 ? 'idle'
        : exactReadPending ? currentRead ? readState.phase : 'loading' : current ? 'loaded'
        : resourceId === null || (!enabled && !retainWhileResolving) ? 'idle' : currentRead ? readState.phase : 'loading';
    const attentionRunIds = React.useMemo(() => current && listWindow.attentionRunIds
        ? new Set(listWindow.attentionRunIds) : EMPTY_ATTENTION, [current, listWindow?.attentionRunIds]);
    const refreshFailed = unavailable || (current && retainWhileResolving) || (currentRead && readState.refreshFailed);
    const lastSuccessfulReadAt = current ? listWindow.lastSuccessfulReadAt ?? null : null;
    // One stable state object per change, as the consumers that memoize on it expect.
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
        () => (definitionValue === null ? null : projectWorkflowFlow(definitionValue)),
        [definitionValue],
    );
    return React.useMemo(() => {
        if (projection === null || definitionValue === null) return null;
        const structure = projectWorkflowInvocationStructure({ definition: definitionValue, invocations });
        return { projection, runStates: projectWorkflowFlowRunStates({ invocations, structure }) };
    }, [definitionValue, invocations, projection]);
}
