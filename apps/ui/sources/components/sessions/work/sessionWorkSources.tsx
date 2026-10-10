import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { SessionAgentActivityState } from '@/hooks/session/useSessionAgentActivity';
import { resolveAgentActivityStatusPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import {
    useSessionManagedWorkflowRuns,
    type SessionManagedWorkflowRunsState,
} from '@/components/sessions/workState/useSessionManagedWorkflowRuns';
import {
    useSessionWorkflowActivity,
    type SessionWorkflowActivityState,
} from '@/components/sessions/workState/useSessionWorkflowActivity';
import {
    formatWorkflowRunDisplayName,
    resolveWorkflowRunDisplayName,
} from '@/components/workflows/presentation/workflowRunDisplayName';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { getStorage } from '@/sync/domains/state/storage';
import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { readSessionWorkStalled, readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { getSessionName, getSessionWorkContext } from '@/utils/sessions/sessionUtils';
import { describeActionOperationStatusLabel, resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useSessionActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { registerMountedWorkReadOwner } from '@/sync/ops/actions/mountedWorkReadAction';
export { sessionInstructionsActions } from '@/sync/ops/promptLibrary/sessionInstructions';

import { selectSessionReportSubtree } from './reportSubtree';
import {
    EMPTY_WORK_SUMMARY,
    areWorkSummariesEqual,
    projectWork,
    type WorkManagedRunSource,
    type WorkProjection,
    type WorkReportSessionSource,
    type WorkSummary,
} from './workProjection';

/**
 * The one owner of a Session's Work sources (ORC R-09).
 *
 * The Session host mounts it ONCE, beside the header it feeds: the agent activity (narrow width, which
 * the host already pays for), the workflow activity headline, the managed workflow runs and the
 * `reportsTo` subtree. The header strip reads only the value-stable `summary`; the Work tab reads the
 * items of the same projection through context, so the two can never count differently. Instruction
 * content is not a source here: only the open Work tab's Instructions section demands the current
 * qualified document (`useSessionInstructionsDetail`), so the permanent header and roster never read it.
 */

export type SessionWorkSources = Readonly<{
    sessionId: string;
    serverId: string | null;
    workflowActivity: SessionWorkflowActivityState;
    managedRuns: SessionManagedWorkflowRunsState;
    agentActivity: SessionAgentActivityState;
    projection: WorkProjection;
}>;

const SessionWorkSourcesContext = React.createContext<SessionWorkSources | null>(null);

export const SessionWorkSourcesProvider = SessionWorkSourcesContext.Provider;

/** The Work sources of the Session this surface is mounted under, or null outside a Session host. */
export function useSessionWorkSources(): SessionWorkSources | null {
    return React.useContext(SessionWorkSourcesContext);
}

const EMPTY_SESSIONS: readonly Session[] = Object.freeze([]);
const EMPTY_TRIGGER_RUN_IDS: ReadonlySet<string> = new Set();
const EMPTY_AUTOMATIONS: Readonly<Record<string, AutomationDefinition>> = Object.freeze({});

function normalizeId(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

export function toWorkReportSessionSource(session: Session, nowMs: number): WorkReportSessionSource {
    const agentId = readSessionPresentationAgentId(session);
    const context = getSessionWorkContext(session, session.serverId);
    return {
        sessionId: session.id,
        leadSessionId: normalizeId(session.reportsTo?.sessionId),
        title: getSessionName(session, session.serverId ?? null),
        agentId,
        facts: context ? [context] : [],
        statusFacts: readSessionWorkStatusFacts(session, nowMs),
        stalled: readSessionWorkStalled(session, nowMs),
        archived: typeof session.archivedAt === 'number',
    };
}

function toManagedRunSources(state: SessionManagedWorkflowRunsState): readonly WorkManagedRunSource[] {
    return state.runs.map((run) => ({
        run,
        title: formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(state.metadataByRunId?.[run.id])),
        word: describeWorkflowRunState(run.state).label,
        needsAttention: state.attentionRunIds.has(run.id),
    }));
}

/**
 * The Session's own trigger runs (INT §6 I4, ORC R-09): FIN's immutable cause names a trigger and the
 * origin Automation is scoped to this Session. Manual and unknown causes stay in Work, even when
 * the Automation is session-scoped. A retired trigger retains its cause identity; no title, timing,
 * origin Session or current trigger-list membership is used to guess a Run's cause.
 * They belong to the Session's Triggers section, not to its Work.
 */
export function readOwnTriggerRunIds(params: Readonly<{
    sessionId: string;
    runs: SessionManagedWorkflowRunsState['runs'];
    automations: Readonly<Record<string, Pick<AutomationDefinition, 'scopeSessionId'>>>;
}>): ReadonlySet<string> {
    let ids: Set<string> | null = null;
    for (const run of params.runs) {
        if (run.origin.kind !== 'automation') continue;
        const cause = run.origin.cause;
        if (cause?.kind !== 'trigger' && !(cause?.kind === 'conversation' && cause.triggerId !== undefined)) continue;
        if (params.automations[run.origin.automationId]?.scopeSessionId !== params.sessionId) continue;
        (ids ??= new Set()).add(run.id);
    }
    return ids ?? EMPTY_TRIGGER_RUN_IDS;
}

function describeProgress(progress: Readonly<{ completed: number; total: number }>): string {
    return t('sessionWork.progress', progress);
}

function describeOperationStatus(operation: ActionOperationProjection): string {
    const { label } = resolveActionOperationStatus(operation.snapshot, operation.observation);
    return describeActionOperationStatusLabel(label);
}

/**
 * Mounts the Work sources for one Session and projects them once.
 *
 * `agentActivity` is the host's existing narrow-width read: passing it in keeps one subscription.
 */
export function useSessionWorkSourcesOwner(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    ownerMetadata: unknown;
    agentActivity: SessionAgentActivityState;
    enabled?: boolean;
}>): SessionWorkSources {
    const enabled = params.enabled ?? true;
    const operationServerId = enabled && params.serverId
        ? resolveServerProfileScopeIdForIdentifier(params.serverId) : null;
    const credentialHomes = React.useMemo(() => operationServerId ? [operationServerId] : [], [operationServerId]);
    const credentialBindings = useServerCredentialAccountScopeBindings(credentialHomes);
    const operationBinding = operationServerId ? credentialBindings.get(operationServerId) : undefined;
    const operationAccountId = operationBinding?.isCurrent() ? operationBinding.accountId : null;
    const actionOperations = useSessionActionOperations({
        serverId: operationServerId, sessionId: params.sessionId, accountId: operationAccountId,
    });
    const workflowActivity = useSessionWorkflowActivity({
        sessionId: params.sessionId,
        ...(params.serverId ? { serverId: params.serverId } : {}),
        metadata: params.ownerMetadata,
        enabled,
    });
    const managedRuns = useSessionManagedWorkflowRuns({ sessionId: params.sessionId, serverId: params.serverId, enabled });
    const reportSessions = getStorage()(useShallow((state) => (
        enabled ? selectSessionReportSubtree(state.sessions, params.sessionId, params.serverId, state.sessionListRowsByServerId) : EMPTY_SESSIONS
    )));
    // Identity also depends on the named machine/workspace, not just the Session record. Only
    // changed displayed facts invalidate Work; unrelated machine or settings updates stay local.
    const reportContexts = getStorage()(useShallow(() => reportSessions.map(session => getSessionWorkContext(session, session.serverId))));
    // The Account's Automation record is stable between Automation changes; only those re-derive.
    const automations = getStorage()((state) => (enabled ? state.automations : EMPTY_AUTOMATIONS));
    const ownTriggerRunIds = React.useMemo(
        () => readOwnTriggerRunIds({ sessionId: params.sessionId, runs: managedRuns.runs, automations }),
        [automations, managedRuns.runs, params.sessionId],
    );

    const { entries } = params.agentActivity;
    const previousProjection = React.useRef<Readonly<{
        sessionId: string; serverId: string | null; accountId: string | null; projection: WorkProjection;
    }> | null>(null);
    const projection = React.useMemo(() => {
        const nowMs = Date.now();
        const previous = previousProjection.current;
        const next = projectWork({
            sessionId: params.sessionId,
            serverId: operationServerId,
            accountId: operationAccountId,
            actionOperations,
            describeOperationStatus,
            reportSessions: reportSessions.map((session) => toWorkReportSessionSource(session, nowMs)),
            agentEntries: entries,
            workflowHeadlineRuns: workflowActivity.activeRuns,
            managedRuns: toManagedRunSources(managedRuns),
            ownTriggerRunIds,
            describeAgentStatus: (entry) => resolveAgentActivityStatusPresentation(entry.status).label,
            describeProgress,
        }, previous?.sessionId === params.sessionId && previous.serverId === operationServerId && previous.accountId === operationAccountId
            ? previous.projection : null);
        previousProjection.current = { sessionId: params.sessionId, serverId: operationServerId, accountId: operationAccountId, projection: next };
        return next;
    }, [actionOperations, entries, managedRuns, operationAccountId, operationServerId, ownTriggerRunIds, params.sessionId, reportContexts, reportSessions, workflowActivity.activeRuns]);

    React.useLayoutEffect(() => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!enabled || !operationBinding || !lifetime
            || !areServerAccountScopesEqual(operationBinding.scope, lifetime.scope)) return;
        return registerMountedWorkReadOwner({
            scope: operationBinding.scope, sessionId: params.sessionId,
            isCurrent: () => operationBinding.isCurrent() && lifetime.isCurrent(),
            read: () => ({ projection, managedRuns,
                transcriptLoaded: getStorage().getState().sessionMessages[params.sessionId]?.isLoaded ?? false }),
        });
    }, [enabled, managedRuns, operationBinding, params.sessionId, projection]);

    return React.useMemo(() => ({
        sessionId: params.sessionId,
        serverId: params.serverId,
        workflowActivity,
        managedRuns,
        agentActivity: params.agentActivity,
        projection,
    }), [managedRuns, params.agentActivity, params.serverId, params.sessionId, projection, workflowActivity]);
}

/**
 * The closed summary, value-stable: a new projection with the same counts keeps the previous object,
 * so the header it feeds keeps its identity across unrelated updates.
 */
export function useStableWorkSummary(summary: WorkSummary | null | undefined): WorkSummary {
    const next = summary ?? EMPTY_WORK_SUMMARY;
    const ref = React.useRef<WorkSummary>(next);
    if (!areWorkSummariesEqual(ref.current, next)) ref.current = next;
    return ref.current;
}

/** What a Session body reads before its Work sources exist (no Session, or outside a host). */
export const EMPTY_SESSION_WORKFLOW_ACTIVITY: SessionWorkflowActivityState = Object.freeze({
    headline: null,
    activeRuns: Object.freeze([]),
    runDetailById: new Map(),
    loadedRunsById: new Map(),
});

export const IDLE_SESSION_MANAGED_WORKFLOW_RUNS: SessionManagedWorkflowRunsState = Object.freeze({
    phase: 'idle',
    runs: Object.freeze([]),
    attentionRunIds: new Set<string>(),
    refreshFailed: false,
    retry: () => {},
});
