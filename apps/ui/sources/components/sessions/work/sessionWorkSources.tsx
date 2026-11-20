import * as React from 'react';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { useShallow } from 'zustand/react/shallow';

import type { SessionAgentActivityState } from '@/hooks/session/useSessionAgentActivity';
import { resolveAgentActivityStatusPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import {
    useSessionManagedWorkflowRuns,
    type SessionManagedWorkflowRunsState,
} from '@/components/workflows/run/useContextManagedWorkflowRuns';
import {
    useSessionWorkflowActivity,
    type SessionWorkflowActivityState,
} from '@/components/sessions/workState/useSessionWorkflowActivity';
import {
    formatWorkflowRunDisplayName,
    resolveWorkflowRunDisplayName,
} from '@/components/workflows/presentation/workflowRunDisplayName';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { getStorage } from '@/sync/domains/state/storage';
import { readSessionPresentationRecord, readSessionPresentationInputSource, readSessionPresentationInputDisplay,
    type SessionRelationRecord, type SessionPresentationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { resolveSessionListHomeKey } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { EMPTY_SESSION_RELATION_FACTS } from '@/sync/store/domains/sessionRelations';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { sessionWorkStalledFromStatus, readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';
import { getSessionWorkContextParts } from '@/utils/sessions/sessionUtils';
import { readStoredSessionTranscriptForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import { sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { describeWorkerUpdateHeadline } from '@/components/work/status/resolveWorkStatusTone';
import { describeActionOperationStatusLabel, resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useSessionActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { registerMountedWorkReadOwner } from '@/sync/ops/actions/mountedWorkReadAction';
export { sessionInstructionsActions } from '@/sync/ops/promptLibrary/sessionInstructions';

import { readSessionRelationRecord, selectSessionReportIds } from './reportSubtree';
import { readOwnTriggerRunIds } from './workflowRunTriggerScope';
import { SessionWorkPresentationContext, type SessionWorkPresentationBinding } from './sessionWorkPresentation';
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
 * `manager` subtree. The header strip reads only the value-stable `summary`; the Work tab reads the
 * items of the same projection through context, so the two can never count differently. Instruction
 * content is not a source here: only the open Work tab's Instructions section demands the current
 * qualified document (`useSessionInstructionsDetail`), so the permanent header and roster never read it.
 */

export type SessionWorkSources = Readonly<{
    sessionId: string;
    serverId: string | null;
    runningWorkCount?: number;
    workflowActivity: SessionWorkflowActivityState;
    managedRuns: SessionManagedWorkflowRunsState;
    agentActivity: SessionAgentActivityState;
    projection: WorkProjection;
}>;

const SessionWorkSourcesContext = React.createContext<SessionWorkSources | null>(null);

export function SessionWorkSourcesProvider(props: Readonly<{ value: SessionWorkSources | null; children: React.ReactNode }>) {
    const presentationRef = React.useRef<SessionWorkPresentationBinding | null>(null);
    return (
        <SessionWorkSourcesContext.Provider value={props.value}>
            <SessionWorkPresentationContext.Provider value={presentationRef}>
                {props.children}
            </SessionWorkPresentationContext.Provider>
        </SessionWorkSourcesContext.Provider>
    );
}

/** The Work sources of the Session this surface is mounted under, or null outside a Session host. */
export function useSessionWorkSources(): SessionWorkSources | null {
    return React.useContext(SessionWorkSourcesContext);
}

const EMPTY_SESSIONS: readonly (SessionPresentationRecord | undefined)[] = Object.freeze([]);

function mapReportInputs<T>(inputs: readonly (SessionPresentationRecord | undefined)[], serverId: string | null,
    project: (source: SessionRelationRecord) => T): T[] {
    const result: T[] = [];
    for (let index = 0; index < inputs.length; index += 2) {
        const record = inputs[index];
        if (!record) continue;
        const base = inputs[index + 1];
        result.push(project({ record, serverId: serverId ?? undefined,
            baseSession: base && 'agentState' in base ? base : undefined }));
    }
    return result;
}

function normalizeId(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

/**
 * What a Session row says it is doing: what it waits on (a question, or the tool it wants permission
 * to use), otherwise its latest update to the lead (the WorkerUpdate headline the lead's transcript
 * already holds). Nothing else is invented: a working or quiet Session says only its kind. A compact
 * list row knows that an approval is waiting (its attention type) but holds no request body, so it says only that.
 */
function readSessionWorkActivity(
    statusFacts: WorkReportSessionSource['statusFacts'],
    workerUpdateHeadline: string | undefined,
): string | null {
    const request = statusFacts.currentRequest;
    if (request?.kind === 'permission') {
        const tool = resolveToolHeaderTextPresentation({ tool: {
            name: request.tool, state: 'running', input: request.arguments,
            createdAt: request.createdAt ?? 0, startedAt: null, completedAt: null, description: null,
        }, metadata: null }).title;
        return t('sessionWork.row.needsApproval', { tool });
    }
    if (request?.questionV1) return t('sessionWork.row.asksQuestion');
    if (statusFacts.attentionType === 'approval') return t('sessionWork.row.asksPermission');
    return workerUpdateHeadline?.trim() || null;
}

export function toWorkReportSessionSource(
    input: SessionRelationRecord,
    nowMs: number,
    context: Readonly<{ leadLocation?: string | null; workerUpdateHeadline?: string }> = {},
): WorkReportSessionSource {
    const session = readSessionPresentationRecord(input);
    const presentationSource = readSessionPresentationInputSource(input);
    const display = readSessionPresentationInputDisplay(input);
    const agentId = readSessionPresentationAgentId(display);
    // The mark already says the engine, and every report runs where its lead does: a machine is said
    // only when this report runs somewhere else.
    const location = getSessionWorkContextParts(display, display.serverId).locationLabel;
    const statusFacts = readSessionWorkStatusFacts(session, nowMs, presentationSource);
    return {
        sessionId: session.id,
        managerSessionId: normalizeId(readSessionManagerSessionIdV1(presentationSource?.relations ?? session)),
        // The one display-title owner: a row whose content is still undecided names itself like the sidebar does
        // ("Encrypted session"), not "Untitled session", until hydration settles it.
        title: sessionDisplayTitle(display),
        agentId,
        facts: location && location !== context.leadLocation ? [location] : [],
        activity: readSessionWorkActivity(statusFacts, context.workerUpdateHeadline),
        atMs: resolveSessionListRenderableMeaningfulActivityAt({ ...(presentationSource?.lifecycle ?? session), createdAt: session.createdAt }),
        statusFacts,
        stalled: sessionWorkStalledFromStatus(presentationSource?.lifecycle ?? session, statusFacts),
        archived: typeof session.archivedAt === 'number',
    };
}

function toManagedRunSources(state: SessionManagedWorkflowRunsState): readonly WorkManagedRunSource[] {
    return state.runs.map((run) => ({
        run,
        title: formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(state.metadataByRunId?.[run.id])),
        word: readWorkflowRunWorkStatusFacts(run).word,
        time: formatAsOfTime(Date.parse(run.finishedAt ?? run.updatedAt)),
    }));
}

function describeProgress(progress: Readonly<{ completed: number; total: number }>): string {
    return t('sessionWork.progress', progress);
}

function describeReportsTo(lead: string): string {
    return t('sessionWork.row.reportsTo', { lead });
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
    runningWorkCount?: number;
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
    // Select the admitted inputs before walking the inventory. Other domains and Homes can publish
    // without changing this subtree's source references.
    const relations = getStorage()((state) => {
        const key = enabled ? resolveSessionListHomeKey(state.sessionRelationsByServerId, params.serverId) : null;
        return key ? state.sessionRelationsByServerId[key] ?? EMPTY_SESSION_RELATION_FACTS : EMPTY_SESSION_RELATION_FACTS;
    });
    const reportIds = React.useMemo(() => selectSessionReportIds(relations, params.sessionId), [relations, params.sessionId]);
    const reportSessions = getStorage()(useShallow((state) => enabled ? reportIds.flatMap(id => {
        const input = readSessionRelationRecord(state.sessions, id, params.serverId, state.sessionListRowsByServerId);
        return input ? [readSessionPresentationRecord(input), 'record' in input ? input.baseSession : undefined] : [];
    }) : EMPTY_SESSIONS));
    // Identity also depends on the named machine/workspace, not just the Session record. Only
    // changed displayed facts invalidate Work; unrelated machine or settings updates stay local.
    const reportContexts = getStorage()(useShallow(() => mapReportInputs(reportSessions, params.serverId, input => {
        const display = readSessionPresentationInputDisplay(input);
        return getSessionWorkContextParts(display, display.serverId).locationLabel;
    })));
    // The lead's own machine and the latest update each report sent it, read where the Work tab shows them.
    const leadLocation = getStorage()((state) => {
        const lead = enabled ? state.sessions[params.sessionId] : undefined;
        return lead ? getSessionWorkContextParts(lead, lead.serverId).locationLabel : null;
    });
    const workerUpdateHeadlines = getStorage()((state) => (enabled
        ? readStoredSessionTranscriptForAddress(state, normalizeSessionAddress(params.serverId, params.sessionId))?.latestWorkerUpdates?.session
        : undefined));
    const ownTriggerRunIds = React.useMemo(
        () => readOwnTriggerRunIds({ sessionId: params.sessionId, runs: managedRuns.runs }),
        [managedRuns.runs, params.sessionId],
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
            reportSessions: mapReportInputs(reportSessions, params.serverId, input => {
                const update = workerUpdateHeadlines?.[readSessionPresentationRecord(input).id];
                return toWorkReportSessionSource(input, nowMs, {
                    leadLocation, workerUpdateHeadline: update ? describeWorkerUpdateHeadline(update, {
                        title: sessionDisplayTitle(readSessionPresentationInputDisplay(input)),
                    }) : undefined,
                });
            }),
            agentEntries: entries,
            workflowHeadlineRuns: workflowActivity.activeRuns,
            managedRuns: toManagedRunSources(managedRuns),
            ownTriggerRunIds,
            describeAgentStatus: (entry) => resolveAgentActivityStatusPresentation(entry.status, entry.isActive).label,
            describeProgress,
            describeReportsTo,
        }, previous?.sessionId === params.sessionId && previous.serverId === operationServerId && previous.accountId === operationAccountId
            ? previous.projection : null);
        previousProjection.current = { sessionId: params.sessionId, serverId: operationServerId, accountId: operationAccountId, projection: next };
        return next;
    }, [actionOperations, entries, leadLocation, managedRuns, operationAccountId, operationServerId, ownTriggerRunIds, params.sessionId, reportContexts, reportSessions, workerUpdateHeadlines, workflowActivity.activeRuns]);

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
        runningWorkCount: params.runningWorkCount,
        projection,
    }), [managedRuns, params.agentActivity, params.runningWorkCount, params.serverId, params.sessionId, projection, workflowActivity]);
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
