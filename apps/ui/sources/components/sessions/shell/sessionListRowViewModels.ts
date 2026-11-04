import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readSessionRuntimeObservation } from '@/sync/domains/session/sessionRuntimeObservation';
import type { SessionListHomeObservation, SessionListHomeObservationByServerId } from '@/sync/domains/session/listing/sessionListHomeObservation';
import type {
    SessionListContextualSearchReason,
    SessionListIndexItem,
} from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndexIdentity';
import { resolveSessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';
import {
    areSessionListRenderablesEqual,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import type { SessionListGuardState } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    readSessionRuntimePresentationFreshnessExpirations,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import {
    buildSessionContextFacts,
    projectSessionContextPresentation,
    readSessionHomeLastUpdatedRefreshAtMs,
} from '@/sync/domains/session/presentation/sessionContextPresentation';
import {
    resolveSessionAttentionStanding,
    resolveSessionReminderPresentation,
    type SessionAttentionStandingPolicy,
    type SessionReminderPresentation,
} from '@/sync/domains/session/organization/attentionStanding';
import type { WorkspaceDisplayEllipsizeMode } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { getSessionName, getSessionStatus, isUntitledSessionName, type SessionStatus } from '@/utils/sessions/sessionUtils';
import { formatShortRelativeTimeAt, readShortRelativeTimeRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { LruMap } from '@/utils/cache/lruMap';
import { t } from '@/text';
import type { SessionListRowDraft } from './useSessionListRowExistingDraft';

import { getTagsForSession, sessionTagKey } from './sessionTagUtils';
import { resolveSessionListRowContext, type SessionListRowContextFacts, type SessionListRowParentContextFacts } from '@/sync/domains/session/listing/sessionListRowContext';
import { projectGroupIdentityKey, readSessionListProjectDisplay, type ProjectGroupDisplay } from '@/sync/domains/workspaces/projectGroupDisplay';
import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SessionListIdentityDisplay } from '@happier-dev/protocol/account/settings/accountSettings';
import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';
import {
    readExternalAgentObservationPresentationInput,
    resolveExternalAgentPresentationState,
    resolveExternalSessionRuntimePresentation,
    type ExternalSessionRuntimePresentation,
} from '../presentation/externalSessionRuntimePresentation';
import {
    resolveExternalSessionIdentityPresentation,
    type ExternalSessionIdentityPresentation,
} from '../presentation/externalSessionIdentityPresentation';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';

function appendUniqueSearchReason(
    reasons: SessionListContextualSearchReason[],
    reason: SessionListContextualSearchReason,
): void {
    if (!reasons.includes(reason)) reasons.push(reason);
}

function resolveContextualSearchSubtitle(input: Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    session: SessionListRenderableSession | null;
}>): string | null {
    if (!input.item.contextualSearchReasons?.length) return null;

    const reasons = [...input.item.contextualSearchReasons];
    if (input.session?.archivedAt != null) appendUniqueSearchReason(reasons, 'archived');
    if (readExternalSessionLink(input.session?.metadata)) appendUniqueSearchReason(reasons, 'external');

    const sourceMachineId = String(input.item.contextualSearchSourceMachineId ?? '').trim();
    const sessionMachineId = String(input.session?.metadata?.machineId ?? '').trim();
    if (sourceMachineId && sessionMachineId && sourceMachineId !== sessionMachineId) {
        appendUniqueSearchReason(reasons, 'another-machine');
    }

    const labelByReason = {
        transcript: t('sessionsList.searchMatchTranscript'),
        'hidden-by-filters': t('sessionsList.searchMatchHiddenByFilters'),
        archived: t('sessionsList.searchMatchArchived'),
        external: t('sessionsList.searchMatchExternal'),
        'another-machine': t('sessionsList.searchMatchAnotherMachine'),
    } as const;
    return reasons.map((reason) => labelByReason[reason]).join(' · ');
}

export type SessionReachableDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
}>;

