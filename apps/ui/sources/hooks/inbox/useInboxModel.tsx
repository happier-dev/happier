import * as React from 'react';
import { createAccountNoticeInvestigation } from './accountNoticeInvestigation';
import { AccountNoticeInvestigationBoundary, useAccountNoticeInvestigation } from './AccountNoticeInvestigationProvider';
export { createAccountNoticeInvestigation } from './accountNoticeInvestigation';

import { useHydrateSession } from '@/hooks/session/useHydrateSessionForRoute';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';

import { useActivityOverview } from '@/activity/source/useActivityOverview';

import type { InboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { readAccountNoticeArtifactHeader, isOpenAccountNotice,
    type AccountNoticeArtifact, type OpenUsageNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { buildInboxItems, selectInboxItemsForView, type InboxItem, type InboxItemView } from '@/components/inbox/inboxItems';
import {
    type SessionBulkActionTarget,
} from '@/components/sessions/actions/sessionBulkActionTypes';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { USAGE_NOTICE_ARTIFACT_KIND_V1, AccountNoticeArtifactBodyV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    useInboxActionOperations,
    useActiveActionOperations,
} from '@/sync/domains/actionOperations/useActionOperations';
import type { InboxActionOperationEntry } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationAddress } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { useFriendsLoaded, useSessionDisplayNameProjections } from '@/sync/domains/state/storage';

import type { InboxWorkGroup } from '@/activity/presentation/buildInboxWorkGroups';

import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { registerMountedInboxReadOwner } from '@/sync/ops/actions/mountedWorkReadAction';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveApprovalHomeServerId } from '@/components/approvals/approvalHomeServerId';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { readableSessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';





import { useInboxFriendRequests } from './useInboxFriendRequests';
import { InboxWorkProjectionBoundary, useInboxWorkProjection } from './useInboxWorkProjection';
import { useInboxSessionReadMarking } from './useInboxSessionReadMarking';
import { useInboxMachineReachability, type InboxMachineReachabilityEntry } from './useInboxMachineReachability';
import { useManagedMachineDeletionAttention } from '@/activity/source/useManagedMachineDeletionSource';
import { projectExpectedHealthNotice } from '@/sync/domains/artifacts/projectExpectedHealthNotice';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';

import type { InboxPluginSessionControlInvoker } from './useInboxPluginSessionControls';
import { useInboxDiscussionSource } from './useInboxDiscussionSource';
import { InboxExecutionRunSourceBoundary, useInboxExecutionRunSource } from './useInboxExecutionRunSource';
import { InboxArtifactSourceBoundary, useInboxArtifactItems, type InboxArtifactSource } from './useInboxArtifactSource';
import { WorkflowAttentionSourceBoundary, type WorkflowAttentionSource } from './useWorkflowAttentionSource';

/** Public summary only. ORC renders the item and opens the exact existing Run route. */
export type AutomationInboxItem = Readonly<{
    key: string;
    /** The same Account-scoped definition name the Inbox row displays, when known. */
    title?: string;
    run: AutomationDefinitionRun;
    route: ReturnType<typeof createWorkflowRunRoute>;
}>;

export type InboxModel = Readonly<{
    noticeInvestigation: ReturnType<typeof createAccountNoticeInvestigation>;
    artifactSource: InboxArtifactSource;
    invokePluginSessionControl: InboxPluginSessionControlInvoker;
    source: ReturnType<typeof useActivityOverview>['source'];
    openApprovals: readonly DecryptedArtifact[];
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
    /** Updates data; operation custody and actual reachability are independent facts. */
    machineReachabilityEntries: readonly InboxMachineReachabilityEntry[];
    machineDeletionEntries: ReturnType<typeof useManagedMachineDeletionAttention>;
    pendingReadKeys: ReadonlySet<string>;
    /** Known unavailable Homes retain rows, but cannot accept a read acknowledgement. */
    readUnavailableReasonBySessionAddress: ReadonlyMap<string, string>;
    markAllReadUnavailableReason: string | null;
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
function useCreateInboxModel(projection: NonNullable<ReturnType<typeof useInboxWorkProjection>>): InboxModel {
    const isRecordingVisible = useSessionRecordingVisibility();
    const { source, overview, openApprovalEntries, artifactSource, profileScope, pluginSessionInbox,
        executionRuns, workflowAttention, workflowRunOnceDeliveries, automationAttention, automationRuns,
        attentionStandings, sessionsById, sessionPresentation, workGroups } = projection;
    const friends = useInboxFriendRequests();
    const { openApprovals, openUsageNotices, accountNotices: storedAccountNotices } = useInboxArtifactItems();
    const readableOperations = useActiveActionOperations();
    const previousNotices = React.useRef<readonly AccountNoticeArtifact[]>([]);
    const accountNotices = React.useMemo(() => {
        const next = storedAccountNotices.map(entry => projectExpectedHealthNotice(entry, readableOperations, profileScope));
        previousNotices.current = retainKeyedRows(previousNotices.current, next, entry => entry.artifact.id);
        return previousNotices.current;
    }, [storedAccountNotices, readableOperations, profileScope]);
    const openAccountNotices = React.useMemo(() => accountNotices.filter(entry => isOpenAccountNotice(entry.header)), [accountNotices]);
    const profilesGeneration = useServerProfilesGeneration();
    const appPlugins = useAppShellPluginUiProjection();
    const pluginPackages = appPlugins.accountLifetime?.isCurrent()
        && areServerAccountScopesEqual(appPlugins.accountLifetime.scope, profileScope)
        && (appPlugins.phase === 'current' || appPlugins.phase === 'retainedOffline')
        ? appPlugins.pluginUiProjection?.installedPackagesById : null;
    const pluginDisplayNames = React.useMemo(() => new Map(Object.values(pluginPackages ?? {})
        .map(plugin => [plugin.id, plugin.displayName] as const)), [pluginPackages]);
    const discussionAttention = useInboxDiscussionSource(profileScope?.serverId ?? null);
    const friendsLoaded = useFriendsLoaded();
    const actionOperationEntries = useInboxActionOperations();
    const machineReachabilityEntries = useInboxMachineReachability(captureActiveServerAccountScopeLifetime());
    const machineDeletionEntries = useManagedMachineDeletionAttention(profileScope?.serverId ?? null);

    const approvalSourceAddresses = React.useMemo(() => Object.values(openApprovalEntries).flatMap(entry => {
        const serverId = resolveApprovalHomeServerId(entry.source);
        const sessionId = entry.source.sessionId;
        return serverId && sessionId ? [{ serverId, sessionId, artifactId: entry.artifact.id }] : [];
    }), [openApprovalEntries, profilesGeneration]);
    // An approval names its source Session from encrypted content: the Inbox demands it like a visible list row.
    useSessionContentDemand(approvalSourceAddresses, { tag: 'inbox.hydrateApprovalSources', hydrate: 'unsettled' });
    const approvalSourceTitles = useSessionDisplayNameProjections(approvalSourceAddresses, readableSessionDisplayTitle);
    const approvalSourceDisplayNames = React.useMemo(() => new Map(approvalSourceAddresses.map((address, index) =>
        [address.artifactId, isRecordingVisible(address) ? approvalSourceTitles[index] ?? null : null] as const)),
        [approvalSourceAddresses, approvalSourceTitles, isRecordingVisible]);
    const automations = storage((state) => state.automations);
    const automationDefinitionsAreCurrent = selectActiveServerAccountScopeForServer(profileScope, automationAttention.serverId) !== null;
    const automationAttentionItems = React.useMemo(() => automationRuns.flatMap((row): AutomationInboxItem[] => row.automation ? [{
        key: `automation-run:${row.id}`, title: automationDefinitionsAreCurrent ? automations[row.automation.automationId]?.name : undefined, run: row.automation,
        route: createWorkflowRunRoute({ kind: 'occurrence', automationId: row.automation.automationId, runId: row.id }, automationAttention.serverId),
    }] : []), [automationRuns, automations, automationAttention.serverId, automationDefinitionsAreCurrent]);
    const previousItems = React.useRef<readonly InboxItem[]>([]);
    const items = React.useMemo(() => {
        const next = buildInboxItems({ workGroups, sessionPresentation, isRecordingVisible, workflowServerId: workflowAttention.serverId,
            workflowRunOnceDeliveries,
            accountServerId: profileScope?.serverId ?? null, notices: openAccountNotices,
            executionRuns: executionRuns.entries,
            machineDeletionEntries,
            pluginSessionRows: pluginSessionInbox.rows,
            sessionsById, sessionListRowsByServerId: source.sessionListRowsByServerId,
            sessionMessagesById: source.sessionMessagesById, attentionStandings,
            discussions: discussionAttention.source, pluginDisplayNames, approvalSourceDisplayNames }, previousItems.current);
        previousItems.current = next;
        return next;
    }, [workGroups, sessionPresentation, isRecordingVisible, workflowAttention.serverId, workflowRunOnceDeliveries, profileScope?.serverId, openAccountNotices, executionRuns.entries, machineDeletionEntries, discussionAttention.source, pluginDisplayNames, approvalSourceDisplayNames, pluginSessionInbox.rows, sessionsById, source.sessionListRowsByServerId, source.sessionMessagesById, attentionStandings]);

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
        || machineReachabilityEntries.length > 0
        || machineDeletionEntries.length > 0;
    const showCaughtUp = !isLoading && !hasPrimaryAttention
        && artifactSource.phase === 'current'
        && !executionRuns.failed
        && (!discussionAttention.available || discussionAttention.coverage === 'complete')
        && !pluginSessionInbox.failed
        && ![workflowAttention, automationAttention].some((attention) => attention.available
            && (attention.phase === 'failed' || attention.refreshFailed));
    const { pendingReadKeys, readUnavailableReasonBySessionAddress, markAllReadUnavailableReason, markAllPending, markRead } =
        useInboxSessionReadMarking(markAllReadTargets, source);
    const resolveActionOperation = React.useCallback((entry: InboxActionOperationEntry) => {
        const address = actionOperationAddress(
            entry.operation.serverId,
            entry.operation.snapshot.operationId,
        );
        actionOperationStore.dismissOperation(address);
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
        if (intent === 'dismiss') {
            const result = await executeInboxAction('inbox.notice.dismiss', {
                artifactId: entry.artifact.id,
                expectedRevision: { headerVersion: entry.artifact.headerVersion, bodyVersion: entry.artifact.bodyVersion },
            }, context);
            if (!result.ok) throw new Error(result.errorCode ?? 'usage_notice_unavailable');
            return;
        }
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
        if (current.header.kind === USAGE_NOTICE_ARTIFACT_KIND_V1 || !isOpenAccountNotice(notice)
            || notice.readAt !== undefined || ['decision', 'approval', 'blocked'].includes(notice.type)) return;
        const settleRecovery = notice.healthPhase === 'recovered';
        const result = await executeInboxAction('artifact.update', {
            artifactId: current.artifactId, expectedRevision: current.revision,
            header: { ...current.header, readAt: Date.now(),
                ...(settleRecovery ? { resolved: true } : {}) },
            body: settleRecovery ? JSON.stringify({ ...AccountNoticeArtifactBodyV1Schema.parse(JSON.parse(current.body)), resolved: true }) : current.body,
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
    const noticeInvestigation = useAccountNoticeInvestigation();
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
        noticeInvestigation,
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
        machineDeletionEntries,
        pendingReadKeys,
        readUnavailableReasonBySessionAddress,
        markAllReadUnavailableReason,
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
        noticeInvestigation,
        artifactSource,
        pluginSessionInbox.invokeControl,
        spansHomes,
        actionOperationEntries,
        machineReachabilityEntries,
        machineDeletionEntries,
        friends.requests,
        hasPrimaryAttention,
        isLoading,
        markAllPending,
        markRead,
        readUnavailableReasonBySessionAddress,
        markAllReadUnavailableReason,
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
        <AccountNoticeInvestigationBoundary>
        <InboxArtifactSourceBoundary><WorkflowAttentionSourceBoundary>
            <InboxExecutionRunSourceBoundary><InboxWorkProjectionBoundary><InboxModelReady>{props.children}</InboxModelReady></InboxWorkProjectionBoundary></InboxExecutionRunSourceBoundary>
        </WorkflowAttentionSourceBoundary></InboxArtifactSourceBoundary>
        </AccountNoticeInvestigationBoundary>
    );
}

function InboxModelReady(props: Readonly<{ children: React.ReactNode }>) {
    const projection = useInboxWorkProjection();
    return projection ? <InboxModelContextProvider projection={projection}>{props.children}</InboxModelContextProvider> : null;
}

function InboxModelContextProvider(props: Readonly<{ children: React.ReactNode; projection: NonNullable<ReturnType<typeof useInboxWorkProjection>> }>) {
    const model = useCreateInboxModel(props.projection);
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
export function InboxModelBoundary(props: Readonly<{ children: React.ReactNode }>) {
    const existing = React.useContext(InboxModelContext);
    if (existing) return <>{props.children}</>;
    return <InboxModelProvider>{props.children}</InboxModelProvider>;
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

/** Narrow migration seam for badge hooks that can retain an isolated fallback. */
export function useOptionalInboxModel(): InboxModel | null {
    return React.useContext(InboxModelContext);
}
