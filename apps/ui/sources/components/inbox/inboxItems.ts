import type { InboxWorkGroup } from '@/activity/presentation/buildInboxWorkGroups';
import type { useManagedMachineDeletionAttention } from '@/activity/source/useManagedMachineDeletionSource';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { classifyInboxSessionCandidate, type InboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { type AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { projectAccountNoticeInboxItemV1, projectOpenUsageNoticeHeaderV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { shallow } from 'zustand/shallow';
import { readInboxApprovalServerId, resolveInboxItemPageRoute, type InboxItemFocus } from './inboxItemFocus';
import { readInboxWorkflowRunTitle } from './workGroups/inboxWorkflowReason';
import { formatAutomationRunStateLabel } from '@/components/automations/list/automationListFormatting';
import { reviewSubjectLabel } from '@/components/reviews/list/reviewSubjectLabel';
import { formatReviewRequesterByline, reviewRequesterPrincipal } from '@/components/reviews/reviewRequesterPresentation';
import type { SessionQuestionContextV1 } from '@happier-dev/protocol/sessions/permissions/questionV1';
import type { PersonalFollowOnceOccurrenceV1, PersonalRunFollowOnceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import type { DiscussionAnchorV1 } from '@happier-dev/protocol/discussions/replyTargets';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { readDiscussionMessagePreview } from '@/components/discussions/discussionTimelineProjection';
import { isInboxSessionStatusOnly, readInboxSessionTitle } from './sessionAttention/inboxSessionPrivacy';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { resolveExecutionRunTitle } from '@/components/sessions/runs/resolveExecutionRunTitle';
import { isExecutionRunActive, type ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { readExecutionRunAttentionRequestIds } from '@happier-dev/protocol/execution/runs/runPrimitives';
import { readExecutionRunAgentActivityStatus, resolveAgentActivityStatusPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { describeWorkerUpdateHeadline, resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { admittedInboxDiscussionOccurrences, inboxItemView, type InboxDiscussionSource, type InboxItemView, type InboxItemType } from './inboxItemProjection';
import type { InboxPluginSessionRow } from './inboxItemProjection';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionAttentionStanding } from '@happier-dev/protocol/sessions/organization/standings';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areSessionAppearanceColorsEqual, type SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { readStoredSessionTranscriptForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import type { StorageState } from '@/sync/store/types';
import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';
import type { SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';
import type { ManagedMachineSignInOccurrenceV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { selectSessionRelationRecords } from '@/components/sessions/work/reportSubtree';
import { readSessionPresentationRecord, readSessionPresentationInputDisplay, readSessionPresentationInputSource,
    type SessionPresentationRecord, type SessionRelationRecord,
    type SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
export { inboxItemView, type InboxDiscussionSource, type InboxItemView, type InboxItemType } from './inboxItemProjection';
export const INBOX_ITEM_VIEWS = ['needs_you', 'updates', 'mentions'] as const satisfies readonly InboxItemView[];
export function getInboxNeedsYouItemTypes() {
    return ['approval', 'decision', 'blocked'] as const;
}

/** How "Needs you" groups and names its rows, in reading order: what is asked of the person, then what is blocked. */
export const INBOX_NEEDS_YOU_GROUPS = ['approval', 'decision', 'blocked', 'alert'] as const;
export type InboxNeedsYouGroup = typeof INBOX_NEEDS_YOU_GROUPS[number];
/** Notices that hold no session or run of their own: a failing service's health alert, a Machine's removal reminder. */
const INBOX_ALERT_SOURCES: ReadonlySet<string> = new Set(['account_notice', 'managed_machine']);

/**
 * The one grouping of a "Needs you" row: its type, except that a blocking notice reads as an alert (R19-D3 B). It
 * blocks nothing of its own, so the page must not count it among blocked sessions.
 */
export function inboxNeedsYouGroupOf(item: Pick<InboxItem, 'type' | 'source'>): InboxNeedsYouGroup | null {
    if (item.type === 'approval' || item.type === 'decision') return item.type;
    if (item.type !== 'blocked') return null;
    return INBOX_ALERT_SOURCES.has(item.source.kind) ? 'alert' : 'blocked';
}

export type InboxMachineSignInTarget = Readonly<{
    kind: 'managed_machine_sign_in_approval';
    serverId: string;
    requesterAccountId: string;
    homeId: string;
    managedId: string;
    operationId: string;
    taskId: string;
}>;

// An explicit consumer opts in to this item. The generic Inbox row accepts only InboxItem.
export type InboxMachineSignInItem = Readonly<{
    key: string;
    type: 'confirm_machine_sign_in';
    view: Extract<InboxItemView, 'needs_you'>;
    machine: Readonly<{ homeId: string; id: string }>;
    openTarget: InboxMachineSignInTarget;
}>;

export function buildInboxMachineSignInItems(
    scope: ServerAccountScope,
    occurrences: readonly ManagedMachineSignInOccurrenceV1[],
    previous?: readonly InboxMachineSignInItem[],
): readonly InboxMachineSignInItem[] {
    const items: InboxMachineSignInItem[] = [];
    for (const occurrence of occurrences) {
        if (occurrence.state !== 'pending' || occurrence.requesterAccountId !== scope.accountId) continue;
        const { requesterAccountId, homeId, managedId, operationId, taskId } = occurrence;
        items.push({
            key: serverAccountScopedResourceKey(scope, 'managed-sign-in', homeId, managedId, operationId, taskId),
            type: 'confirm_machine_sign_in',
            view: 'needs_you',
            machine: { homeId, id: managedId },
            openTarget: { kind: 'managed_machine_sign_in_approval', serverId: scope.serverId,
                requesterAccountId, homeId, managedId, operationId, taskId },
        });
    }
    return retainKeyedRows(previous, items, item => item.key);
}

export type AccountNoticeInboxEntry = AccountNoticeArtifact;
export type InboxExecutionRunAddress = Readonly<{ serverId: string } & (
    { sessionId: string; machineId?: never } | { machineId: string; sessionId?: never }
)>;
export type InboxExecutionRun = Readonly<{ address: InboxExecutionRunAddress; run: ExecutionRunPublicState;
    unavailable?: 'target_unavailable'; persistent?: boolean; onceDeliveries?: readonly PersonalRunFollowOnceOccurrenceV1[] }>;
/** A fulfilled attention receipt is actionable only while its exact source request still exists. */
export function readInboxExecutionRunOnceDeliveries(entry: InboxExecutionRun): readonly PersonalRunFollowOnceOccurrenceV1[] {
    return (entry.onceDeliveries ?? []).filter(delivery => {
        const { original } = delivery;
        if (original.source.kind !== 'execution_run' || original.source.runId !== entry.run.runId) return false;
        if ('sessionId' in original.source ? original.source.sessionId !== entry.address.sessionId
            || entry.address.machineId !== undefined : original.source.machineId !== entry.address.machineId
                || entry.address.sessionId !== undefined) return false;
        if (delivery.event.kind !== 'needs_you') return true;
        if (!('permissionRequests' in original) || delivery.event.type === 'blocked') return false;
        const { attention } = entry.run;
        const requestIds = readExecutionRunAttentionRequestIds(attention, delivery.event.type);
        return original.permissionRequests.some(request => requestIds.includes(request.requestId)
            && (!attention?.requests || attention.requests.some(current => current.requestId === request.requestId
                && current.createdAt === request.createdAt)));
    });
}
export function classifyInboxExecutionRun(run: ExecutionRunPublicState): 'approval' | 'decision' | 'update' | null {
    if (run.status !== 'running') return null;
    if (run.attention?.kind === 'permission_required') return 'approval';
    if (run.attention?.kind === 'user_action_required') return 'decision';
    return isExecutionRunActive(run) ? 'update' : null;
}
export type InboxItem = Readonly<{
    /** Exact readable operation explaining this existing health condition. */
    expectedDuring?: AccountNoticeArtifact['expectedDuring'];
    appearanceColor?: SessionAppearanceColor | null;
    key: string;
    producer: 'live' | 'notice';
    type: InboxItemType;
    view: InboxItemView;
    title: string;
    context: string | null;
    /** Row-only presentation; source.displayName remains the source's identity. */
    sourceLabel?: string;
    createdAt: number;
    read: boolean;
    remindAt?: number;
    focus: InboxItemFocus;
    pageRoute: string;
    workStatus?: WorkStatusPresentation;
    phase?: 'attention' | 'live';
    /** The owning record, never a mirrored Inbox lifecycle. */
    source: Readonly<{ kind: string; id: string; serverId: string; displayName?: string | null; pluginId?: string; onceDelivery?: PersonalFollowOnceOccurrenceV1;
        onceDeliveries?: readonly PersonalRunFollowOnceOccurrenceV1[] }>;
    /** Account byline or producing Session name; never inferred from the source owner. */
    author?: Readonly<{ name: string; isSelf?: boolean; avatar?: ReturnType<typeof resolveAccountActorPresentation>['avatar'] }> | null;
    excerpt?: string | null;
    pluginSessionRows?: readonly InboxPluginSessionRow[];
    /** A pending machine sign-in's exact occurrence: the row answers this task, never a replacement. */
    machineSignIn?: InboxMachineSignInTarget;
    /** The immediate lead; an unavailable or unreadable lead has no display title. */
    reportsTo?: Readonly<{ address: SessionAddress; title: string | null }>;
    /** Latest matching WorkerUpdate already held in the lead's readable transcript. */
    workerUpdateHeadline?: string;
    question?: SessionQuestionContextV1 & Readonly<{
        requestId: string;
        currentHandler: Readonly<{ kind: 'person' }> | Readonly<{ kind: 'session'; address: SessionAddress }>;
    }>;
    discussion?: Readonly<{
        accountId: string;
        messageRef: DiscussionOpenedMessageV1['messageRef'];
        seq: number;
        anchor: DiscussionAnchorV1 | null;
        replyTarget?: DiscussionOpenedMessageV1['replyTarget'];
        proposalDisposition?: DiscussionOpenedMessageV1['docEditProposalDispositionV1'];
    }>;
}>;
export type InboxItemsInput = Readonly<{
    isRecordingVisible?: SessionRecordingVisibility;
    workGroups: readonly InboxWorkGroup[];
    sessionPresentation: InboxSessionPresentation;
    workflowServerId: string | null;
    accountServerId: string | null;
    notices: readonly AccountNoticeInboxEntry[];
    executionRuns?: readonly InboxExecutionRun[];
    machineDeletionEntries?: ReturnType<typeof useManagedMachineDeletionAttention>;
    /** Pending sign-ins with the managed Machine's name from its inventory (null until read). */
    machineSignIns?: readonly Readonly<{ item: InboxMachineSignInItem; name: string | null }>[];
    workflowRunOnceDeliveries?: ReadonlyMap<string, readonly PersonalRunFollowOnceOccurrenceV1[]>;
    automationPresentation?: ReadonlyMap<string, { title?: string; causeLabel?: string }>;
    /** Already resolved package names from the app's Account-scoped plugin projection. */
    pluginDisplayNames?: ReadonlyMap<string, string>;
    reviewRequesterNames?: ReadonlyMap<string, string> | null;
    viewerAccountId?: string | null;
    /** Loaded exact-Home requester names, keyed by their owning approval Artifact. */
    approvalSourceDisplayNames?: ReadonlyMap<string, string | null>;
    discussions?: InboxDiscussionSource | null;
    pluginSessionRows?: readonly InboxPluginSessionRow[];
    sessionsById?: Readonly<Record<string, Session>>;
    sessionListRowsByServerId?: StorageState['sessionListRowsByServerId'];
    /** Admitted transcript state only; projecting Inbox rows never hydrates message bodies. */
    sessionMessagesById?: StorageState['sessionMessages'];
    attentionStandings?: Readonly<Record<string, SessionAttentionStanding>>;
}>;


/** One transient row projection over live owners and private Account notice Artifacts. */
export function buildInboxItems(input: InboxItemsInput, previous: readonly InboxItem[] = []): readonly InboxItem[] {
    const rows: InboxItem[] = [];
    for (const entry of input.machineDeletionEntries ?? []) {
        const focus = { kind: 'managed_machine', serverId: entry.serverId, id: entry.managedId } as const;
        rows.push({ key: `managed-machine:${entry.key}`, producer: 'live', type: 'blocked', view: 'needs_you',
            title: entry.name,
            context: t('managedRetention.consequence.deleteAt', { time: formatAsOfTime(entry.reminder.notice.at) }),
            createdAt: entry.reminder.remindAt, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus),
            source: { kind: 'managed_machine', serverId: entry.serverId, id: entry.managedId } });
    }
    // A sign-in asks the person to approve: it reads with the approvals, and opens its Machine's page.
    for (const { item, name } of input.machineSignIns ?? []) {
        const { serverId, managedId } = item.openTarget;
        const focus = { kind: 'managed_machine', serverId, id: managedId } as const;
        rows.push({ key: item.key, producer: 'live', type: 'approval', view: 'needs_you',
            title: t('machineSignIn.inboxTitle'), context: null, sourceLabel: name ?? t('common.machine'),
            createdAt: 0, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus), machineSignIn: item.openTarget,
            source: { kind: 'managed_machine_sign_in', serverId, id: item.key } });
    }
    // Resolve each Home once within this projection through the existing relation reader.
    const relationRecordsByHome = new Map<string, Readonly<Record<string, SessionRelationRecord>>>();
    const readRelationRecord = (sessionId: string, serverId: string) => {
        let records = relationRecordsByHome.get(serverId);
        if (!records) {
            records = selectSessionRelationRecords(input.sessionsById ?? {}, serverId, input.sessionListRowsByServerId);
            relationRecordsByHome.set(serverId, records);
        }
        return records[sessionId];
    };
    const readSessionFacts = (session: SessionPresentationRecord, serverId: string,
        source?: SessionListPresentationSource): Pick<InboxItem, 'reportsTo' | 'workerUpdateHeadline'> => {
        if (isInboxSessionStatusOnly(session, serverId)
            || session.serverId && !areServerProfileIdentifiersEquivalent(session.serverId, serverId)) return {};
        const managerSessionId = readSessionManagerSessionIdV1(source?.relations ?? session);
        if (!managerSessionId) return {};
        const address = { serverId, sessionId: managerSessionId };
        const candidate = readRelationRecord(managerSessionId, serverId);
        const lead = candidate?.serverId && areServerProfileIdentifiersEquivalent(candidate.serverId, serverId)
            && !isInboxSessionStatusOnly(readSessionPresentationInputDisplay(candidate), serverId) ? candidate : null;
        const reportsTo = { address, title: lead ? readInboxSessionTitle(readSessionPresentationInputDisplay(lead), serverId) : null };
        if (!lead || !input.sessionMessagesById) return { reportsTo };
        const transcript = readStoredSessionTranscriptForAddress({
            sessions: input.sessionsById, sessionMessages: input.sessionMessagesById,
        }, address);
        const update = transcript?.latestWorkerUpdates?.session?.[session.id];
        const workerUpdateHeadline = update ? describeWorkerUpdateHeadline(update, { title: readInboxSessionTitle(session, serverId) }) : undefined;
        return { reportsTo, ...(workerUpdateHeadline ? { workerUpdateHeadline } : {}) };
    };
    for (const group of input.workGroups) for (const item of group.items) {
        if (item.kind === 'session') {
            const candidate = item.entry.candidate;
            const serverId = candidate.address?.serverId ?? candidate.serverId;
            if (!serverId) continue;
            const question = item.entry.pendingUserActions[0];
            const { type, onceDelivery } = classifyInboxSessionCandidate(candidate, question?.questionV1?.type);
            if (type === null) continue;
            const focus = { kind: 'session', id: candidate.sessionId, serverId,
                ...(onceDelivery?.transcriptSeq ? { jumpSeq: onceDelivery.transcriptSeq } : {}) } as const;
            rows.push({ key: item.key, producer: 'live', type, view: inboxItemView(type), title: candidate.title,
                appearanceColor: item.entry.appearanceColor ?? null,
                context: candidate.subtitle || null, createdAt: candidate.presentationSource?.lifecycle.updatedAt ?? candidate.session.updatedAt, read: false, focus,
                workStatus: candidate.workStatus,
                ...readSessionFacts(candidate.session, serverId, candidate.presentationSource),
                ...(question?.questionV1 ? { question: { ...question.questionV1, requestId: question.id,
                    currentHandler: question.currentHandler?.kind === 'session'
                        ? { kind: 'session' as const, address: { serverId, sessionId: question.currentHandler.sessionId } }
                        : { kind: 'person' as const } } } : {}),
                pageRoute: resolveInboxItemPageRoute(focus), source: { kind: 'session', id: candidate.sessionId, serverId, displayName: candidate.title,
                    ...(onceDelivery ? { onceDelivery } : {}) } });
        } else if (item.kind === 'workflow_run') {
            if (!input.workflowServerId) continue;
            const summary = item.row.summary;
            const held = summary?.heldStep;
            const focus = held?.kind === 'child_session_permission'
                ? { kind: 'session', id: held.sessionId, serverId: input.workflowServerId } as const
                : { kind: 'workflow_run', id: item.runId, serverId: input.workflowServerId } as const;
            const workStatus = summary ? resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(summary) }) : null;
            const type = workStatus?.attentionType ?? 'update';
            const view = inboxItemView(type);
            const onceDeliveries = input.workflowRunOnceDeliveries?.get(item.runId)?.filter(delivery =>
                delivery.event.kind !== 'needs_you' || type === delivery.event.type);
            const title = readInboxWorkflowRunTitle(item.row);
            rows.push({ key: item.key, producer: 'live', type, view,
                title, context: item.heldStepLabel,
                createdAt: item.row.updatedAt, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus),
                ...(workStatus ? { workStatus } : {}),
                source: { kind: 'workflow_run', id: item.runId, serverId: input.workflowServerId,
                    displayName: title,
                    ...(onceDeliveries?.length ? { onceDeliveries } : {}) } });
        } else if (item.kind === 'automation_run') {
            const run = item.row.automation;
            const serverId = group.root.kind === 'automation' ? group.root.serverId : null;
            if (!run || !serverId) continue;
            const focus = { kind: 'automation_run', id: run.id, automationId: run.automationId, serverId } as const;
            const presentation = input.automationPresentation?.get(item.key);
            const onceDeliveries = input.workflowRunOnceDeliveries?.get(run.id)?.filter(delivery => delivery.event.kind !== 'needs_you');
            rows.push({ key: item.key, producer: 'live', type: 'update', view: 'updates',
                title: presentation?.title ?? formatAutomationRunStateLabel(run),
                context: presentation?.causeLabel ?? null, createdAt: item.row.updatedAt, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus),
                source: { kind: 'automation_run', id: run.id, serverId, displayName: presentation?.title ?? null,
                    ...(onceDeliveries?.length ? { onceDeliveries } : {}) } });
        } else if (item.kind === 'approval') {
            const focus = { kind: 'approval', id: item.artifact.id,
                serverId: readInboxApprovalServerId(item.approval.source) || input.accountServerId || '' } as const;
            // One-shot decisions are the mounted row's (ApprovalInboxCard, with requester authority), never derived per build.
            rows.push({ key: item.key, producer: 'live', type: 'approval', view: 'needs_you', title: item.artifact.title ?? '',
                context: null, createdAt: item.artifact.createdAt, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus),
                source: { kind: 'approval', id: item.artifact.id, serverId: focus.serverId,
                    displayName: input.approvalSourceDisplayNames?.get(item.artifact.id) ?? null } });
        } else {
            const serverId = item.session.serverId;
            if (!serverId) continue;
            const title = readInboxSessionTitle(item.session, serverId);
            const focus = { kind: 'session', id: item.session.id, serverId } as const;
            rows.push({ key: item.key, producer: 'live', type: 'update', view: 'updates',
                title, context: null, createdAt: item.session.updatedAt,
                ...readSessionFacts(item.session, serverId),
                read: true, focus, pageRoute: resolveInboxItemPageRoute(focus),
                source: { kind: 'session', id: item.session.id, serverId, displayName: title } });
        }
    }
    const sessionItems = new Map(rows.flatMap((row, index) => row.focus.kind === 'session'
        ? [[sessionAddressKey({ serverId: row.focus.serverId, sessionId: row.focus.id }), index] as const] : []));
    for (const candidate of input.sessionPresentation.readySessions) {
        const serverId = candidate.address?.serverId ?? candidate.serverId;
        if (!serverId) continue;
        const address = sessionAddressKey({ serverId, sessionId: candidate.sessionId });
        if (sessionItems.has(address)) continue;
        sessionItems.set(address, rows.length);
        const { onceDelivery } = classifyInboxSessionCandidate(candidate);
        const focus = { kind: 'session', id: candidate.sessionId, serverId,
            ...(onceDelivery?.transcriptSeq ? { jumpSeq: onceDelivery.transcriptSeq } : {}) } as const;
        rows.push({ key: `session:${serverId}:${candidate.sessionId}`, producer: 'live', type: 'update', view: 'updates',
            appearanceColor: candidate.appearanceColor ?? null,
            title: candidate.title, context: candidate.subtitle || null, createdAt: candidate.lastTurnCompletedAt ?? candidate.presentationSource?.lifecycle.updatedAt ?? candidate.session.updatedAt,
            workStatus: candidate.workStatus,
            ...readSessionFacts(candidate.session, serverId, candidate.presentationSource),
            read: false, focus, pageRoute: resolveInboxItemPageRoute(focus), source: { kind: 'session', id: candidate.sessionId, serverId, displayName: candidate.title,
                ...(onceDelivery ? { onceDelivery } : {}) } });
    }
    for (const entry of input.executionRuns ?? []) {
        const { address, run } = entry;
        const onceDeliveries = readInboxExecutionRunOnceDeliveries(entry);
        const event = onceDeliveries.find(delivery => delivery.event.kind === 'needs_you')?.event;
        const type = (entry.persistent !== false ? classifyInboxExecutionRun(run) : null)
            ?? (event?.kind === 'needs_you' ? event.type : onceDeliveries.length ? 'update' : null);
        if (!type) continue;
        const focus = { kind: 'execution_run', id: run.runId, ...address } as const;
        const title = resolveExecutionRunTitle(run);
        const needsYou = type !== 'update';
        const activityStatus = needsYou ? 'waiting' : readExecutionRunAgentActivityStatus(run.status);
        rows.push({ key: `execution-run:${JSON.stringify([address.serverId, address.sessionId ?? null, address.machineId ?? null, run.runId])}`,
            producer: 'live', type, view: inboxItemView(type), title, context: null,
            createdAt: run.startedAtMs, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus),
            phase: needsYou ? 'attention' : 'live',
            workStatus: resolveAgentActivityStatusPresentation(activityStatus, isExecutionRunActive(run),
                entry.unavailable ? false : undefined).workStatus,
            source: { kind: 'execution_run', id: run.runId, serverId: address.serverId, displayName: title,
                ...(onceDeliveries.length ? { onceDeliveries } : {}) } });
    }
    if (input.accountServerId) {
        for (const entry of input.notices) {
            // An open usage notice (a connected service's usage, a Machine's resource alert) is drawn once, by its own
            // card from the same Artifact's usage projection; a generic row would repeat it with its raw payload.
            if (projectOpenUsageNoticeHeaderV1(entry.header)) continue;
            const focus = { kind: 'notice', id: entry.artifact.id, serverId: input.accountServerId } as const;
            const row = projectAccountNoticeInboxItemV1({ artifactId: entry.artifact.id, serverId: input.accountServerId,
                createdAt: entry.artifact.createdAt, header: entry.header,
                pageRoute: resolveInboxItemPageRoute(focus, { notice: entry.header }),
                pluginDisplayName: entry.header.source.kind === 'plugin' ? input.pluginDisplayNames?.get(entry.header.source.pluginId) : null });
            if (!row) continue;
            // An open health notice (failed deploy, failing service or backup) reads as failing; recovery stays quiet.
            const failing = entry.header.healthPhase === 'open' ? { workStatus: resolveWorkStatusTone({ kind: 'health_notice',
                facts: { word: t('inbox.work.healthNotice.failing') } }) } : {};
            const review = entry.header.reviewAttention;
            const reviewByline = review ? { sourceLabel: [
                t(review.requestedVerdict ? 'reviewWalkthrough.detail.requestedFromYou' : 'reviewWalkthrough.collection.needsYourDecision'),
                reviewSubjectLabel(review.subjectKind),
                formatReviewRequesterByline(reviewRequesterPrincipal(review.requestedBy, input.accountServerId),
                    input.reviewRequesterNames, input.viewerAccountId),
            ].join(' · ') } : {};
            rows.push({ ...row, ...failing, ...reviewByline, ...(entry.expectedDuring ? { expectedDuring: entry.expectedDuring } : {}) });
        }
    }
    if (input.discussions) {
        const { scope } = input.discussions;
        for (const { discussion, message, type } of admittedInboxDiscussionOccurrences(input.discussions)) {
            const title = (discussion.anchor?.kind === 'doc'
                ? input.discussions.docDisplayNames?.get(discussion.anchor.doc.ref.artifactId) : null) || discussion.title;
            const producerName = message.producerV1?.kind === 'agent'
                ? input.discussions.sessionDisplayNames?.get(message.producerV1.sessionId) : null;
            const focus = { kind: 'discussion', serverId: scope.serverId, id: discussion.id, messageId: message.id } as const;
            rows.push({ key: `discussion:${scope.serverId}:${discussion.id}:${message.id}`, producer: 'live',
                type, view: inboxItemView(type), title: title ?? discussion.id, context: null,
                createdAt: message.createdAt, read: discussion.lastReadSeq !== null && message.seq <= discussion.lastReadSeq,
                focus, pageRoute: resolveInboxItemPageRoute(focus, { discussionAnchor: discussion.anchor }),
                source: { kind: 'discussion', id: discussion.id, serverId: scope.serverId, displayName: title },
                author: message.producerV1 ? producerName ? { name: producerName } : null
                    : message.accountActor && message.accountActor.accountId === message.authorAccountId
                        ? resolveAccountActorPresentation({ ...message.accountActor, serverId: scope.serverId }, scope) : null,
                excerpt: readDiscussionMessagePreview(message.content, {
                    account: accountId => {
                        const actor = discussion.participantAccounts?.find(candidate => candidate.accountId === accountId)
                            ?? (message.accountActor?.accountId === accountId ? message.accountActor : null);
                        return actor ? resolveAccountActorPresentation({ ...actor, serverId: scope.serverId }, scope).name : null;
                    },
                    session: sessionId => input.discussions?.sessionDisplayNames?.get(sessionId) ?? null,
                }),
                discussion: { accountId: scope.accountId, messageRef: message.messageRef, seq: message.seq, anchor: discussion.anchor,
                    ...(message.replyTarget ? { replyTarget: message.replyTarget } : {}),
                    ...(message.docEditProposalDispositionV1 ? { proposalDisposition: message.docEditProposalDispositionV1 } : {}) } });
        }
    }
    const pluginRows = new Map<string, InboxPluginSessionRow[]>();
    for (const row of input.pluginSessionRows ?? []) {
        const key = sessionAddressKey(row.row.session);
        const grouped = pluginRows.get(key) ?? [];
        grouped.push(row); pluginRows.set(key, grouped);
    }
    for (const [address, grouped] of pluginRows) {
        const index = sessionItems.get(address);
        if (index !== undefined) rows[index] = { ...rows[index]!, pluginSessionRows: grouped };
        else {
            const row = grouped[0]!.row;
            const standing = input.attentionStandings?.[buildSessionOrganizationSessionKey(row.session.serverId, row.session.sessionId)];
            if (standing?.standing === false) continue;
            const candidate = readRelationRecord(row.session.sessionId, row.session.serverId);
            const source = candidate?.serverId && areServerProfileIdentifiersEquivalent(candidate.serverId, row.session.serverId)
                ? candidate : undefined;
            const session = source ? readSessionPresentationRecord(source) : undefined;
            const presentation = source ? readSessionPresentationInputSource(source) : undefined;
            const title = source ? readInboxSessionTitle(readSessionPresentationInputDisplay(source), row.session.serverId) : row.title;
            const focus = { kind: 'session' as const, serverId: row.session.serverId, id: row.session.sessionId };
            rows.push({ key: `session:${row.session.serverId}:${row.session.sessionId}`, producer: 'live', type: 'update',
                view: 'updates', title, context: session ? null : row.detail, createdAt: presentation?.lifecycle.updatedAt ?? session?.updatedAt ?? 0, read: true, focus,
                pageRoute: resolveInboxItemPageRoute(focus), pluginSessionRows: grouped,
                ...(session ? readSessionFacts(session, row.session.serverId, presentation) : {}),
                source: { kind: 'session', serverId: row.session.serverId, id: row.session.sessionId,
                    ...(session ? { displayName: title } : {}) } });
        }
    }
    const isRecordingVisible = input.isRecordingVisible ?? readSessionRecordingVisibility();
    const visibleRows = rows.filter(row => row.focus.kind === 'session'
        ? isRecordingVisible({ serverId: row.focus.serverId, sessionId: row.focus.id })
        : row.focus.kind === 'execution_run' && row.focus.sessionId
            ? isRecordingVisible({ serverId: row.focus.serverId, sessionId: row.focus.sessionId }) : true);
    const old = new Map(previous.map(row => [row.key, row]));
    const reconciled = visibleRows.map(row => {
        const before = old.get(row.key);
        return before && sameItem(before, row) ? before : row;
    });
    return previous.length === reconciled.length && reconciled.every((row, index) => row === previous[index]) ? previous : reconciled;
}

export function selectInboxItemsForView(items: readonly InboxItem[], view: InboxItemView): readonly InboxItem[] {
    const selected = items.filter(item => item.view === view);
    return view === 'needs_you'
        ? INBOX_NEEDS_YOU_GROUPS.flatMap(group => selected.filter(item => inboxNeedsYouGroupOf(item) === group))
        : selected.sort((left, right) => right.createdAt - left.createdAt);
}

function sameItem(left: InboxItem, right: InboxItem): boolean {
    return left.producer === right.producer && left.type === right.type && left.view === right.view && left.title === right.title
        && areSessionAppearanceColorsEqual(left.appearanceColor, right.appearanceColor)
        && left.context === right.context && left.createdAt === right.createdAt && left.read === right.read
        && left.remindAt === right.remindAt
        && left.expectedDuring?.kind === right.expectedDuring?.kind
        && shallow(left.expectedDuring?.operation, right.expectedDuring?.operation)
        && left.pageRoute === right.pageRoute && shallow(left.focus, right.focus)
        && left.source.kind === right.source.kind && left.source.id === right.source.id && left.source.serverId === right.source.serverId
        && left.source.displayName === right.source.displayName && left.sourceLabel === right.sourceLabel && left.excerpt === right.excerpt
        && left.reportsTo?.address.serverId === right.reportsTo?.address.serverId
        && left.reportsTo?.address.sessionId === right.reportsTo?.address.sessionId
        && left.reportsTo?.title === right.reportsTo?.title && left.workerUpdateHeadline === right.workerUpdateHeadline
        && left.phase === right.phase && JSON.stringify(left.workStatus) === JSON.stringify(right.workStatus)
        && JSON.stringify(left.source.onceDelivery) === JSON.stringify(right.source.onceDelivery)
        && JSON.stringify(left.source.onceDeliveries) === JSON.stringify(right.source.onceDeliveries)
        && JSON.stringify(left.author) === JSON.stringify(right.author)
        && JSON.stringify(left.question) === JSON.stringify(right.question)
        && JSON.stringify(left.discussion) === JSON.stringify(right.discussion)
        && left.machineSignIn === right.machineSignIn
        && (left.pluginSessionRows?.length ?? 0) === (right.pluginSessionRows?.length ?? 0)
        && (left.pluginSessionRows ?? []).every((row, index) => row === right.pluginSessionRows?.[index]);
}