export type SessionListRowViewModel = Readonly<{
    groupKey: string;
    sessionKey: string | null;
    session: SessionListRenderableSession | null;
    sessionStatus: SessionStatus | null;
    externalSessionRuntime: ExternalSessionRuntimePresentation | null;
    externalSessionIdentity: ExternalSessionIdentityPresentation | null;
    isIdentityLoading: boolean;
    nextRuntimeFreshnessAtMs: number | null;
    hasUnreadMessages: boolean;
    activityTimeLabel: string;
    identityDisplay: 'avatar' | 'agentLogo' | 'none';
    activeColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    hideInactiveSessions: boolean;
    subtitleOverride: string | null;
    subtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
    pinned: boolean;
    showServerBadge: boolean;
    selected: boolean;
    tags: string[];
    secondaryLineMode: ReturnType<typeof resolveSessionListSecondaryLineMode>;
    /**
     * Retained working placement: the session is held in the working group
     * while its live signals are stale. Rows render the working indicator
     * WITHOUT animation for it, with a dedicated status text.
     */
    workingPlacementRetained: boolean;
    /**
     * The row sits in Needs attention only because the user asked it to. It
     * comes off the placement reason rather than the stored bit on purpose: a
     * kept session that is currently placed for being unread has something of
     * its own to say and must not be presented as merely kept.
     */
    attentionStanding: boolean;
    /**
     * The stored bit `resolveSessionAttentionStanding` returns for this row, NOT
     * the placement outcome above. Action surfaces must offer Remove for a kept
     * session even while it is currently placed for being unread, so the row
     * menu target reads this and never `attentionStanding`.
     */
    isAttentionStanding: boolean;
    reminder: SessionReminderPresentation | null;
    /** Whether the Keep / Remove action means anything at all (attention band on). */
    attentionStandingEnabled: boolean;
    draft: SessionListRowDraft | null;
    /** A guard stop is coming ("Stops in 4:52") or the guard stopped this session (plan 50 G3-2). */
    guardState: SessionListGuardState | null;
    rowContext: SessionListRowContextPresentation | null;
}>;

/** P5 row context (lab `clctx`): what the row says about where it runs, beyond its group. */
export type SessionListRowContextPresentation = Readonly<{
    leadingMark: 'agent' | 'project' | 'projectWithAgent' | 'avatar' | 'none';
    projectPlacement: 'none' | 'context' | 'trailing';
    /** Shown Project name; `yieldsToFavicon` when only a missing favicon puts it on screen. */
    project: Readonly<{ label: string; yieldsToFavicon: boolean }> | null;
    /** The row Project's fixed accepted baseline; mirrors observe the existing favicon resource. */
    projectFaviconSource: Readonly<{ serverId: string; machineId: string; workspacePath: string }> | null;
    checkout: Readonly<{ kind: 'branch' | 'path'; label: string }> | null;
    /** Project and checkout for assistive technology, even when visual context is off. */
    accessibleLabel: string;
    statusWords: boolean;
}>;

/** Inputs the shared Project display index and the person's View choices supply for every row. */
export type SessionListRowContextInput = Readonly<{
    enabled: boolean;
    identityDisplay: SessionListIdentityDisplay;
    projectDisplayByKey: ReadonlyMap<string, ProjectGroupDisplay>;
    groupProjectByGroupKey: ReadonlyMap<string, QualifiedProjectKeyV1>;
    /** The Account's `session.list.statusWords` choice: a state word beside the status glyph. */
    statusWords?: boolean;
    /** The device's favicon preference; off leaves every row Project mark on its fallback. */
    faviconsEnabled?: boolean;
}>;

/** Only the facts this occurrence consumes may cross its mounted row boundary. */
export type SessionListSelectedRowContextInput = Readonly<{
    rowContextEnabled: boolean;
    rowContextIdentityDisplay: SessionListIdentityDisplay;
    rowContextGroupServerId: string | null;
    rowContextGroupProjectKey: string | null;
    rowContextGroupFallbackKey: string | null;
    rowContextBaseline: WorkspaceRefV1 | null;
    rowContextProjectTitle: string | null;
    rowContextProjectFaviconServerId: string | null;
    rowContextProjectFaviconMachineId: string | null;
    rowContextProjectFaviconWorkspacePath: string | null;
    rowContextStatusWords: boolean;
}>;

