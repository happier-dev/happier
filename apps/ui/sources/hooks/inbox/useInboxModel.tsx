import { projectExpectedHealthNotice } from '@/sync/domains/artifacts/projectExpectedHealthNotice';
import * as React from 'react';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { useHydrateSession } from '@/hooks/session/useHydrateSessionForRoute';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';

import { useActivityOverview } from '@/activity/source/useActivityOverview';
import { readActivitySourceAttentionMessages } from '@/activity/source/buildActivityOverviewFromSource';
import {
    buildInboxSessionPresentation,
    type InboxSessionPresentation,
} from '@/activity/presentation/buildInboxSessionPresentation';
import { isOpenApprovalInboxArtifact } from '@/sync/domains/artifacts/approvalArtifacts';
import { readOpenUsageNoticeArtifactHeader, readAccountNoticeArtifactHeader, isOpenAccountNotice,
    type AccountNoticeArtifact, type OpenUsageNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { buildInboxItems, selectInboxItemsForView, type InboxItem, type InboxItemView } from '@/components/inbox/inboxItems';
import {
    type SessionBulkActionTarget,
} from '@/components/sessions/actions/sessionBulkActionTypes';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { USAGE_NOTICE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    useInboxActionOperations,
    useActiveActionOperations,
} from '@/sync/domains/actionOperations/useActionOperations';
import type { InboxActionOperationEntry } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationAddress } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { useArtifacts, useFriendsLoaded, useSessionDisplayNameProjections, useWorkflowRunRows } from '@/sync/domains/state/storage';

