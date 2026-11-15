import * as React from 'react';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerAccountScopeLifetime, useAutomationRunById } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';
import { formatAutomationErrorMessage } from '@/components/automations/automationErrorFormatting';
import type { AutomationRunDetailRouteInspection } from '@/sync/domains/automations/automationRunDetailInspection';
import type { WorkflowRunRouteTarget } from '@/sync/domains/workflows/workflowRunRoute';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { executeOccurrenceRunAction } from './occurrenceRunActions';
import { resolveWorkflowRunProblemPresentation } from '../presentation/workflowProblemPresentation';

type RouteScopedState<T> = Readonly<{
    generation: number;
    value: T;
}>;

type AccountScopedRouteState<T> = RouteScopedState<T> & Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null;
}>;

/** One exact occurrence reader and recovery owner, shared by legacy and managed Run presentation. */
export function useWorkflowOccurrenceRunDetail(props: Readonly<{
    target: Extract<WorkflowRunRouteTarget, { kind: 'occurrence' }>;
    serverId: string | null;
    active?: boolean;
}>) {
    const { automationId, runId } = props.target;
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const { binding, resolution } = useServerCredentialAccountScopeBinding(props.serverId);
    const accountLifetime = props.serverId ? binding : activeLifetime;
    const scopeUnavailable = props.serverId !== null && resolution.kind !== 'resolving' && binding === null;
    // Resolved from the one Account-scoped Run row owner by exact `runId`. The
    // Automation is route provenance here, not the key: a Run reached by deep
    // link or notification resolves the same body with no list loaded.
    const activeCachedRun = useAutomationRunById(runId);
    const cachedRun = areServerAccountScopesEqual(activeLifetime?.scope, accountLifetime?.scope) ? activeCachedRun : null;
    const routeCurrentRef = React.useRef({
        automationId,
        runId,
        accountLifetime,
        generation: 0,
        mounted: true,
    });
    // Direct reads started before a mutation must not reclaim this route
    // after its fresh post-mutation projection arrives.
    const directReadEpochRef = React.useRef(0);
    if (
        routeCurrentRef.current.automationId !== automationId
        || routeCurrentRef.current.runId !== runId
        || routeCurrentRef.current.accountLifetime !== accountLifetime
    ) {
        routeCurrentRef.current = {
            automationId,
            runId,
            accountLifetime,
            generation: routeCurrentRef.current.generation + 1,
            mounted: routeCurrentRef.current.mounted,
        };
    }
    const routeGeneration = routeCurrentRef.current.generation;
    React.useEffect(() => {
        routeCurrentRef.current.mounted = true;
        return () => {
            routeCurrentRef.current.mounted = false;
        };
    }, []);
    const isCurrentRoute = React.useCallback((expectedAutomationId: string | null, expectedRunId: string | null, expectedGeneration: number): boolean => {
        const current = routeCurrentRef.current;
        return current.mounted
            && current.accountLifetime?.isCurrent() === true
            && current.automationId === expectedAutomationId
            && current.runId === expectedRunId
            && current.generation === expectedGeneration;
    }, []);
    const [directDetailState, setDirectDetailState] = React.useState<AccountScopedRouteState<AutomationRunDetailRouteInspection | null>>({
        generation: routeGeneration,
        accountLifetime,
        value: null,
    });
    const [loadingState, setLoadingState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: cachedRun === null,
    });
    const [loadFailureState, setLoadFailureState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: false,
    });
    const [cancellingState, setCancellingState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: false,
    });
    const [retryingReplyHandoffState, setRetryingReplyHandoffState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: false,
    });
    const [redeliveringResultState, setRedeliveringResultState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: false,
    });
    const directDetail = directDetailState.generation === routeGeneration
        && directDetailState.accountLifetime === accountLifetime
        && accountLifetime?.isCurrent() === true
        ? directDetailState.value
        : null;
    const directDetailIsCurrent = directDetail !== null
        && (!cachedRun || directDetail.detail.revision > cachedRun.revision
            || (directDetail.detail.revision === cachedRun.revision
                && directDetail.detail.updatedAt >= cachedRun.updatedAt));
    const run = directDetailIsCurrent
        ? directDetail.detail
        : cachedRun;
    const runProblem = run ? resolveWorkflowRunProblemPresentation(run) : null;
    const privateContent = directDetailIsCurrent
        ? directDetail.privateContent
        : null;
    const loading = loadingState.generation !== routeGeneration || loadingState.value
        || (props.serverId !== null && resolution.kind === 'resolving');
    const loadFailed = loadFailureState.generation === routeGeneration && loadFailureState.value;
    const readNotCurrent = React.useRef(false);
    readNotCurrent.current = loadFailed || directDetail === null;
    const cancelling = cancellingState.generation === routeGeneration && cancellingState.value;
    const retryingReplyHandoff = retryingReplyHandoffState.generation === routeGeneration
        && retryingReplyHandoffState.value;
    const redeliveringResult = redeliveringResultState.generation === routeGeneration
        && redeliveringResultState.value;

    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(() => {
            directReadEpochRef.current += 1;
            setDirectDetailState((current) => (
                current.accountLifetime === accountLifetime
                    ? { ...current, value: null }
                    : current
            ));
        });
        return () => retirement?.dispose();
    }, [accountLifetime]);

    const refresh = React.useCallback(() => {
        const request = {
            automationId,
            runId,
            generation: routeGeneration,
            directReadEpoch: directReadEpochRef.current,
            accountLifetime,
        };
        const isCurrentRequest = () => (
            isCurrentRoute(request.automationId, request.runId, request.generation)
            && request.accountLifetime?.isCurrent() === true
        );
        if (!automationId || !runId || !request.accountLifetime?.isCurrent()) {
            if (isCurrentRoute(request.automationId, request.runId, request.generation)) {
                setDirectDetailState({
                    generation: request.generation,
                    accountLifetime: request.accountLifetime,
                    value: null,
                });
                setLoadingState({ generation: request.generation, value: false });
                setLoadFailureState({ generation: request.generation, value: false });
            }
            return;
        }

        setLoadFailureState({ generation: request.generation, value: false });
        if (!cachedRun) {
            setLoadingState({ generation: request.generation, value: true });
        }
        const directRead = sync.getAutomationRunDetailInspection(automationId, runId,
            props.serverId ? { accountLifetime } : {})
            .then((detail) => {
                if (
                    !isCurrentRequest()
                    || directReadEpochRef.current !== request.directReadEpoch
                ) return;
                setDirectDetailState({
                    generation: request.generation,
                    accountLifetime: request.accountLifetime,
                    value: detail,
                });
            })
            // A direct route read may fail, but Account material/currentness
            // unavailability is represented by the route projection itself.
            // Keep the bounded cached Run projection visible on transport
            // failure and never surface raw envelope bytes.
            .catch(() => {
                if (isCurrentRequest()) {
                    setLoadFailureState({ generation: request.generation, value: true });
                }
            });
        const rootPageRefresh = cachedRun || props.serverId
            ? Promise.resolve()
            : sync.fetchAutomationRuns(automationId).catch(() => {
                if (isCurrentRequest()) {
                    setLoadFailureState({ generation: request.generation, value: true });
                }
            });

        void Promise.all([directRead, rootPageRefresh])
            .finally(() => {
                if (isCurrentRequest()) {
                    setLoadingState({ generation: request.generation, value: false });
                }
            });
    }, [accountLifetime, automationId, cachedRun, isCurrentRoute, props.serverId, routeGeneration, runId]);

    React.useEffect(() => {
        if (props.active !== false) refresh();
    }, [props.active, refresh]);
    React.useEffect(() => props.active === false || !props.serverId ? undefined : subscribeHomeAccountChange(event => {
        if (areServerProfileIdentifiersEquivalent(event.serverId, props.serverId)) refresh();
    }, { reconnect: { readNotCurrent: () => readNotCurrent.current } }), [props.active, props.serverId, refresh]);

    const handleCancel = React.useCallback(async () => {
        if (!runId || !run) return;
        const request = { automationId, runId, generation: routeGeneration };
        if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
        try {
            setCancellingState({ generation: request.generation, value: true });
            if (!await executeOccurrenceRunAction('workflow.run.cancel', { runId: request.runId, expectedRevision: run.revision }, accountLifetime)) return;
            if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
            directReadEpochRef.current += 1;
            refresh();
        } catch (error) {
            if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
            await Modal.alert(
                t('common.error'),
                formatAutomationErrorMessage(error, t('automations.detail.runFailed')),
            );
        } finally {
            if (isCurrentRoute(request.automationId, request.runId, request.generation)) {
                setCancellingState({ generation: request.generation, value: false });
            }
        }
    }, [accountLifetime, automationId, isCurrentRoute, refresh, routeGeneration, run, runId]);

    const handleRetryReplyHandoff = React.useCallback(async () => {
        if (!runId) return;
        const request = { automationId, runId, generation: routeGeneration };
        try {
            setRetryingReplyHandoffState({ generation: request.generation, value: true });
            if (!await executeOccurrenceRunAction('automation.run.reply_handoff.retry', { runId: request.runId }, accountLifetime)) return;
            if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
            directReadEpochRef.current += 1;
            if (props.serverId) { refresh(); return; }
            setDirectDetailState({
                generation: request.generation,
                accountLifetime,
                value: null,
            });
        } catch (error) {
            if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
            await Modal.alert(
                t('common.error'),
                formatAutomationErrorMessage(error, t('automations.detail.runFailed')),
            );
        } finally {
            if (isCurrentRoute(request.automationId, request.runId, request.generation)) {
                setRetryingReplyHandoffState({ generation: request.generation, value: false });
            }
        }
    }, [accountLifetime, automationId, isCurrentRoute, props.serverId, refresh, routeGeneration, runId]);

    /**
     * Sends the same result to the same conversation as a new delivery. It is
     * offered only for custody the channel already accepted, because that is
     * the one outcome the product cannot confirm for the user: a retry there
     * would rejoin the delivery they are unsure about and change nothing.
     * The revision shown on screen is what is authorized, so a second press
     * after the Run moved is refused instead of sending twice.
     */
    const handleDeliverResultAgain = React.useCallback(async (expectedRevision: number) => {
        if (!runId) return;
        const request = { automationId, runId, generation: routeGeneration };
        if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
        try {
            setRedeliveringResultState({ generation: request.generation, value: true });
            if (!await executeOccurrenceRunAction('automation.run.result.redeliver', { runId: request.runId, expectedRevision }, accountLifetime)) return;
            if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
            directReadEpochRef.current += 1;
            if (props.serverId) { refresh(); return; }
            setDirectDetailState({
                generation: request.generation,
                accountLifetime,
                value: null,
            });
        } catch (error) {
            if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
            await Modal.alert(
                t('common.error'),
                formatAutomationErrorMessage(error, t('automations.detail.runFailed')),
            );
        } finally {
            if (isCurrentRoute(request.automationId, request.runId, request.generation)) {
                setRedeliveringResultState({ generation: request.generation, value: false });
            }
        }
    }, [accountLifetime, automationId, isCurrentRoute, props.serverId, refresh, routeGeneration, runId]);

    return { accountLifetime, scopeUnavailable, run, runProblem, privateContent,
        currentDetail: directDetailIsCurrent ? directDetail : null,
        loading, loadFailed, cancelling, retryingReplyHandoff, redeliveringResult,
        refresh, handleCancel, handleRetryReplyHandoff, handleDeliverResultAgain };
}