export function selectSessionListRowContextInput(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    context: SessionListRowContextInput,
): SessionListSelectedRowContextInput {
    const groupKey = String(item.groupKey ?? '').trim();
    const groupProject = context.groupProjectByGroupKey.get(groupKey) ?? null;
    const projectDisplay = readSessionListProjectDisplay(item, context.projectDisplayByKey);
    const projectBaseline = context.faviconsEnabled === false ? undefined : projectDisplay?.baseline;
    return {
        rowContextEnabled: context.enabled,
        rowContextIdentityDisplay: context.identityDisplay,
        rowContextGroupServerId: groupProject?.serverId ?? null,
        rowContextGroupProjectKey: groupProject?.projectKey ?? null,
        rowContextGroupFallbackKey: item.groupKind === 'project' ? groupKey : null,
        rowContextBaseline: groupProject ? context.projectDisplayByKey.get(projectGroupIdentityKey(groupProject))?.baseline ?? null : null,
        rowContextProjectTitle: projectDisplay?.title ?? null,
        rowContextProjectFaviconServerId: projectBaseline?.serverId ?? null,
        rowContextProjectFaviconMachineId: projectBaseline?.machineId ?? null,
        rowContextProjectFaviconWorkspacePath: projectBaseline?.rootPath ?? null,
        rowContextStatusWords: context.statusWords === true,
    };
}

export type SessionListRowViewModelAdjacency = Readonly<{
    isFirst: boolean;
    isLast: boolean;
    isSingle: boolean;
}>;

const EMPTY_SESSION_LIST_ROW_VIEW_MODELS: ReadonlyArray<SessionListRowViewModel | null> = [];

type RowViewModelCacheEntry = Readonly<{
    sessionRef: SessionListRenderableSession | null;
    signature: string;
    value: SessionListRowViewModel;
}>;

const SESSION_LIST_ROW_VIEW_MODEL_CACHE = new LruMap<string, RowViewModelCacheEntry>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export type BuildSessionListRowViewModelInput = Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    unscopedSelectionIsUnique: boolean;
    reachableSessionDisplay?: SessionReachableDisplay;
    reachableSessionDisplayById?: ReadonlyMap<string, SessionReachableDisplay>;
    reachableSessionDisplayByKey?: ReadonlyMap<string, SessionReachableDisplay>;
    rowRenderableByKey?: ReadonlyMap<string, SessionListRenderableSession>;
    audienceScopes?: ReadonlyMap<string, ServerAccountScope>;
    /** Exact-Home list currentness from the canonical per-Home observation owner. */
    homeObservations?: SessionListHomeObservationByServerId;
    relativeNowMs?: number;
    runtimeNowMs?: number;
    identityDisplay?: SessionListIdentityDisplay;
    activeColorMode?: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    hideInactiveSessions?: boolean;
    pinnedSessionKeys: ReadonlySet<string>;
    sessionTags: Record<string, string[]>;
    selectedSessionId: string | null;
    selectedSessionServerId?: string | null;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
    attentionStandingEnabled?: boolean;
    attentionStandingPolicy?: SessionAttentionStandingPolicy;
    existingDraft?: SessionListRowDraft | null;
    rowContext?: SessionListSelectedRowContextInput;
}>;

function readRowContextFacts(item: Extract<SessionListIndexItem, { type: 'session' }>,
    session: SessionListRenderableSession | null): SessionListRowContextFacts {
    const metadata = session?.metadata;
    return {
        serverId: typeof item.serverId === 'string' && item.serverId ? item.serverId : null,
        project: item.projectKey ?? null,
        fallbackGroupKey: item.projectKey ? null : item.fallbackGroupDisplay?.groupKey ?? null,
        machineId: metadata?.machineId ?? null,
        workspaceId: metadata?.workspaceId ?? null,
        path: metadata?.path ?? null,
        ...(metadata && 'branch' in metadata ? { branch: metadata.branch ?? null } : {}),
    };
}

