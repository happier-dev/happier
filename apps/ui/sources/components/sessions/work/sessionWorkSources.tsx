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
import { getAgentCore } from '@/agents/catalog/catalog';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { getStorage } from '@/sync/domains/state/storage';
import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { readSessionWorkStalled, readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { getSessionName } from '@/utils/sessions/sessionUtils';

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
 * items of the same projection through context, so the two can never count differently and opening the
 * tab asks the server for nothing the host has not already read.
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

function readAgentLabel(agentId: string | null): string | null {
    if (!agentId) return null;
    const core = getAgentCore(agentId);
    return core ? t(core.displayNameKey) : null;
}

export function toWorkReportSessionSource(session: Session, nowMs: number): WorkReportSessionSource {
    const agentId = readSessionPresentationAgentId(session);
    const agentLabel = readAgentLabel(agentId);
    return {
        sessionId: session.id,
        leadSessionId: normalizeId(session.reportsTo?.sessionId),
        title: getSessionName(session, session.serverId ?? null),
        agentId,
        facts: agentLabel ? [agentLabel] : [],
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
    const workflowActivity = useSessionWorkflowActivity({
        sessionId: params.sessionId,
        ...(params.serverId ? { serverId: params.serverId } : {}),
        metadata: params.ownerMetadata,
        enabled,
    });
    const managedRuns = useSessionManagedWorkflowRuns({ sessionId: params.sessionId, serverId: params.serverId, enabled });
    const reportSessions = getStorage()(useShallow((state) => (
        enabled ? selectSessionReportSubtree(state.sessions, params.sessionId, params.serverId) : EMPTY_SESSIONS
    )));
    // The Account's Automation record is stable between Automation changes; only those re-derive.
    const automations = getStorage()((state) => (enabled ? state.automations : EMPTY_AUTOMATIONS));
    const ownTriggerRunIds = React.useMemo(
        () => readOwnTriggerRunIds({ sessionId: params.sessionId, runs: managedRuns.runs, automations }),
        [automations, managedRuns.runs, params.sessionId],
    );

    const { entries } = params.agentActivity;
    const projection = React.useMemo(() => {
        const nowMs = Date.now();
        return projectWork({
            sessionId: params.sessionId,
            reportSessions: reportSessions.map((session) => toWorkReportSessionSource(session, nowMs)),
            agentEntries: entries,
            workflowHeadlineRuns: workflowActivity.activeRuns,
            managedRuns: toManagedRunSources(managedRuns),
            ownTriggerRunIds,
            describeAgentStatus: (entry) => resolveAgentActivityStatusPresentation(entry.status).label,
            describeProgress,
        });
    }, [entries, managedRuns, ownTriggerRunIds, params.sessionId, reportSessions, workflowActivity.activeRuns]);

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
