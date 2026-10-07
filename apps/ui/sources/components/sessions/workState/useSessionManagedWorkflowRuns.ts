import * as React from 'react';

import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';

import type {
    WorkflowRunInvocationIndexV1,
    WorkflowRunSummaryV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowRunPrivateMetadataV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { getStorage, useActiveServerAccountScope, useWorkflowRunRows } from '@/sync/domains/state/storage';
import { listWorkflowRuns } from '@/sync/domains/workflows/workflowRunListActions';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import { selectWorkflowRunWindowInvocations, workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
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
 * The managed Workflow Runs this Session started or that write into it.
 *
 * `originSessionId` selects provenance, `targetSessionId` selects destinations, and
 * `attention: 'required'` is the canonical server predicate for "this needs the
 * person". Both are asked of the same Action front door, so this hook adds no
 * second run store and invents no local attention rule — which matters because
 * an off-page approval is discoverable only through that server predicate.
 *
 * Row bodies land in the one Account-scoped Run row owner and are read back
 * from it, so a control the Run screen settles, or an exact invalidation,
 * reaches a mounted Session row at once. This hook keeps only the ordered
 * membership and attention ids of its own query, and re-asks on the same
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
    /** Re-ask this window through its existing read owner, without dropping retained rows. */
    retry: () => void;
}>;

type SessionManagedWorkflowRunsWindow = Readonly<{
    phase: SessionManagedWorkflowRunsState['phase'];
    /** The Account and Session this window was read for; anything else shows nothing. */
    accountScopeKey: string | null;
    sessionId: string | null;
    relation: 'origin' | 'destination';
    runIds: readonly string[];
    attentionRunIds: ReadonlySet<string>;
    refreshFailed: boolean;
}>;

const EMPTY_RUN_IDS: readonly string[] = Object.freeze([]);
const EMPTY_ATTENTION: ReadonlySet<string> = new Set<string>();
const EMPTY_RUNS: readonly WorkflowRunSummaryV1[] = Object.freeze([]);
const EMPTY_METADATA: Readonly<Record<string, WorkflowRunPrivateMetadataV1>> = Object.freeze({});

const EMPTY_WINDOW: SessionManagedWorkflowRunsWindow = {
    phase: 'idle',
    accountScopeKey: null,
    sessionId: null,
    relation: 'origin',
    runIds: EMPTY_RUN_IDS,
    attentionRunIds: EMPTY_ATTENTION,
    refreshFailed: false,
};

/**
 * Membership is the union of both pages, in a deterministic existing order.
 *
 * The two queries are different keysets: `attention: 'required'` is the only
 * owner of "this needs the person", and the Run it names is frequently not on
 * the general page. Taking membership from the general page alone fetched that
 * Run, recorded it as needing attention and then never rendered it — which is
 * exactly the case the server predicate exists for. The general page keeps its
 * server order and the attention-only ids follow in theirs; nothing is
 * re-sorted on the client, so a refresh cannot reshuffle rows under a reader.
 */
function unionRunIds(general: readonly string[], attention: readonly string[]): readonly string[] {
    const seen = new Set(general);
    const additional = attention.filter((runId) => !seen.has(runId));
    return additional.length === 0 ? general : [...general, ...additional];
}

export function useSessionManagedWorkflowRuns(params: Readonly<{
    sessionId: string | null;
    serverId: string | null;
    enabled?: boolean;
    /** "Writes here" uses the same Run-list owner, with its destination relation. */
    relation?: 'origin' | 'destination';
}>): SessionManagedWorkflowRunsState {
    const sessionId = params.sessionId !== null && params.sessionId.trim().length > 0 ? params.sessionId : null;
    const relation = params.relation ?? 'origin';
    // Contextual managed-Run reads answer the same canonical Workflows decision
    // the dedicated routes do, and fail closed while it is unresolved: a
    // Session's ordinary one-shot Automations stay untouched, but this surface
    // must not read or link a Workflow the Home does not offer.
    const workflows = useWorkflowsAvailability();
    const enabled = (params.enabled ?? true) && workflows.available;
    const accountScope = useActiveServerAccountScope(params.serverId);
    const accountScopeKey = accountScope === null ? null : serverAccountScopeKeySuffix(accountScope);
    const [listWindow, setWindow] = React.useState<SessionManagedWorkflowRunsWindow>(EMPTY_WINDOW);
    const [invalidationToken, setInvalidationToken] = React.useState(0);
    const retry = React.useCallback(() => setInvalidationToken((token) => token + 1), []);
    const current = accountScopeKey !== null && listWindow.accountScopeKey === accountScopeKey && listWindow.sessionId === sessionId
        && listWindow.relation === relation;
    // Only this Session's own window, never the Account's whole Run map: an
    // exact refresh of a Run outside this relation must not rerender a
    // mounted transcript section.
    const rows = useWorkflowRunRows(current ? listWindow.runIds : EMPTY_RUN_IDS);
    const windowRef = React.useRef(listWindow);
    windowRef.current = listWindow;

    React.useEffect(() => {
        if (!enabled || sessionId === null || accountScopeKey === null) {
            setWindow(EMPTY_WINDOW);
            return;
        }
        // Decrypted Account content never survives a scope change: the lifetime
        // retires this read before another Account's rows could be applied.
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null
            || serverAccountScopeKeySuffix(lifetime.scope) !== accountScopeKey) return;
        const requestScopeKey = accountScopeKey;
        const controller = new AbortController();
        let cancelled = false;
        // A re-read keeps last-known-good rows; only a first read is loading.
        setWindow((current) => (
            current.accountScopeKey === requestScopeKey && current.sessionId === sessionId && current.relation === relation && current.phase === 'loaded'
                ? current
                : { ...EMPTY_WINDOW, phase: 'loading', accountScopeKey: requestScopeKey, sessionId, relation }
        ));
        void (async () => {
            try {
                const filter = relation === 'destination' ? { targetSessionId: sessionId } : { originSessionId: sessionId };
                const [all, attention] = await Promise.all([
                    listWorkflowRuns({
                        filter,
                        signal: controller.signal,
                    }),
                    listWorkflowRuns({
                        filter: { ...filter, attention: 'required' },
                        signal: controller.signal,
                    }),
                ]);
                if (cancelled || !lifetime.isCurrent()) return;
                // Both pages' bodies land in the one Account-scoped row owner,
                // so an off-page actionable Run is the same body the exact Run
                // route resolves rather than a second, thinner copy.
                getStorage().getState().upsertWorkflowRuns([
                    ...all.runs.map((run) => workflowRunRowFromSummary(run, all.metadataByRunId[run.id] ?? null)),
                    ...attention.runs.map((run) => workflowRunRowFromSummary(
                        run,
                        attention.metadataByRunId[run.id] ?? null,
                    )),
                ]);
                setWindow({
                    phase: 'loaded',
                    relation,
                    accountScopeKey: requestScopeKey,
                    sessionId,
                    runIds: unionRunIds(
                        all.runs.map((run) => run.id),
                        attention.runs.map((run) => run.id),
                    ),
                    attentionRunIds: new Set(attention.runs.map((run) => run.id)),
                    refreshFailed: false,
                });
            } catch {
                if (cancelled || !lifetime.isCurrent()) return;
                // A failed refresh is not evidence that the Session started
                // nothing: the window keeps the membership it already proved
                // and reports staleness beside it.
                setWindow((current) => (
                    current.accountScopeKey === requestScopeKey
                        && current.sessionId === sessionId
                        && current.relation === relation
                        && current.phase === 'loaded'
                        ? { ...current, refreshFailed: true }
                        : {
                            ...EMPTY_WINDOW,
                            phase: 'failed',
                            refreshFailed: true,
                            accountScopeKey: requestScopeKey,
                            sessionId,
                            relation,
                        }
                ));
            }
        })();
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [accountScopeKey, enabled, invalidationToken, relation, sessionId]);

    React.useEffect(() => {
        if (!enabled || sessionId === null || accountScopeKey === null) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null || serverAccountScopeKeySuffix(lifetime.scope) !== accountScopeKey) return;
        return subscribeVisibleWorkflowRunListInvalidation({
            lifetime,
            isVisibleWindowLoaded: () => windowRef.current.phase === 'loaded'
                && windowRef.current.sessionId === sessionId && windowRef.current.relation === relation,
            invalidate: () => setInvalidationToken((token) => token + 1),
        });
    }, [accountScopeKey, enabled, relation, sessionId]);

    const runs = React.useMemo(
        () => (rows.length === 0 ? EMPTY_RUNS : rows.flatMap((row) => (row.summary ? [row.summary] : []))),
        [rows],
    );
    const metadataByRunId = React.useMemo(() => {
        const entries = rows.flatMap((row) => (row.metadata ? [[row.id, row.metadata] as const] : []));
        return entries.length === 0 ? EMPTY_METADATA : Object.fromEntries(entries);
    }, [rows]);

    const unavailable = enabled && sessionId !== null && accountScopeKey === null;
    const phase: SessionManagedWorkflowRunsState['phase'] = unavailable ? 'failed' : current
        ? listWindow.phase
        : sessionId === null || !enabled ? 'idle' : 'loading';
    const attentionRunIds = current ? listWindow.attentionRunIds : EMPTY_ATTENTION;
    const refreshFailed = unavailable || (current ? listWindow.refreshFailed : false);
    // One stable state object per change, as the consumers that memoize on it expect.
    return React.useMemo(
        () => ({ phase, runs, metadataByRunId, attentionRunIds, refreshFailed, retry }),
        [attentionRunIds, metadataByRunId, phase, refreshFailed, retry, runs],
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
    const accountScopeKey = accountScope === null ? null : serverAccountScopeKeySuffix(accountScope);
    const contentKey = accountScopeKey === null ? null : `${accountScopeKey}\u0000${runId}`;
    const [definition, setDefinition] = React.useState<Readonly<{ key: string; value: WorkflowDefinitionV1 }> | null>(null);
    const [invalidationToken, setInvalidationToken] = React.useState(0);
    const invocations = getStorage()((state) => (
        contentKey === null ? EMPTY_INVOCATIONS : selectWorkflowRunWindowInvocations(state.workflowRunInvocationsByRunId[runId], 'history')
    ));

    React.useEffect(() => {
        if (contentKey === null) {
            setDefinition(null);
            return;
        }
        const lifetime = captureActiveServerAccountScopeLifetime();
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
    }, [contentKey, runId]);

    React.useEffect(() => {
        if (contentKey === null) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
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
                    mode: state.workflowRunInvocationsByRunId[runId]?.history.loaded === true ? 'refresh' : 'replace',
                });
            },
            // A failed restatement keeps the last-known lifecycles.
            () => undefined,
        );
        return () => {
            controller.abort();
            retirement.dispose();
        };
    }, [contentKey, invalidationToken, runId]);

    React.useEffect(() => {
        if (contentKey === null) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null || serverAccountScopeKeySuffix(lifetime.scope) !== accountScopeKey) return;
        return subscribeVisibleWorkflowRunListInvalidation({
            lifetime,
            runId,
            isVisibleWindowLoaded: () => true,
            invalidate: () => setInvalidationToken((token) => token + 1),
        });
    }, [contentKey, runId]);

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