function basenameOf(path: string): string {
    const parts = path.split(/[\\/]/u).filter(Boolean);
    return parts[parts.length - 1] ?? path;
}

function buildRowContextPresentation(input: Readonly<{
    context: SessionListSelectedRowContextInput;
    facts: SessionListRowContextFacts;
    parent: SessionListRowParentContextFacts | null;
}>): SessionListRowContextPresentation {
    const groupProject = input.context.rowContextGroupServerId && input.context.rowContextGroupProjectKey
        ? { serverId: input.context.rowContextGroupServerId, projectKey: input.context.rowContextGroupProjectKey } : null;
    const baseline = input.context.rowContextBaseline;
    const shared = { facts: input.facts, groupProject, groupFallbackKey: input.context.rowContextGroupFallbackKey,
        baseline, parent: input.parent, identityDisplay: input.context.rowContextIdentityDisplay };
    const resolved = resolveSessionListRowContext({ ...shared, enabled: input.context.rowContextEnabled });
    const withFavicon = resolveSessionListRowContext({ ...shared, enabled: input.context.rowContextEnabled, hasProjectFavicon: true });
    const projectTitle = input.context.rowContextProjectTitle;
    const branch = input.facts.branch;
    const inOwnGroup = (groupProject !== null && input.facts.project !== null
        && projectGroupIdentityKey(groupProject) === projectGroupIdentityKey(input.facts.project))
        || Boolean(!input.facts.project && input.facts.fallbackGroupKey
            && input.facts.fallbackGroupKey === input.context.rowContextGroupFallbackKey);
    // A known branch names the checkout. An unknown one keeps an honest folder suffix only where the
    // group's admitted baseline proves this row sits in another checkout; detached (null) says nothing.
    const checkout = typeof branch === 'string' && branch
        ? { kind: 'branch' as const, label: branch }
        : branch === undefined && inOwnGroup && baseline && input.facts.workspaceId && input.facts.path
            && basenameOf(input.facts.path) !== basenameOf(baseline.rootPath)
            ? { kind: 'path' as const, label: basenameOf(input.facts.path) }
            : null;
    const accessibleLabel = [
        (input.facts.project || input.facts.fallbackGroupKey) && !inOwnGroup ? projectTitle : null,
        checkout?.label ?? null,
    ].filter((part): part is string => Boolean(part)).join(', ');
    return {
        leadingMark: resolved.identity.leadingMark,
        projectPlacement: resolved.identity.projectPlacement,
        project: resolved.identity.showProjectName && projectTitle
            ? { label: projectTitle, yieldsToFavicon: !withFavicon.identity.showProjectName }
            : null,
        projectFaviconSource: input.context.rowContextProjectFaviconServerId
            && input.context.rowContextProjectFaviconMachineId && input.context.rowContextProjectFaviconWorkspacePath
            ? { serverId: input.context.rowContextProjectFaviconServerId,
                machineId: input.context.rowContextProjectFaviconMachineId,
                workspacePath: input.context.rowContextProjectFaviconWorkspacePath }
            : null,
        checkout: resolved.showCheckout ? checkout : null,
        accessibleLabel,
        statusWords: input.context.rowContextStatusWords,
    };
}

/** Row-local deadline selection on the existing shared clock, not a per-row timer. */
export function readSessionListRowRefreshAtMs(input: Readonly<{
    session: SessionListRenderableSession | null;
    reminderAtMs: number | null;
    homeObservation?: SessionListHomeObservation | null;
}>, nowMs: number): number | null {
    const session = input.session;
    const activityAt = session ? resolveSessionListRenderableMeaningfulActivityAt(session) : null;
    const externalExpiryAtMs = session && readExternalSessionLink(session.metadata)
        ? resolveExternalAgentPresentationState(readExternalAgentObservationPresentationInput(session.metadata), nowMs).nextExpiryAtMs
        : null;
    return resolveEarliestFreshnessAtMs(
        resolveEarliestFreshnessAtMs(session ? resolveNextRuntimeFreshnessAtMs(session, nowMs) : null, externalExpiryAtMs),
        resolveEarliestFreshnessAtMs(
            resolveEarliestFreshnessAtMs(
                activityAt !== null && activityAt > 0 ? readShortRelativeTimeRefreshAtMs(activityAt, nowMs) : null,
                readSessionHomeLastUpdatedRefreshAtMs(input.homeObservation, nowMs),
            ),
            input.reminderAtMs !== null && input.reminderAtMs > nowMs ? input.reminderAtMs : null,
        ),
    );
}

