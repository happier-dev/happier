import * as React from 'react';

import { useActivityOverview } from '@/activity/source/useActivityOverview';
import {
    buildInboxSessionPresentation,
    type InboxSessionPresentation,
} from '@/activity/presentation/buildInboxSessionPresentation';
import { isOpenApprovalInboxArtifact } from '@/sync/domains/artifacts/approvalArtifacts';
import {
    type SessionBulkActionTarget,
} from '@/components/sessions/actions/sessionBulkActionTypes';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    useInboxActionOperations,
} from '@/sync/domains/actionOperations/useActionOperations';
import type { InboxActionOperationEntry } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationAddress } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import {
    areSessionAddressesEqual,
    normalizeSessionAddress,
} from '@/sync/domains/session/sessionAddress';
import { readStoredSessionMessagesFromStateLike } from "@happier-dev/session-core/messages";
import { useArtifacts, useFriendsLoaded, useWorkflowRunRows } from '@/sync/domains/state/storage';

import {
    buildInboxWorkGroups,
    type InboxPullRequestLink,
    type InboxWorkGroup,
} from '@/activity/presentation/buildInboxWorkGroups';
import type { InboxSessionAttentionEntry } from '@/activity/presentation/buildInboxSessionPresentation';
import { readSessionWorkStalled } from '@/components/work/status/sessionWorkStatusFacts';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionAttentionStanding } from '@happier-dev/protocol';
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { useInboxFriendRequests } from './useInboxFriendRequests';
import {
    useWorkflowAttentionSource,
    useAutomationAttentionSource,
    WorkflowAttentionSourceBoundary,
    type WorkflowAttentionSource,
} from './useWorkflowAttentionSource';

/** Public summary only. ORC renders the item and opens the exact existing Run route. */
export type AutomationInboxItem = Readonly<{
    key: string;
    run: AutomationDefinitionRun;
    route: Readonly<{ pathname: '/automations/[id]/runs/[runId]'; params: Readonly<{ id: string; runId: string }> }>;
}>;

export type InboxModel = Readonly<{
    source: ReturnType<typeof useActivityOverview>['source'];
    openApprovals: ReturnType<typeof useArtifacts>;
    friendRequests: ReturnType<typeof useInboxFriendRequests>['requests'];
    sessionPresentation: InboxSessionPresentation;
    targetBySessionAddress: ReadonlyMap<string, SessionBulkActionTarget>;
    actionOperationEntries: readonly InboxActionOperationEntry[];
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
    /** The workflow input's freshness, for the one "couldn't refresh" line. */
    workflowAttention: WorkflowAttentionSource;
    automationAttention: WorkflowAttentionSource;
    automationAttentionItems: readonly AutomationInboxItem[];
    /** Settle: `session.attention.set {standing:false}` + `session.read_state.set read`. */
    settle: (session: Session) => Promise<void>;
    /** Snooze (`remindAt`) or clear it (`null`) through `session.attention.set`. */
    setReminder: (session: Session, remindAt: number | null) => Promise<void>;
}>;

/**
 * FIN's `sessionPullRequestLink` read projection is the one source of Landing (FIN PLAN U10, 08
 * §5A). It has not landed, so no session is Landing yet; the rows are built against its shape.
 */
