import type { InboxWorkGroup } from '@/activity/presentation/buildInboxWorkGroups';
import type { useManagedMachineDeletionAttention } from '@/activity/source/useManagedMachineDeletionSource';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { classifyInboxSessionCandidate, type InboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { type AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { projectAccountNoticeInboxItemV1, projectOpenUsageNoticeHeaderV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { shallow } from 'zustand/shallow';
import { readInboxApprovalServerId, resolveInboxItemPageRoute, type InboxItemFocus } from './inboxItemFocus';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
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
import { selectSessionRelationRecords } from '@/components/sessions/work/reportSubtree';
import { readSessionPresentationRecord, readSessionPresentationInputDisplay, readSessionPresentationInputSource,
    type SessionPresentationRecord, type SessionRelationRecord,
    type SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
export { inboxItemView, type InboxDiscussionSource, type InboxItemView, type InboxItemType } from './inboxItemProjection';
export const INBOX_ITEM_VIEWS = ['needs_you', 'updates', 'mentions'] as const satisfies readonly InboxItemView[];
export function getInboxNeedsYouItemTypes() {
    return ['approval', 'decision', 'blocked'] as const;
}
export type AccountNoticeInboxEntry = AccountNoticeArtifact;
export type InboxExecutionRunAddress = Readonly<{ serverId: string } & (
    { sessionId: string; machineId?: never } | { machineId: string; sessionId?: never }
)>;
export type InboxExecutionRun = Readonly<{ address: InboxExecutionRunAddress; run: ExecutionRunPublicState;
    persistent?: boolean; onceDeliveries?: readonly PersonalRunFollowOnceOccurrenceV1[] }>;
/** A fulfilled permission is actionable only while its exact source request still exists. */
export function readInboxExecutionRunOnceDeliveries(entry: InboxExecutionRun): readonly PersonalRunFollowOnceOccurrenceV1[] {
    return (entry.onceDeliveries ?? []).filter(delivery => {
        const { original } = delivery;
        if (original.source.kind !== 'execution_run' || original.source.runId !== entry.run.runId) return false;
        if ('sessionId' in original.source ? original.source.sessionId !== entry.address.sessionId
            || entry.address.machineId !== undefined : original.source.machineId !== entry.address.machineId
                || entry.address.sessionId !== undefined) return false;
        if (delivery.event.kind !== 'needs_you') return true;
        const requestIds = entry.run.attention?.kind === 'permission_required' ? entry.run.attention.requestIds : [];
        return 'permissionRequests' in original && original.permissionRequests.some(request => requestIds.includes(request.requestId));
    });
}
export function classifyInboxExecutionRun(run: ExecutionRunPublicState): 'approval' | 'update' | null {
    if (run.status !== 'running') return null;
    return run.attention?.kind === 'permission_required' ? 'approval' : isExecutionRunActive(run) ? 'update' : null;
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
    createdAt: number;
    read: boolean;
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
    workflowRunOnceDeliveries?: ReadonlyMap<string, readonly PersonalRunFollowOnceOccurrenceV1[]>;
    /** Already resolved package names from the app's Account-scoped plugin projection. */
    pluginDisplayNames?: ReadonlyMap<string, string>;
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
            const focus = { kind: 'workflow_run', id: item.runId, serverId: input.workflowServerId } as const;
            const summary = item.row.summary;
            const workStatus = summary ? resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(summary) }) : null;
            const type = workStatus?.attentionType ?? 'update';
            const view = inboxItemView(type);
            const onceDeliveries = input.workflowRunOnceDeliveries?.get(item.runId)?.filter(delivery =>
                delivery.event.kind !== 'needs_you' || type === delivery.event.type);
            rows.push({ key: item.key, producer: 'live', type, view,
                title: formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(item.row.metadata)), context: item.heldStepLabel,
                createdAt: item.row.updatedAt, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus),
                ...(workStatus ? { workStatus } : {}),
                source: { kind: 'workflow_run', id: item.runId, serverId: input.workflowServerId,
                    displayName: formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(item.row.metadata)),
                    ...(onceDeliveries?.length ? { onceDeliveries } : {}) } });
        } else if (item.kind === 'automation_run') {
            const run = item.row.automation;
            const serverId = group.root.kind === 'automation' ? group.root.serverId : null;
            if (!run || !serverId) continue;
            const focus = { kind: 'automation_run', id: run.id, automationId: run.automationId, serverId } as const;
            rows.push({ key: item.key, producer: 'live', type: 'update', view: 'updates', title: run.automationId,
                context: null, createdAt: item.row.updatedAt, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus),
                source: { kind: 'automation_run', id: run.id, serverId, displayName: null } });
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
        const type = (entry.persistent !== false ? classifyInboxExecutionRun(run) : null)
            ?? (onceDeliveries.some(delivery => delivery.event.kind === 'needs_you') ? 'approval' : onceDeliveries.length ? 'update' : null);
        if (!type) continue;
        const focus = { kind: 'execution_run', id: run.runId, ...address } as const;
        const title = resolveExecutionRunTitle(run);
        const activityStatus = type === 'approval' ? 'waiting' : readExecutionRunAgentActivityStatus(run.status);
        rows.push({ key: `execution-run:${JSON.stringify([address.serverId, address.sessionId ?? null, address.machineId ?? null, run.runId])}`,
            producer: 'live', type, view: inboxItemView(type), title, context: null,
            createdAt: run.startedAtMs, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus),
            phase: type === 'approval' ? 'attention' : 'live',
            workStatus: resolveWorkStatusTone({ kind: 'agent_activity', facts: { status: activityStatus,
                word: resolveAgentActivityStatusPresentation(activityStatus, isExecutionRunActive(run)).label } }),
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
            if (row) rows.push(entry.expectedDuring ? { ...row, expectedDuring: entry.expectedDuring } : row);
        }
    }
    if (input.discussions) {
        const { scope } = input.discussions;
        for (const { discussion, message, type } of admittedInboxDiscussionOccurrences(input.discussions)) {
            const producerName = message.producerV1?.kind === 'agent'
                ? input.discussions.sessionDisplayNames?.get(message.producerV1.sessionId) : null;
            const focus = { kind: 'discussion', serverId: scope.serverId, id: discussion.id, messageId: message.id } as const;
            rows.push({ key: `discussion:${scope.serverId}:${discussion.id}:${message.id}`, producer: 'live',
                type, view: inboxItemView(type), title: discussion.title ?? discussion.id, context: null,
                createdAt: message.createdAt, read: discussion.lastReadSeq !== null && message.seq <= discussion.lastReadSeq,
                focus, pageRoute: resolveInboxItemPageRoute(focus),
                source: { kind: 'discussion', id: discussion.id, serverId: scope.serverId, displayName: discussion.title },
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
        ? getInboxNeedsYouItemTypes().flatMap(type => selected.filter(item => item.type === type))
        : selected.sort((left, right) => right.createdAt - left.createdAt);
}

function sameItem(left: InboxItem, right: InboxItem): boolean {
    return left.producer === right.producer && left.type === right.type && left.view === right.view && left.title === right.title
        && areSessionAppearanceColorsEqual(left.appearanceColor, right.appearanceColor)
        && left.context === right.context && left.createdAt === right.createdAt && left.read === right.read
        && left.pageRoute === right.pageRoute && shallow(left.focus, right.focus)
        && left.source.kind === right.source.kind && left.source.id === right.source.id && left.source.serverId === right.source.serverId
        && left.source.displayName === right.source.displayName && left.excerpt === right.excerpt
        && left.reportsTo?.address.serverId === right.reportsTo?.address.serverId
        && left.reportsTo?.address.sessionId === right.reportsTo?.address.sessionId
        && left.reportsTo?.title === right.reportsTo?.title && left.workerUpdateHeadline === right.workerUpdateHeadline
        && left.phase === right.phase && JSON.stringify(left.workStatus) === JSON.stringify(right.workStatus)
        && JSON.stringify(left.source.onceDelivery) === JSON.stringify(right.source.onceDelivery)
        && JSON.stringify(left.source.onceDeliveries) === JSON.stringify(right.source.onceDeliveries)
        && JSON.stringify(left.author) === JSON.stringify(right.author)
        && JSON.stringify(left.question) === JSON.stringify(right.question)
        && JSON.stringify(left.discussion) === JSON.stringify(right.discussion)
        && (left.pluginSessionRows?.length ?? 0) === (right.pluginSessionRows?.length ?? 0)
        && (left.pluginSessionRows ?? []).every((row, index) => row === right.pluginSessionRows?.[index]);
}