export function buildSessionListRowViewModel(input: BuildSessionListRowViewModelInput): SessionListRowViewModel {
    const item = input.item;
    const groupKey = String(item.groupKey ?? '').trim();
    const sessionId = String(item.sessionId ?? '').trim();
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    const sessionKey = serverId && sessionId ? sessionTagKey(serverId, sessionId) : null;
    const rowKey = buildSessionListServerScopedRowKey(serverId, sessionId);
    const pinned = item.pinned === true || (sessionKey ? input.pinnedSessionKeys.has(sessionKey) : false);
    const reachableDisplay = input.reachableSessionDisplay
        ?? (sessionKey ? input.reachableSessionDisplayByKey?.get(sessionKey) : undefined)
        ?? input.reachableSessionDisplayById?.get(sessionId);
    const workspaceSubtitle = reachableDisplay?.workspaceSubtitle ?? '';
    const subtitleEllipsizeMode = reachableDisplay?.workspaceSubtitleEllipsizeMode ?? 'head';
    const workspaceLabel = workspaceSubtitle;
    const session = rowKey ? input.rowRenderableByKey?.get(rowKey) ?? null : null;
    const relativeNowMs = normalizeClockNow(input.relativeNowMs);
    const runtimeNowMs = normalizeClockNow(input.runtimeNowMs);
    const activityAt = session ? resolveSessionListRenderableMeaningfulActivityAt(session) : null;
    const activityTimeLabel = typeof activityAt === 'number' && activityAt > 0
        ? formatShortRelativeTimeAt(activityAt, relativeNowMs)
        : '';
    const sessionStatus = session
        ? getSessionStatus(session, runtimeNowMs, {
            vibingIndex: resolveStableVibingIndex(sessionKey ?? sessionId),
        })
        : null;
    const sessionMetadata = session?.metadata;
    const externalSessionLink = readExternalSessionLink(sessionMetadata);
    const externalSessionIdentity = externalSessionLink
        ? resolveExternalSessionIdentityPresentation(sessionMetadata, reachableDisplay?.machineId)
        : null;
    const externalSessionRuntime = externalSessionLink && sessionStatus
        ? resolveExternalSessionRuntimePresentation({
            controlConnectivity: sessionStatus.isConnected ? 'connected' : 'offline',
            detachedActivity: sessionStatus.awareness?.runtime === 'background_active'
                ? 'active'
                : sessionStatus.isConnected
                    ? 'idle'
                    : 'unknown',
            externalAgent: readExternalAgentObservationPresentationInput(sessionMetadata),
            nowMs: runtimeNowMs,
        })
        : null;
    const sessionName = session ? getSessionName(session, serverId) : '';
    const contextualSearchSubtitle = resolveContextualSearchSubtitle({ item, session });
    const selectedSessionServerId = String(input.selectedSessionServerId ?? '').trim();
    // One quiet secondary line, composed by the shared context owner rather than here: it decides
    // whether this viewer may see the workspace at all and adds the single responsibility marker.
    // The Home stays with the incumbent server badge, so it is deliberately not a segment here.
    const subtitle = serverId && sessionId
        ? projectSessionContextPresentation(buildSessionContextFacts({
            address: { serverId, sessionId },
            awareness: sessionStatus?.awareness ?? null,
            viewer: session?.viewer,
            audienceContext: session?.access?.audienceContext,
            audienceScope: input.audienceScopes?.get(serverId),
            workspaceLabel,
            homeObservation: input.homeObservations?.[serverId] ?? null,
            nowMs: relativeNowMs,
        })).contextLine ?? ''
        : workspaceLabel;
    const reminder = input.attentionStandingPolicy && sessionKey
        ? resolveSessionReminderPresentation(input.attentionStandingPolicy.overridesBySessionKey[sessionKey], runtimeNowMs)
        : null;
    const reminderWakeAtMs = reminder?.state === 'scheduled' ? reminder.remindAt : null;

    const rowViewModel: SessionListRowViewModel = {
        groupKey,
        sessionKey,
        session,
        sessionStatus,
        externalSessionRuntime,
        externalSessionIdentity,
        // A row whose canonical renderable has not landed yet is still materializing.
        // It renders the identity transition affordance rather than a blank row that
        // reads as a real session with no name.
        isIdentityLoading: session ? resolveRowIdentityLoading({
            session,
            title: sessionName,
        }) : true,
        nextRuntimeFreshnessAtMs: resolveEarliestFreshnessAtMs(
            resolveEarliestFreshnessAtMs(
                session ? resolveNextRuntimeFreshnessAtMs(session, runtimeNowMs) : null,
                externalSessionRuntime?.externalAgent.nextExpiryAtMs ?? null,
            ),
            reminderWakeAtMs,
        ),
        hasUnreadMessages: session?.hasUnreadMessages === true,
        activityTimeLabel,
        identityDisplay: input.identityDisplay === 'agentLogo' || input.identityDisplay === 'none' ? input.identityDisplay : 'avatar',
        activeColorMode: normalizeActiveColorMode(input.activeColorMode),
        hideInactiveSessions: input.hideInactiveSessions === true,
        subtitleOverride: contextualSearchSubtitle
            ?? (item.groupKind === 'project' && item.variant === 'no-path' ? null : (subtitle || null)),
        subtitleEllipsizeMode,
        pinned,
        showServerBadge: pinned ? input.showPinnedServerBadge : input.showServerBadge,
        selected: input.selectedSessionId != null
            && input.selectedSessionId === sessionId
            && (
                selectedSessionServerId
                    ? selectedSessionServerId === serverId
                    : input.unscopedSelectionIsUnique
            ),
        tags: getTagsForSession(input.sessionTags, sessionKey ?? ''),
        secondaryLineMode: resolveSessionListSecondaryLineMode({ groupKind: item.groupKind }),
        workingPlacementRetained: item.workingPlacementReason === 'working-retained',
        attentionStanding: item.attentionPlacementReason === 'standing',
        isAttentionStanding: input.attentionStandingPolicy != null && sessionKey != null
            ? resolveSessionAttentionStanding(input.attentionStandingPolicy, sessionKey, runtimeNowMs)
            : false,
        reminder,
        attentionStandingEnabled: input.attentionStandingEnabled === true && sessionKey != null,
        draft: input.existingDraft ?? null,
        // A stopped session that is working again (it woke on a message) shows its working state instead.
        guardState: session?.guardState?.kind === 'stopped' && session.active ? null : session?.guardState ?? null,
        rowContext: input.rowContext ? buildRowContextPresentation({
            context: input.rowContext,
            facts: readRowContextFacts(item, session),
            parent: item.reportsParentContext ?? null,
        }) : null,
    };
    const signature = buildRowViewModelSignature(rowViewModel);
    const cacheKey = buildSessionListIndexNodeId(item);
    const cached = SESSION_LIST_ROW_VIEW_MODEL_CACHE.get(cacheKey);
    if (
        cached?.signature === signature
        && (
            cached.sessionRef === session
            || (cached.sessionRef != null && session != null && areSessionListRenderablesEqual(cached.sessionRef, session))
        )
    ) {
        return cached.value;
    }
    SESSION_LIST_ROW_VIEW_MODEL_CACHE.set(cacheKey, {
        sessionRef: session,
        signature,
        value: rowViewModel,
    });
    return rowViewModel;
}