const NO_PULL_REQUEST_LINKS: readonly InboxPullRequestLink[] = Object.freeze([]);

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
    if (!session.reportsTo?.sessionId || typeof session.archivedAt === 'number') return false;
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
    const friendsLoaded = useFriendsLoaded();
    const actionOperationEntries = useInboxActionOperations();
    const [pendingReadKeys, setPendingReadKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const pendingReadKeysRef = React.useRef<ReadonlySet<string>>(pendingReadKeys);

    const openApprovals = React.useMemo(
        () => artifacts.filter(isOpenApprovalInboxArtifact),
        [artifacts],
    );
    const workflowAttention = useWorkflowAttentionSource();
    const workflowRuns = useWorkflowRunRows(workflowAttention.runIds);
    const automationAttention = useAutomationAttentionSource();
    const automationRuns = useWorkflowRunRows(automationAttention.runIds);
    const automationAttentionItems = React.useMemo(() => automationRuns.flatMap((row): AutomationInboxItem[] => row.automation ? [{
        key: `automation-run:${row.id}`, run: row.automation,
        route: { pathname: '/automations/[id]/runs/[runId]', params: { id: row.automation.automationId, runId: row.id } },
    }] : []), [automationRuns]);
    const attentionStandings = storage((state) => state.sessionOrganizationAttentionStandingsBySessionKey) ?? EMPTY_STANDINGS;
    const sessionPresentation = React.useMemo(
        () => buildInboxSessionPresentation({
            overview,
            resolveMessages: (candidate) => {
                const hydrated = source.sessionsById[candidate.sessionId];
                const hydratedAddress = normalizeSessionAddress(hydrated?.serverId, hydrated?.id);
                if (!areSessionAddressesEqual(hydratedAddress, candidate.address)) return undefined;
                return readStoredSessionMessagesFromStateLike(
                    source.sessionMessagesById?.[candidate.sessionId],
                );
            },
        }),
        [overview, source.sessionMessagesById, source.sessionsById],
    );

    const sessionsById = source.sessionsById;
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
    const landings = React.useMemo(() => NO_PULL_REQUEST_LINKS.flatMap((link) => {
        const session = sessionsById[link.sessionId];
        const standing = session
            ? attentionStandings[buildSessionOrganizationSessionKey(session.serverId ?? '', session.id)]
            : undefined;
        // Settled (standing false) or merged work has landed; only an open link is Landing.
        return session && link.state === 'open' && standing?.standing !== false ? [{ session, link }] : [];
    }), [attentionStandings, sessionsById]);
    const workGroups = React.useMemo(() => buildInboxWorkGroups({
        sessionEntries: sessionPresentation.sessionsNeedingAttention,
        workflowRuns,
        stalledSessions,
        landings,
        snoozed,
        resolveSession: (sessionId) => sessionsById[sessionId],
        resolveOriginRunId: readAwarenessOriginRunId,
    }), [landings, sessionPresentation.sessionsNeedingAttention, sessionsById, snoozed, stalledSessions, workflowRuns]);

    const markAllReadTargets = sessionPresentation.markAllReadTargets;
    const targetBySessionAddress = React.useMemo(
        () => new Map(markAllReadTargets.map((target) => [target.key, target] as const)),
        [markAllReadTargets],
    );
    const isLoading = (
        (friends.visible && !friendsLoaded)
        || (!source.isDataReady && overview.candidates.length === 0)
        || (workflowAttention.available && workflowAttention.phase === 'loading')
        || (automationAttention.available && automationAttention.phase === 'loading')
    );
    const hasPrimaryAttention = openApprovals.length > 0
        || automationAttentionItems.length > 0
        || workGroups.length > 0
        || sessionPresentation.sessionsNeedingAttention.length > 0
        || sessionPresentation.readySessions.length > 0
        || friends.requests.length > 0
        || actionOperationEntries.length > 0;
    const showCaughtUp = !isLoading && !hasPrimaryAttention
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

    const settle = React.useCallback(async (session: Session) => {
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

    return React.useMemo(() => ({
        source,
        openApprovals,
        friendRequests: friends.requests,
        sessionPresentation,
        targetBySessionAddress,
        actionOperationEntries,
        pendingReadKeys,
        markAllPending,
        isLoading,
        hasPrimaryAttention,
        hasContent: hasPrimaryAttention,
        showCaughtUp,
        markRead,
        resolveActionOperation,
        workGroups,
        workflowAttention,
        automationAttention,
        automationAttentionItems,
        settle,
        setReminder,
    }), [
        actionOperationEntries,
        friends.requests,
        hasPrimaryAttention,
        isLoading,
        markAllPending,
        markRead,
        resolveActionOperation,
        openApprovals,
        pendingReadKeys,
        sessionPresentation,
        showCaughtUp,
        settle,
        setReminder,
        source,
        targetBySessionAddress,
        workGroups,
        workflowAttention,
        automationAttention,
        automationAttentionItems,
    ]);
}

/** Mount at an open Inbox screen or popover boundary. */
export function InboxModelProvider(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <WorkflowAttentionSourceBoundary>
            <InboxModelContextProvider>{props.children}</InboxModelContextProvider>
        </WorkflowAttentionSourceBoundary>
    );
}

function InboxModelContextProvider(props: Readonly<{ children: React.ReactNode }>) {
    const model = useCreateInboxModel();
    return (
        <InboxModelContext.Provider value={model}>
            {props.children}
        </InboxModelContext.Provider>
    );
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