import {
    buildInboxWorkGroups,
    type InboxWorkGroup,
} from '@/activity/presentation/buildInboxWorkGroups';
import type { InboxSessionAttentionEntry } from '@/activity/presentation/buildInboxSessionPresentation';
import { readSessionWorkStalled } from '@/components/work/status/sessionWorkStatusFacts';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { SessionAttentionStanding } from '@happier-dev/protocol';
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { registerMountedInboxReadOwner } from '@/sync/ops/actions/mountedWorkReadAction';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveApprovalHomeServerId } from '@/components/approvals/approvalHomeServerId';
import { readableSessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';

import { useInboxFriendRequests } from './useInboxFriendRequests';
import { useInboxMachineReachability } from './useInboxMachineReachability';
import { useInboxPluginSessionRows } from './useInboxPluginSessionRows';
import type { InboxPluginSessionControlInvoker } from './useInboxPluginSessionControls';
import { useInboxDiscussionSource } from './useInboxDiscussionSource';
import { InboxExecutionRunSourceBoundary, useInboxExecutionRunSource } from './useInboxExecutionRunSource';
import { InboxArtifactSourceBoundary, useInboxArtifactSource, type InboxArtifactSource } from './useInboxArtifactSource';
import {
    useFullWorkflowAttentionSource,
    useAutomationAttentionSource,
    WorkflowAttentionSourceBoundary,
    type WorkflowAttentionSource,
} from './useWorkflowAttentionSource';

/** Public summary only. ORC renders the item and opens the exact existing Run route. */
export type AutomationInboxItem = Readonly<{
    key: string;
    /** The same Account-scoped definition name the Inbox row displays, when known. */
    title?: string;
    run: AutomationDefinitionRun;
    route: ReturnType<typeof createWorkflowRunRoute>;
}>;

export type InboxModel = Readonly<{
    artifactSource: InboxArtifactSource;
    invokePluginSessionControl: InboxPluginSessionControlInvoker;
    source: ReturnType<typeof useActivityOverview>['source'];
    openApprovals: ReturnType<typeof useArtifacts>;
    openUsageNotices: readonly OpenUsageNoticeArtifact[];
    dismissUsageNotice: (entry: OpenUsageNoticeArtifact) => Promise<void>;
    /** Includes resolved records so an already-open detail can report its owner's current state. */
    accountNotices: readonly AccountNoticeArtifact[];
    openAccountNotices: readonly AccountNoticeArtifact[];
    dismissAccountNotice: (entry: AccountNoticeArtifact) => Promise<void>;
    items: readonly InboxItem[];
    /** Current canonical Activity facts, including Sessions that no longer need an answer. */
    sessionCandidates: readonly SessionActivityAttention[];
    discussionAttention: ReturnType<typeof useInboxDiscussionSource>;
    executionRunAttention: Pick<ReturnType<typeof useInboxExecutionRunSource>, 'loading' | 'failed'>;
    markItemOpened: (item: InboxItem) => Promise<void>;
    friendRequests: ReturnType<typeof useInboxFriendRequests>['requests'];
    sessionPresentation: InboxSessionPresentation;
    targetBySessionAddress: ReadonlyMap<string, SessionBulkActionTarget>;
    actionOperationEntries: readonly InboxActionOperationEntry[];
    machineReachabilityEntries: ReturnType<typeof useInboxMachineReachability>;
    pendingReadKeys: ReadonlySet<string>;
    markAllPending: boolean;
    isLoading: boolean;
    hasPrimaryAttention: boolean;
    hasContent: boolean;
    showCaughtUp: boolean;
    markRead: (targets: readonly SessionBulkActionTarget[]) => Promise<void>;
    resolveActionOperation: (entry: InboxActionOperationEntry) => void;
    /** Everything that needs the person, grouped by the work it belongs to (ORC R-10). */
    workGroups: readonly InboxWorkGroup[];
    /** Rows come from more than one Home, so each row names its Home; with one Home none repeats it. */
    spansHomes: boolean;
    /** The workflow input's freshness, for the one "couldn't refresh" line. */
    workflowAttention: WorkflowAttentionSource;
    automationAttention: WorkflowAttentionSource;
    automationAttentionItems: readonly AutomationInboxItem[];
    /** Settle: `session.attention.set {standing:false}` + `session.read_state.set read`. */
    settle: (session: Pick<Session, 'id' | 'serverId'>) => Promise<void>;
    /** Snooze (`remindAt`) or clear it (`null`) through `session.attention.set`. */
    setReminder: (session: Session, remindAt: number | null) => Promise<void>;
}>;


/**
 * The server origin link of a step session (ORC §3.1: awareness `origin?: {kind, runId?}`). U4 has
 * not landed it on the awareness schema yet; until then this reads nothing and nothing folds.
 */
function readAwarenessOriginRunId(entry: InboxSessionAttentionEntry): string | null {
    const origin: unknown = (entry.candidate.awareness as Readonly<Record<string, unknown>>).origin;
    if (typeof origin !== 'object' || origin === null) return null;
    const runId: unknown = (origin as Readonly<Record<string, unknown>>).runId;
    return typeof runId === 'string' && runId.trim() ? runId.trim() : null;
}

/**
 * A worker whose machine went offline with its turn in flight (ORC O7). The Session facts owner's
 * stalled fact, which the Work tab counts too; outstanding reports never make a worker stalled.
 */
function isStalledWorker(session: Session, nowMs: number): boolean {
    if (!readSessionManagerSessionIdV1(session) || typeof session.archivedAt === 'number') return false;
    return readSessionWorkStalled(session, nowMs);
}

const EMPTY_SESSIONS: readonly Session[] = Object.freeze([]);
const EMPTY_STANDINGS: Readonly<Record<string, SessionAttentionStanding>> = Object.freeze({});
const executeInboxAction = createFrontDoorActionExecute();

async function runInboxAction(actionId: 'session.attention.set' | 'session.read_state.set', input: Readonly<Record<string, unknown>>, serverId: string | null): Promise<void> {
    const result = await executeInboxAction(actionId, input, {
        surface: 'ui',
        authority: 'present_user',
        ...(serverId ? { serverId } : {}),
    });
    if (!result.ok) throw new Error(result.errorCode ?? 'unavailable');
}

const InboxModelContext = React.createContext<InboxModel | null>(null);

/**
 * The mounted Inbox controller shared by every Inbox surface.
 *
 * It owns one Activity subscription/boundary clock, one presentation, and one
 * exact-address pending ledger. Surfaces only compose layout and navigation;
 * they cannot independently reinterpret attention or mark-read progress.
 */
function useCreateInboxModel(): InboxModel {
    const { source, overview } = useActivityOverview();
    const friends = useInboxFriendRequests();
    const artifacts = useArtifacts();
    const artifactSource = useInboxArtifactSource();
    const profileScope = storage((state) => state.profileScope);
    const machineReachabilityEntries = useInboxMachineReachability(captureActiveServerAccountScopeLifetime());
    const readableOperations = useActiveActionOperations();
    const appPlugins = useAppShellPluginUiProjection();
    const pluginPackages = appPlugins.accountLifetime?.isCurrent()
        && areServerAccountScopesEqual(appPlugins.accountLifetime.scope, profileScope)
        && (appPlugins.phase === 'current' || appPlugins.phase === 'retainedOffline')
        ? appPlugins.pluginUiProjection?.installedPackagesById : null;
    const pluginDisplayNames = React.useMemo(() => new Map(Object.values(pluginPackages ?? {})
        .map(plugin => [plugin.id, plugin.displayName] as const)), [pluginPackages]);
    const discussionAttention = useInboxDiscussionSource(profileScope?.serverId ?? null);
    const executionRuns = useInboxExecutionRunSource();
    const pluginSessionInbox = useInboxPluginSessionRows();
    const friendsLoaded = useFriendsLoaded();
    const actionOperationEntries = useInboxActionOperations();
    const [pendingReadKeys, setPendingReadKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const pendingReadKeysRef = React.useRef<ReadonlySet<string>>(pendingReadKeys);

    const openApprovals = React.useMemo(
        // A draft is not a request yet: the badge's count leaves it out, and so does the list.
        () => artifacts.filter(isOpenApprovalInboxArtifact),
        [artifacts],
    );
    const approvalSourceAddresses = React.useMemo(() => openApprovals.flatMap(artifact => {
        const serverId = resolveApprovalHomeServerId(artifact.header);
        const sessionId = typeof artifact.header?.sessionId === 'string' ? artifact.header.sessionId.trim() : '';
        return serverId && sessionId ? [{ serverId, sessionId, artifactId: artifact.id }] : [];
    }), [openApprovals]);
    // An approval names its source Session from encrypted content: the Inbox demands it like a visible list row.
    useSessionContentDemand(approvalSourceAddresses, { tag: 'inbox.hydrateApprovalSources', hydrate: 'unsettled' });
    const approvalSourceTitles = useSessionDisplayNameProjections(approvalSourceAddresses, readableSessionDisplayTitle);
    const approvalSourceDisplayNames = React.useMemo(() => new Map(approvalSourceAddresses.map((address, index) =>
        [address.artifactId, approvalSourceTitles[index] ?? null] as const)), [approvalSourceAddresses, approvalSourceTitles]);
    const openUsageNotices = React.useMemo(() => artifacts.flatMap((artifact): OpenUsageNoticeArtifact[] => {
        if (artifact.draft === true) return [];
        const header = readOpenUsageNoticeArtifactHeader(artifact, profileScope?.accountId);
        return header ? [{ artifact, header }] : [];
    }), [artifacts, profileScope?.accountId]);
    const accountNotices = React.useMemo(() => artifacts.flatMap((artifact): AccountNoticeArtifact[] => {
        const header = readAccountNoticeArtifactHeader(artifact, profileScope?.accountId);
        return header ? [projectExpectedHealthNotice({ artifact, header }, readableOperations, profileScope)] : [];
    }), [artifacts, readableOperations, profileScope]);
    const openAccountNotices = React.useMemo(() => accountNotices.filter(entry => isOpenAccountNotice(entry.header)), [accountNotices]);
    const workflowAttention = useFullWorkflowAttentionSource();
    const workflowRunOnceDeliveries = React.useMemo(() => new Map(executionRuns.workflowFollows.map(follow =>
        [follow.source.runId, follow.onceDeliveries ?? []] as const)), [executionRuns.workflowFollows]);
    const workflowRunIds = React.useMemo(() => [...new Set([...workflowAttention.runIds, ...workflowRunOnceDeliveries.keys()])],
        [workflowAttention.runIds, workflowRunOnceDeliveries]);
    const loadedWorkflowRuns = useWorkflowRunRows(workflowRunIds);
    const workflowRuns = React.useMemo(() => loadedWorkflowRuns.filter(row => workflowAttention.runIds.includes(row.id)
        || workflowRunOnceDeliveries.get(row.id)?.some(delivery => delivery.event.kind !== 'needs_you')
        || row.summary?.attentionRequired === true && workflowRunOnceDeliveries.has(row.id)),
    [loadedWorkflowRuns, workflowAttention.runIds, workflowRunOnceDeliveries]);
    const automationAttention = useAutomationAttentionSource();
    const automationRuns = useWorkflowRunRows(automationAttention.runIds);
    const automations = storage((state) => state.automations);
    const automationDefinitionsAreCurrent = selectActiveServerAccountScopeForServer(profileScope, automationAttention.serverId) !== null;
    const automationAttentionItems = React.useMemo(() => automationRuns.flatMap((row): AutomationInboxItem[] => row.automation ? [{
        key: `automation-run:${row.id}`, title: automationDefinitionsAreCurrent ? automations[row.automation.automationId]?.name : undefined, run: row.automation,
        route: createWorkflowRunRoute({ kind: 'occurrence', automationId: row.automation.automationId, runId: row.id }, automationAttention.serverId),
    }] : []), [automationRuns, automations, automationAttention.serverId, automationDefinitionsAreCurrent]);
    const attentionStandings = storage((state) => state.sessionOrganizationAttentionStandingsBySessionKey) ?? EMPTY_STANDINGS;
    const sessionPresentation = React.useMemo(
        () => buildInboxSessionPresentation({
            overview,
            resolveMessages: (candidate) => readActivitySourceAttentionMessages(source, candidate.address),
        }),
        [overview, source.sessionMessagesById, source.sessionsById],
    );

    const sessionsById = source.sessionsById;
    const resolveInboxSession = React.useCallback((sessionId: string) =>
        readSessionListRowForServerId(source.sessionListRowsByServerId, profileScope?.serverId, sessionId)
        ?? sessionsById[sessionId], [source.sessionListRowsByServerId, profileScope?.serverId, sessionsById]);
    const stalledSessions = React.useMemo(() => {
        const nowMs = Date.now();
        const stalled = Object.values(sessionsById).filter((session) => isStalledWorker(session, nowMs));
        return stalled.length === 0 ? EMPTY_SESSIONS : stalled;
    }, [sessionsById]);
    const snoozed = React.useMemo(() => {
        const nowMs = Date.now();
        return Object.values(sessionsById).flatMap((session) => {
            const standing = attentionStandings[buildSessionOrganizationSessionKey(session.serverId ?? '', session.id)];
            return typeof standing?.remindAt === 'number' && standing.remindAt > nowMs
                ? [{ session, remindAt: standing.remindAt }]
                : [];
        });
    }, [attentionStandings, sessionsById]);
    const previousWorkGroups = React.useRef<readonly InboxWorkGroup[]>([]);
    const workGroups = React.useMemo(() => {
        const next = buildInboxWorkGroups({
        sessionEntries: sessionPresentation.sessionsNeedingAttention,
        workflowRuns,
        automationRuns,
        automationServerId: automationAttention.serverId,
        openApprovals,
        stalledSessions,
        landings: [],
        snoozed,
        resolveSession: resolveInboxSession,
        resolveOriginRunId: readAwarenessOriginRunId,
        }, previousWorkGroups.current);
        previousWorkGroups.current = next;
        return next;
    }, [automationAttention.serverId, automationRuns, openApprovals, sessionPresentation.sessionsNeedingAttention, resolveInboxSession, snoozed, stalledSessions, workflowRuns]);
    const previousItems = React.useRef<readonly InboxItem[]>([]);
    const items = React.useMemo(() => {
        const next = buildInboxItems({ workGroups, sessionPresentation, workflowServerId: workflowAttention.serverId,
            workflowRunOnceDeliveries,
            accountServerId: profileScope?.serverId ?? null, notices: openAccountNotices,
            executionRuns: executionRuns.entries,
            pluginSessionRows: pluginSessionInbox.rows,
            sessionsById, sessionListRowsByServerId: source.sessionListRowsByServerId,
            sessionMessagesById: source.sessionMessagesById, attentionStandings,
            discussions: discussionAttention.source, pluginDisplayNames, approvalSourceDisplayNames }, previousItems.current);
        previousItems.current = next;
        return next;
    }, [workGroups, sessionPresentation, workflowAttention.serverId, workflowRunOnceDeliveries, profileScope?.serverId, openAccountNotices, executionRuns.entries, discussionAttention.source, pluginDisplayNames, approvalSourceDisplayNames, pluginSessionInbox.rows, sessionsById, source.sessionListRowsByServerId, source.sessionMessagesById, attentionStandings]);

    const spansHomes = React.useMemo(
        () => new Set(overview.candidates.map((candidate) => candidate.address?.serverId ?? candidate.serverId ?? '')).size > 1,
        [overview.candidates],
    );

    const markAllReadTargets = sessionPresentation.markAllReadTargets;
    const targetBySessionAddress = React.useMemo(
        () => new Map(markAllReadTargets.map((target) => [target.key, target] as const)),
        [markAllReadTargets],
    );
    const isLoading = (
        (friends.visible && !friendsLoaded)
        || artifactSource.phase === 'loading'
        || discussionAttention.loading
        || executionRuns.loading
        || (!source.isDataReady && overview.candidates.length === 0)
        || (workflowAttention.available && workflowAttention.phase === 'loading')
        || (automationAttention.available && automationAttention.phase === 'loading')
        || pluginSessionInbox.loading
    );
    const hasPrimaryAttention = openApprovals.length > 0
        || items.length > 0
        || openUsageNotices.length > 0
        || openAccountNotices.length > 0
        || automationAttentionItems.length > 0
        || workGroups.length > 0
        || sessionPresentation.sessionsNeedingAttention.length > 0
        || sessionPresentation.readySessions.length > 0
        || friends.requests.length > 0
        || actionOperationEntries.length > 0
        || machineReachabilityEntries.length > 0;
    const showCaughtUp = !isLoading && !hasPrimaryAttention
        && artifactSource.phase === 'current'
        && !executionRuns.failed
        && (!discussionAttention.available || discussionAttention.coverage === 'complete')
        && !pluginSessionInbox.failed
        && ![workflowAttention, automationAttention].some((attention) => attention.available
            && (attention.phase === 'failed' || attention.refreshFailed));
    const markAllPending = markAllReadTargets.length > 0
        && markAllReadTargets.every((target) => pendingReadKeys.has(target.key));

    const applyPendingReadKeys = React.useCallback((next: ReadonlySet<string>) => {
        pendingReadKeysRef.current = next;
        setPendingReadKeys(next);
    }, []);

    const markRead = React.useCallback(async (requested: readonly SessionBulkActionTarget[]) => {
        // A row acknowledgement may still be settling when mark-all is pressed.
        // Filter against the shared ledger so an exact Home address is submitted once.
        const targets = requested.filter((target) => !pendingReadKeysRef.current.has(target.key));
        if (targets.length === 0) return;
        const requestedKeys = new Set(targets.map((target) => target.key));
        applyPendingReadKeys(new Set([...pendingReadKeysRef.current, ...requestedKeys]));
        try {
            const outcome = await executeInboxAction('inbox.mark_all_read', {
                targets: targets.map(({ serverId, sessionId }) => ({ serverId, sessionId })),
            }, {
                surface: 'ui', authority: 'present_user',
            });
            if (!outcome.ok) throw new Error(outcome.errorCode ?? 'unavailable');
            const result = AppShellActionOutputSchemas['inbox.mark_all_read'].parse(outcome.result);
            if (result.results.some(({ status }) => status === 'failed')) {
                Modal.alert(t('common.error'), t('sessionInfo.failedToMarkSessionRead'));
            }
        } catch {
            Modal.alert(t('common.error'), t('sessionInfo.failedToMarkSessionRead'));
        } finally {
            const next = new Set(pendingReadKeysRef.current);
            for (const key of requestedKeys) next.delete(key);
            applyPendingReadKeys(next);
        }
    }, [applyPendingReadKeys]);
    const resolveActionOperation = React.useCallback((entry: InboxActionOperationEntry) => {
        const address = actionOperationAddress(
            entry.operation.serverId,
            entry.operation.snapshot.operationId,
        );
        if (entry.reason === 'status_unavailable') {
            actionOperationStore.dismissUnavailable(address);
            return;
        }
        actionOperationStore.markTerminalSeen(address);
    }, []);

    const noticeWrites = React.useRef(new Map<string, Promise<void>>());
    const updateNotice = React.useCallback((entry: OpenUsageNoticeArtifact | AccountNoticeArtifact, intent: 'read' | 'dismiss'): Promise<void> => {
        const key = JSON.stringify([profileScope?.serverId, profileScope?.accountId, entry.artifact.id,
            entry.artifact.headerVersion, entry.artifact.bodyVersion, intent]);
        const pending = noticeWrites.current.get(key);
        if (pending) return pending;
        const write = (async () => {
        if (!profileScope || !readAccountNoticeArtifactHeader(entry.artifact, profileScope.accountId)) {
            throw new Error('usage_notice_unavailable');
        }
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            serverId: profileScope.serverId, expectedAccountId: profileScope.accountId };
        const read = await executeInboxAction('artifact.get', { artifactId: entry.artifact.id }, context);
        if (!read.ok) throw new Error(read.errorCode ?? 'usage_notice_unavailable');
        const current = ArtifactActionOutputSchemasV1['artifact.get'].parse(read.result).artifact;
        const notice = current && readAccountNoticeArtifactHeader({ ...current, isDecrypted: true }, profileScope.accountId);
        if (!current || !notice || typeof current.body !== 'string'
            || current.artifactId !== entry.artifact.id
            || current.revision.headerVersion !== entry.artifact.headerVersion
            || current.revision.bodyVersion !== entry.artifact.bodyVersion) throw new Error('usage_notice_changed');
        // The retained usage schema has no read acknowledgement. Its stored-read
        // presentation adapter must never become a kind/content migration writer.
        if (intent === 'read' && (current.header.kind === USAGE_NOTICE_ARTIFACT_KIND_V1 || !isOpenAccountNotice(notice)
            || notice.readAt !== undefined || ['decision', 'approval', 'blocked'].includes(notice.type))) return;
        const result = await executeInboxAction('artifact.update', {
            artifactId: current.artifactId, expectedRevision: current.revision,
            header: intent === 'dismiss' ? { ...current.header, status: 'dismissed' } : { ...current.header, readAt: Date.now() },
            body: current.body,
        }, context);
        if (!result.ok) throw new Error(result.errorCode ?? 'usage_notice_unavailable');
        })();
        noticeWrites.current.set(key, write);
        const clear = () => { if (noticeWrites.current.get(key) === write) noticeWrites.current.delete(key); };
        void write.then(clear, clear);
        return write;
    }, [profileScope]);
    const dismissUsageNotice = React.useCallback((entry: OpenUsageNoticeArtifact) => updateNotice(entry, 'dismiss'), [updateNotice]);
    const dismissAccountNotice = React.useCallback((entry: AccountNoticeArtifact) => updateNotice(entry, 'dismiss'), [updateNotice]);
    const markItemOpened = React.useCallback(async (item: InboxItem) => {
        if (item.view === 'needs_you' || item.read) return;
        try {
            if (item.producer === 'notice') {
                const entry = accountNotices.find(entry => entry.artifact.id === item.source.id);
                if (entry) await updateNotice(entry, 'read');
            } else if (item.source.kind === 'discussion') {
                await discussionAttention.markOpened(item);
            } else if (item.source.onceDeliveries?.length && (item.focus.kind === 'execution_run' || item.focus.kind === 'workflow_run')) {
                const source = item.focus.kind === 'workflow_run' ? { kind: 'workflow_run' as const, runId: item.focus.id }
                    : item.focus.machineId !== undefined ? { kind: 'execution_run' as const, machineId: item.focus.machineId, runId: item.focus.id }
                        : { kind: 'execution_run' as const, sessionId: item.focus.sessionId, runId: item.focus.id };
                if (!profileScope || !areServerProfileIdentifiersEquivalent(item.focus.serverId, profileScope.serverId)) throw new Error('action_account_scope_changed');
                await executionRuns.markOpened(source);
            } else if (item.view === 'updates' && item.source.kind === 'session') {
                const target = targetBySessionAddress.get(buildSessionOrganizationSessionKey(item.source.serverId, item.source.id));
                if (target) await markRead([target]);
            }
        } catch { Modal.alert(t('common.error'), t('errors.unknownError')); }
    }, [accountNotices, markRead, targetBySessionAddress, updateNotice, discussionAttention.markOpened, executionRuns.markOpened, profileScope]);

    const settle = React.useCallback(async (session: Pick<Session, 'id' | 'serverId'>) => {
        const serverId = session.serverId ?? null;
        try {
            await runInboxAction('session.attention.set', { sessionId: session.id, standing: false }, serverId);
            await runInboxAction('session.read_state.set', { sessionId: session.id, state: 'read' }, serverId);
        } catch {
            Modal.alert(t('common.error'), t('inbox.work.settleFailed'));
        }
    }, []);
    const setReminder = React.useCallback(async (session: Session, remindAt: number | null) => {
        try {
            await runInboxAction('session.attention.set', { sessionId: session.id, remindAt }, session.serverId ?? null);
        } catch {
            Modal.alert(t('common.error'), t('errors.unknownError'));
        }
    }, []);

    const model = React.useMemo(() => ({
        artifactSource,
        invokePluginSessionControl: pluginSessionInbox.invokeControl,
        source,
        openApprovals,
        openUsageNotices,
        dismissUsageNotice,
        accountNotices,
        openAccountNotices,
        dismissAccountNotice,
        items,
        sessionCandidates: overview.candidates,
        discussionAttention,
        markItemOpened,
        friendRequests: friends.requests,
        sessionPresentation,
        targetBySessionAddress,
        actionOperationEntries,
        machineReachabilityEntries,
        pendingReadKeys,
        markAllPending,
        isLoading,
        hasPrimaryAttention,
        hasContent: hasPrimaryAttention,
        showCaughtUp,
        markRead,
        resolveActionOperation,
        workGroups,
        spansHomes,
        workflowAttention,
        executionRunAttention: executionRuns,
        automationAttention,
        automationAttentionItems,
        settle,
        setReminder,
    }), [
        artifactSource,
        pluginSessionInbox.invokeControl,
        spansHomes,
        actionOperationEntries,
        machineReachabilityEntries,
        friends.requests,
        hasPrimaryAttention,
        isLoading,
        markAllPending,
        markRead,
        resolveActionOperation,
        openApprovals,
        openUsageNotices,
        dismissUsageNotice,
        accountNotices,
        openAccountNotices,
        dismissAccountNotice,
        items,
        overview.candidates,
        discussionAttention,
        markItemOpened,
        pendingReadKeys,
        sessionPresentation,
        showCaughtUp,
        settle,
        setReminder,
        source,
        targetBySessionAddress,
        workGroups,
        workflowAttention,
        executionRuns,
        automationAttention,
        automationAttentionItems,
    ]);
    React.useLayoutEffect(() => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!profileScope || !lifetime || !areServerAccountScopesEqual(profileScope, lifetime.scope)) return;
        return registerMountedInboxReadOwner({ scope: profileScope, isCurrent: lifetime.isCurrent, read: () => model });
    }, [model, profileScope]);
    return model;
}