export function resolveSessionListRowViewModelAdjacency(
    listItems: ReadonlyArray<SessionListIndexItem>,
    index: number,
): SessionListRowViewModelAdjacency {
    const item = listItems[index];
    if (!item || item.type === 'header') return { isFirst: true, isLast: true, isSingle: true };
    // A group sheet runs from one heading to the next: consecutive rows share it even when their
    // placement groups differ (a working band flowing into its section), and a header that draws no
    // heading (no title, `resolveSessionListHeaderViewState`) does not cut it, so no sheet is unlabeled.
    const previous = neighbourOf(listItems, index, -1);
    const next = neighbourOf(listItems, index, 1);
    const isFirst = previous == null || previous.type === 'header';
    const isLast = next == null || next.type === 'header';
    return { isFirst, isLast, isSingle: isFirst && isLast };
}

function neighbourOf(
    listItems: ReadonlyArray<SessionListIndexItem>,
    index: number,
    step: -1 | 1,
): SessionListIndexItem | null {
    for (let cursor = index + step; cursor >= 0 && cursor < listItems.length; cursor += step) {
        const item = listItems[cursor]!;
        if (item.type === 'header' && !item.title) continue;
        return item;
    }
    return null;
}

export function resolveSessionListUnscopedSelectionIsUnique(
    listItems: ReadonlyArray<SessionListIndexItem>,
    selectedSessionId: string | null,
): boolean {
    if (!selectedSessionId) return false;
    let matchingServerId: string | undefined;
    let found = false;
    for (const candidate of listItems) {
        if (candidate.type !== 'session' || candidate.sessionId !== selectedSessionId) continue;
        const serverId = String(candidate.serverId ?? '').trim();
        if (found && matchingServerId !== serverId) return false;
        matchingServerId = serverId;
        found = true;
    }
    return found;
}

