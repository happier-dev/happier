import * as React from 'react';
import type { SessionTriggerPullRequestLinksV1, WorkflowAttachedTriggerPageV1, WorkflowTriggerHealthSourceV1, WorkflowTriggerListRequestV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { getStorage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { applyWorkflowTriggerSnapshotReceipt, createWorkflowTriggerChangeSelector, createWorkflowTriggerSetSelector, EMPTY_WORKFLOW_TRIGGER_CHANGE_SIGNAL, type AutomationsDomain } from '@/sync/store/domains/automations';
import { listWorkflowTriggerPage } from '@/sync/domains/workflows/workflowTriggerActions';
import { retainDeep, retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { workflowTriggerQueryKey, workflowTriggerRequestForQueryKey } from '@/sync/domains/workflows/workflowTriggerQuery';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveHomeSettling } from '@/components/navigation/connectionStatus/HomeReachabilityGate';

const EMPTY_SETS: readonly WorkflowTriggerSetV1[] = [];
const EMPTY_HEALTH_SOURCES: readonly WorkflowTriggerHealthSourceV1[] = [];
const noRetry = () => {};

/**
 * Read lifecycle only; the existing Account Automation projection remains the row owner.
 * Hidden addressed queries retain their rows and release Home wake observation.
 * Returning demand reads again to reconcile the interval without observation.
 */
export type AttachedTriggerPage = Readonly<Omit<WorkflowAttachedTriggerPageV1, 'attached'> & {
    attached: Readonly<WorkflowAttachedTriggerPageV1['attached']>;
}>;

export function useWorkflowTriggerSets(request: WorkflowTriggerListRequestV1 | null, accountLifetime?: ServerAccountScopeLifetime | null,
    options?: Readonly<{
        demanded?: boolean;
        context?: NonNullable<Parameters<typeof listWorkflowTriggerPage>[1]>['context'];
        /** A settled exact Home binding failure; while resolving, the caller leaves this absent. */
        unavailableAccount?: Readonly<{ retry?: () => void }>;
    }>): {
    sets: readonly WorkflowTriggerSetV1[];
    healthSources: readonly WorkflowTriggerHealthSourceV1[];
    attachedPage: AttachedTriggerPage | undefined;
    /** Session context from the same admitted lifetime page, never a second list read. */
    pullRequestLinks?: SessionTriggerPullRequestLinksV1;
    loadMore: () => void;
    status: 'loading' | 'ready' | 'failed';
    failure?: unknown;
    retry: () => void;
    retryable?: boolean;
    acknowledge: (written: WorkflowTriggerSetV1) => void;
} {
    const addressed = accountLifetime !== undefined;
    const demanded = options?.demanded !== false;
    const context = options?.context;
    const unavailableAccount = options?.unavailableAccount;
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = addressed ? accountLifetime ?? null : activeLifetime;
    const scope = lifetime?.scope ?? null;
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const workflow = request && 'workflow' in request ? request.workflow : null;
    const sessionId = request && 'lifetimeSession' in request ? request.lifetimeSession.sessionId : null;
    const requestedScope = request && 'scope' in request ? request.scope : 'account_inline';
    const queryKey = request === null ? '' : workflowTriggerQueryKey(request);
    const selected = request !== null && ('subject' in request || 'actionId' in request);
    const health = request !== null && 'healthSource' in request;
    const retainFocusedSettlement = !addressed && context === undefined && queryKey === 'account_all';
    // Addressed reads for the focused Account share its canonical Automation
    // projection, including local Action receipts before a socket wake arrives.
    const focused = !addressed || Boolean(scope && activeLifetime?.isCurrent()
        && activeLifetime.scope.accountId === scope.accountId
        && areServerProfileIdentifiersEquivalent(activeLifetime.scope.serverId, scope.serverId));
    // The semantic query, not a caller's object allocation, owns the read lifetime.
    const readRequest = React.useMemo(() => workflowTriggerRequestForQueryKey(queryKey), [queryKey]);
    const readDemanded = demanded && readRequest !== null;
    const identity = React.useMemo(() => ({}), [queryKey, scopeKey, lifetime]);
    const committedIdentity = React.useRef(identity);
    React.useLayoutEffect(() => { committedIdentity.current = identity; }, [identity]);
    const selector = React.useMemo(() => focused && !health ? createWorkflowTriggerSetSelector(queryKey, workflow !== null)
        : () => EMPTY_SETS, [focused, health, queryKey, workflow]);
    const sets = getStorage()(selector);
    const changeSelector = React.useMemo<(state: AutomationsDomain) => object | number>(() => {
        if (retainFocusedSettlement) return getStorage().getState().selectFocusedAccountTriggerRevision;
        if (selected || health || !focused || queryKey === '') return () => EMPTY_WORKFLOW_TRIGGER_CHANGE_SIGNAL;
        return createWorkflowTriggerChangeSelector(sessionId, workflow, requestedScope,
            readRequest && 'managedTarget' in readRequest ? readRequest.managedTarget : undefined);
    }, [retainFocusedSettlement, selected, health, focused, queryKey, sessionId, workflow, requestedScope, readRequest]);
    const changeSignal = getStorage()(changeSelector);
    // Start from the held rows while any refresh required by the query owner runs.
    const [state, setState] = React.useState<{ identity: object; status: 'loading' | 'ready' | 'failed'; failure?: unknown }>(
        () => ({ identity, status: request === null
            || (focused && getStorage().getState().workflowTriggerSetIdsByQuery[queryKey] !== undefined) ? 'ready' : 'loading' }),
    );
    const snapshot = React.useRef<Readonly<{ identity: object; sets: readonly WorkflowTriggerSetV1[] }> | null>(null);
    const [healthSnapshot, setHealthSnapshot] = React.useState<Readonly<{
        identity: object; sources: readonly WorkflowTriggerHealthSourceV1[];
    }> | null>(null);
    const [attachments, setAttachments] = React.useState<Readonly<{ identity: object; page: AttachedTriggerPage }> | null>(null);
    const [sessionContext, setSessionContext] = React.useState<Readonly<{
        identity: object; pullRequestLinks: SessionTriggerPullRequestLinksV1;
    }> | null>(null);
    const pendingRead = React.useRef<Readonly<{ identity: object; controller: AbortController }> | null>(null);
    const acknowledge = React.useCallback((written: WorkflowTriggerSetV1) => {
        if (!addressed || queryKey === '' || committedIdentity.current !== identity || !lifetime?.isCurrent()) return;
        const previous = snapshot.current?.identity === identity ? snapshot.current.sets : EMPTY_SETS;
        const next = applyWorkflowTriggerSnapshotReceipt(previous, queryKey, written);
        if (next === null) return;
        // This consumer's pending answer predates the receipt. Shared readers keep
        // their transport; this read must not replace its acknowledgement with it.
        if (pendingRead.current?.identity === identity) pendingRead.current.controller.abort();
        snapshot.current = { identity, sets: next };
        setState(current => next === previous && current.identity === identity && current.status === 'ready'
            ? current : { identity, status: 'ready' });
    }, [addressed, identity, lifetime, queryKey]);
    React.useLayoutEffect(() => {
        // When focus moves, retain this Account's last committed projection, including
        // local write receipts. The earlier HTTP answer must not replace that view.
        if (addressed && focused && state.identity === identity && lifetime?.isCurrent()) {
            snapshot.current = { identity, sets };
        }
    }, [addressed, focused, identity, lifetime, sets, state]);
    const [attempt, setAttempt] = React.useState<Readonly<{ revision: number; cursor?: string; identity?: object }>>({ revision: 0 });
    const retryRead = React.useCallback(() => setAttempt(current => ({ revision: current.revision + 1 })), []);
    const retry = unavailableAccount ? unavailableAccount.retry ?? noRetry : retryRead;
    // The last settled answer covers the read inputs while the addressed query has demand.
    const settledRead = React.useRef<readonly unknown[] | null>(null);
    const readNotCurrent = React.useRef(false);
    readNotCurrent.current = state.identity !== identity || state.status !== 'ready';
    React.useEffect(() => {
        if (!readDemanded || !accountLifetime?.isCurrent()) return;
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, accountLifetime.scope.serverId)) return;
            // Consume the producer's admitted source/definition decision, including mixed pages.
            if (event.workflowTriggersAffect === false) return;
            retry();
        }, { reconnect: { readNotCurrent: () => readNotCurrent.current } });
        const retirement = accountLifetime.onRetire(unsubscribe);
        return () => { retirement.dispose(); unsubscribe(); };
    }, [readDemanded, accountLifetime, retry]);
    React.useEffect(() => {
        if (!readDemanded) {
            if (addressed) settledRead.current = null;
            return;
        }
        if (addressed && !accountLifetime?.isCurrent()) return;
        const inputs = [attempt, changeSignal, identity, readRequest, accountLifetime, lifetime, context];
        const covered = settledRead.current;
        if (covered && covered.length === inputs.length && covered.every((value, index) => value === inputs[index])) return;
        // No Account scope yet is not a failed read: right after sign-in the page mounts before its Account
        // is established. The lifetime is a dependency, so the read starts, and settles, once it arrives.
        if (!lifetime) {
            setState(current => current.identity === identity ? current : { identity, status: 'loading' });
            return;
        }
        if (retainFocusedSettlement && attempt.revision === 0 && getStorage().getState().hasSettledFocusedAccountTriggerRead(lifetime)) {
            settledRead.current = inputs;
            setState(current => current.identity === identity && current.status === 'ready' ? current : { identity, status: 'ready' });
            return;
        }
        const controller = new AbortController();
        const pending = { identity, controller };
        pendingRead.current = pending;
        const retirement = lifetime.onRetire(() => { controller.abort(); setState({ identity, status: 'failed' }); });
        // A settled read keeps its answer while it refreshes (a change signal or a retry after
        // success): the store still holds the last-known sets, so nothing reverts to loading.
        setState((current) => current.identity === identity
            ? current.status === 'ready' ? current : { ...current, status: 'loading' }
            : { identity, status: 'loading' });
        const cursor = attempt.identity === identity ? attempt.cursor : undefined;
        const pageRequest = selected && cursor ? { ...readRequest, cursor } : readRequest;
        const publishSessionContext = (links: SessionTriggerPullRequestLinksV1 | undefined) => {
            if (!('lifetimeSession' in readRequest)) return;
            setSessionContext(current => {
                const previous = current?.identity === identity ? current.pullRequestLinks : undefined;
                const pullRequestLinks = retainDeep(previous, links ?? { status: 'unavailable', code: 'target_unavailable' } satisfies SessionTriggerPullRequestLinksV1);
                return current?.identity === identity && pullRequestLinks === previous ? current : { identity, pullRequestLinks };
            });
        };
        listWorkflowTriggerPage(pageRequest, { signal: controller.signal, context, accountLifetime: lifetime, retainFocusedSettlement }).then(result => {
            if (!controller.signal.aborted && lifetime.isCurrent()) {
                let snapshotChanged = false;
                if (addressed && !health) {
                    const previous = snapshot.current?.identity === identity ? snapshot.current.sets : undefined;
                    const sets = retainKeyedRows(previous, result.sets, set => set.automationId);
                    snapshotChanged = sets !== previous;
                    snapshot.current = { identity, sets };
                }
                if (health) setHealthSnapshot(current => {
                    const previous = current?.identity === identity ? current.sources : undefined;
                    const sources = retainKeyedRows(previous, result.healthSources ?? EMPTY_HEALTH_SOURCES,
                        row => JSON.stringify([row.automationId, row.triggerId]));
                    return current?.identity === identity && sources === previous ? current : { identity, sources };
                });
                if (selected) setAttachments(current => {
                    const previous = current?.identity === identity ? current.page : undefined;
                    const page: AttachedTriggerPage = {
                        attached: retainKeyedRows(previous?.attached,
                            [...(cursor ? previous?.attached ?? [] : []), ...(result.attached ?? [])],
                            row => JSON.stringify([row.automationId, row.triggerId, row.relation])),
                        nextCursor: result.nextCursor ?? null,
                        // The producer reports a page-independent denied count.
                        skippedNotSharedCount: result.skippedNotSharedCount ?? 0,
                    };
                    const retained = retainDeep(previous, page);
                    return current?.identity === identity && retained === previous ? current : { identity, page: retained };
                });
                publishSessionContext(result.pullRequestLinks);
                settledRead.current = inputs;
                setState(current => !snapshotChanged && current.identity === identity && current.status === 'ready'
                    ? current : { identity, status: 'ready' });
            }
        }).catch(failure => {
            if (!controller.signal.aborted && lifetime.isCurrent()) {
                publishSessionContext(undefined);
                setState({ identity, status: 'failed', failure });
            }
        });
        return () => {
            controller.abort(); retirement.dispose();
            if (pendingRead.current === pending) pendingRead.current = null;
        };
    }, [attempt, changeSignal, readDemanded, identity, readRequest, addressed, accountLifetime, lifetime, selected, health, context, retainFocusedSettlement]);
    // A settled failure stays actionable even while realtime reconnects. Home recovery
    // still retries the read automatically without turning its failed answer into loading.
    const homeSettling = useActiveHomeSettling() && !addressed;
    const failedRef = React.useRef(false);
    failedRef.current = state.identity === identity && state.status === 'failed';
    const wasSettling = React.useRef(false);
    React.useEffect(() => {
        if (wasSettling.current && !homeSettling && failedRef.current) retry();
        wasSettling.current = homeSettling;
    }, [homeSettling, retry]);
    const status = unavailableAccount ? 'failed' as const : state.identity !== identity ? 'loading' as const : state.status;
    const attachedPage = attachments?.identity === identity && lifetime?.isCurrent() ? attachments.page : undefined;
    const loadMore = React.useCallback(() => {
        const cursor = attachedPage?.nextCursor;
        if (cursor) setAttempt(current => ({ revision: current.revision + 1, cursor, identity }));
    }, [attachedPage, identity]);
    return { sets: request === null ? EMPTY_SETS : addressed ? state.identity === identity && accountLifetime?.isCurrent()
        ? focused ? sets : snapshot.current?.identity === identity ? snapshot.current.sets : EMPTY_SETS
        : EMPTY_SETS : sets, attachedPage,
        healthSources: healthSnapshot?.identity === identity && lifetime?.isCurrent() ? healthSnapshot.sources : EMPTY_HEALTH_SOURCES,
        failure: state.identity === identity && status === 'failed' ? state.failure : undefined,
        pullRequestLinks: sessionContext?.identity === identity && lifetime?.isCurrent() ? sessionContext.pullRequestLinks : undefined,
        loadMore, status: request === null ? 'ready' as const : status, retry,
        retryable: unavailableAccount === undefined || unavailableAccount.retry !== undefined, acknowledge };
}

export { useWorkflowTriggerSetsById } from './useWorkflowTriggerSetsById';