/** Mount at an open Inbox screen or popover boundary. */
export function InboxModelProvider(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <InboxArtifactSourceBoundary><WorkflowAttentionSourceBoundary>
            <InboxExecutionRunSourceBoundary><InboxModelContextProvider>{props.children}</InboxModelContextProvider></InboxExecutionRunSourceBoundary>
        </WorkflowAttentionSourceBoundary></InboxArtifactSourceBoundary>
    );
}

function InboxModelContextProvider(props: Readonly<{ children: React.ReactNode }>) {
    const model = useCreateInboxModel();
    return (
        <InboxModelContext.Provider value={model}>
            {model.sessionPresentation.pendingRequestHydrationTargets.map(address => (
                <InboxPendingRequestHydration key={sessionAddressKey(address)} address={address} />
            ))}
            {props.children}
        </InboxModelContext.Provider>
    );
}

/** Summary rows use the dock's existing exact-Home hydration and retry lifecycle. */
function InboxPendingRequestHydration({ address }: Readonly<{ address: SessionAddress }>): null {
    useHydrateSession(address.sessionId, 'inbox-pending-request', {
        serverId: address.serverId, forceRefresh: true, hydrateMessages: true,
    });
    return null;
}

/**
 * Test/isolated-screen fallback that becomes a no-op beneath an open-surface owner.
 * The creator hook only mounts in the provider branch, so consumers beneath an
 * existing owner never subscribe twice.
 */