export function buildSessionListRowViewModels(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    reachableSessionDisplayById: ReadonlyMap<string, SessionReachableDisplay>;
    reachableSessionDisplayByKey?: ReadonlyMap<string, SessionReachableDisplay>;
    rowRenderableByKey?: ReadonlyMap<string, SessionListRenderableSession>;
    audienceScopes?: ReadonlyMap<string, ServerAccountScope>;
    /** Exact-Home list currentness from the canonical per-Home observation owner. */
    homeObservations?: SessionListHomeObservationByServerId;
    relativeNowMs?: number;
    runtimeNowMs?: number;
    identityDisplay?: 'avatar' | 'agentLogo' | 'none';
    activeColorMode?: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    hideInactiveSessions?: boolean;
    pinnedSessionKeys: ReadonlySet<string>;
    sessionTags: Record<string, string[]>;
    selectedSessionId: string | null;
    selectedSessionServerId?: string | null;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
    attentionStandingEnabled?: boolean;
    attentionStandingPolicy?: SessionAttentionStandingPolicy;
    rowContext?: SessionListRowContextInput;
}>): ReadonlyArray<SessionListRowViewModel | null> {
    if (input.listItems.length === 0) {
        return EMPTY_SESSION_LIST_ROW_VIEW_MODELS;
    }

    const next = input.listItems.map((item) => {
        if (item.type !== 'session') return null;

        return buildSessionListRowViewModel({
            ...input,
            item,
            rowContext: input.rowContext ? selectSessionListRowContextInput(item, input.rowContext) : undefined,
            unscopedSelectionIsUnique: !String(input.selectedSessionServerId ?? '').trim()
                && input.selectedSessionId === item.sessionId
                && resolveSessionListUnscopedSelectionIsUnique(input.listItems, input.selectedSessionId),
        });
    });
    return next;
}