export function InboxModelBoundary(props: Readonly<{ children: React.ReactNode; enabled?: boolean }>) {
    const existing = React.useContext(InboxModelContext);
    // Optional readers keep their descendants under one provider as demand changes. Only the
    // model producer mounts/unmounts; it shares the same attention/classification owners.
    if (props.enabled !== undefined) return <DemandedInboxModelBoundary enabled={props.enabled} existing={existing}>{props.children}</DemandedInboxModelBoundary>;
    if (existing) return <>{props.children}</>;
    return <InboxModelProvider>{props.children}</InboxModelProvider>;
}

function DemandedInboxModelBoundary(props: Readonly<{ children: React.ReactNode; enabled: boolean; existing: InboxModel | null }>) {
    const [model, setModel] = React.useState<InboxModel | null>(null);
    React.useLayoutEffect(() => { if (!props.enabled) setModel(null); }, [props.enabled]);
    return <InboxModelContext.Provider value={props.existing ?? (props.enabled ? model : null)}>
        {props.enabled && !props.existing ? <InboxModelProvider><InboxModelPublisher publish={setModel} /></InboxModelProvider> : null}
        {props.children}
    </InboxModelContext.Provider>;
}

function InboxModelPublisher(props: Readonly<{ publish: (model: InboxModel) => void }>) {
    const model = useInboxModel();
    React.useLayoutEffect(() => { props.publish(model); }, [model, props.publish]);
    return null;
}

export function useInboxModel(): InboxModel {
    const model = React.useContext(InboxModelContext);
    if (!model) {
        throw new Error('useInboxModel must be rendered under InboxModelProvider');
    }
    return model;
}

/** The list and mail-key navigation consume exactly the same canonical rows for all three views. */
export function useInboxItems(view: InboxItemView): readonly InboxItem[] {
    const model = useInboxModel();
    return React.useMemo(() => selectInboxItemsForView(model.items, view), [model.items, view]);
}

/**
 * The Inbox model for a reader that needs it only sometimes (a board whose sources include Needs you).
 * `React.use` reads the context conditionally, so while `enabled` is false the reader neither needs a
 * boundary above it nor re-renders when the Inbox changes.
 */
export function useInboxModelWhen(enabled: boolean): InboxModel | null {
    return enabled ? React.use(InboxModelContext) : null;
}

/** Narrow migration seam for badge hooks that can retain an isolated fallback. */
export function useOptionalInboxModel(): InboxModel | null {
    return React.useContext(InboxModelContext);
}