function buildRowViewModelSignature(viewModel: SessionListRowViewModel): string {
    return JSON.stringify([
        viewModel.groupKey,
        viewModel.sessionKey ?? '',
        viewModel.sessionStatus?.state ?? '',
        viewModel.sessionStatus?.statusText ?? '',
        viewModel.sessionStatus?.shouldShowStatus === true ? '1' : '0',
        viewModel.externalSessionRuntime?.controlConnectivity ?? '',
        viewModel.externalSessionRuntime?.detachedActivity ?? '',
        viewModel.externalSessionRuntime?.externalAgent.state ?? '',
        viewModel.externalSessionRuntime?.externalAgent.nextExpiryAtMs ?? '',
        viewModel.externalSessionIdentity?.agentId ?? '',
        viewModel.externalSessionIdentity?.identityLabel ?? '',
        viewModel.externalSessionIdentity?.rowMetadataLabel ?? '',
        viewModel.isIdentityLoading ? '1' : '0',
        viewModel.nextRuntimeFreshnessAtMs ?? '',
        viewModel.hasUnreadMessages ? '1' : '0',
        viewModel.activityTimeLabel,
        viewModel.identityDisplay,
        viewModel.activeColorMode,
        viewModel.hideInactiveSessions ? '1' : '0',
        viewModel.subtitleOverride ?? '',
        viewModel.subtitleEllipsizeMode,
        viewModel.pinned ? '1' : '0',
        viewModel.showServerBadge ? '1' : '0',
        viewModel.selected ? '1' : '0',
        viewModel.tags,
        viewModel.secondaryLineMode,
        viewModel.workingPlacementRetained ? '1' : '0',
        viewModel.attentionStanding ? '1' : '0',
        viewModel.isAttentionStanding ? '1' : '0',
        viewModel.reminder?.state ?? '',
        viewModel.reminder?.remindAt ?? '',
        viewModel.attentionStandingEnabled ? '1' : '0',
        viewModel.draft ? '1' : '0',
        viewModel.draft?.hasPreview ? '1' : '0',
        viewModel.guardState?.kind ?? '',
        viewModel.guardState?.kind === 'stopping' ? viewModel.guardState.stopAt : '',
        viewModel.rowContext,
    ]);
}

function normalizeClockNow(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function resolveEarliestFreshnessAtMs(
    first: number | null,
    second: number | null,
): number | null {
    if (first === null) return second;
    if (second === null) return first;
    return Math.min(first, second);
}

function normalizeActiveColorMode(
    value: 'activityAndAttention' | 'attentionOnly' | 'allActive' | null | undefined,
): 'activityAndAttention' | 'attentionOnly' | 'allActive' {
    return value === 'attentionOnly' || value === 'allActive' ? value : 'activityAndAttention';
}

function resolveStableVibingIndex(key: string): number {
    let hash = 0;
    for (let index = 0; index < key.length; index += 1) {
        hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
    }
    return hash;
}

function resolveRowIdentityLoading(input: Readonly<{
    session: SessionListRenderableSession;
    title: string;
}>): boolean {
    const metadataUnavailable = input.session.metadataUnavailable === true;
    return !metadataUnavailable
        && input.session.metadata == null
        && isUntitledSessionName(input.title);
}

function resolveNextRuntimeFreshnessAtMs(session: SessionListRenderableSession, nowMs: number): number | null {
    session = readSessionRuntimeObservation(session);
    if (session.presence !== 'online') return null;

    const expirations = readSessionRuntimePresentationFreshnessExpirations({
        id: session.id,
        serverId: session.serverId,
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        optimisticThinkingAt: session.optimisticThinkingAt,
        hasPendingUserMessages: typeof session.pendingCount === 'number' && session.pendingCount > 0,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        runtimeActivityState: session.runtimeActivityState ?? 'unknown',
        runtimeActivityActiveCount: session.runtimeActivityActiveCount ?? null,
        runtimeActivityObservedAt: session.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: session.runtimeActivityRevision ?? null,
        hasPendingPermissionRequests: session.hasPendingPermissionRequests === true,
        hasPendingUserActionRequests: session.hasPendingUserActionRequests === true,
        pendingRequestObservedAt: session.pendingRequestObservedAt ?? null,
    }, nowMs);

    const staleAtMs = session.activeAt + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1;
    const deadlines = [...expirations, ...(session.active && staleAtMs > nowMs ? [staleAtMs] : [])];
    if (deadlines.length === 0) return null;
    return Math.min(...deadlines);
}
