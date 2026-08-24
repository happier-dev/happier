import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { SessionPending } from '@/sync/store/domains/pending';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import type { SessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';
import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';
import type { SessionRowAttentionState, SessionRowDensity, SessionRowPresentation } from './resolveSessionRowPresentation';

export type SessionListRowSessionItem = Extract<SessionListViewItem, { type: 'session' }>;
export type SessionListSessionItem = SessionListRowSessionItem & { selected?: boolean };

export type SessionListRowStateSnapshot = Readonly<{
    session: Session | undefined;
    renderable: SessionListRenderableSession | undefined;
    messages: SessionMessages | undefined;
    pending: SessionPending | undefined;
    /** Safe, one-line read projection from the canonical draft repository. */
    draft?: Readonly<{ preview: string }> | null;
}>;

export type SessionListRowStoreState = Readonly<{
    activeServerId?: string | null;
    sessions?: Readonly<Record<string, Session | undefined>>;
    sessionListRenderables?: Readonly<Record<string, SessionListRenderableSession | undefined>>;
    sessionMessages?: Readonly<Record<string, SessionMessages | undefined>>;
    sessionPending?: Readonly<Record<string, SessionPending | undefined>>;
}>;

export type SessionListRowPresentationSettings = Readonly<{
    currentUserId: string | null;
    density: SessionRowDensity;
    compact: boolean;
    compactMinimal: boolean;
    identityDisplay: 'avatar' | 'agentLogo' | 'none';
    activeColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    workingIndicatorMode: 'spinner' | 'pulse';
    workingTextMode: 'animated' | 'static';
    statusColors: Readonly<{
        connected: string;
        connecting: string;
        actionRequired: string;
        disconnected: string;
        error: string;
        default: string;
    }>;
    hideInactiveSessions: boolean;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
    /**
     * Opt-in, OFF by default (R-8). A count on every row is a number a person did not ask for on a
     * surface they scan rather than read, so the row model always carries it and the setting decides
     * whether it is drawn.
     */
    agentActivityCountEnabled: boolean;
    tagsEnabled: boolean;
    sessionTagsByKey: Readonly<Record<string, readonly string[]>>;
    allKnownTags: readonly string[];
    pinnedSessionKeys: readonly string[];
    /**
     * Whether the Keep in Needs attention action is reachable at all: with the attention band off
     * there is nothing for a kept session to be held in.
     */
    attentionStandingEnabled: boolean;
    /**
     * Account default plus per-session overrides. Carried as the policy rather than a resolved key
     * list because a `true` default would make that list every session minus the explicit exceptions.
     */
    attentionStandingPolicy: SessionAttentionStandingPolicy;
    hasMultipleMachines: boolean;
    reachableSessionDisplayByKey: Readonly<Record<string, {
        workspaceSubtitle?: string;
        machineLabel?: string;
        workspaceSubtitleEllipsizeMode?: 'head' | 'tail';
    } | undefined>>;
    folderViewEnabled: boolean;
    relativeNowMs: number;
    runtimeNowMs: number;
}>;

export type SessionListRowModel = Readonly<{
    rowKey: string;
    sessionId: string;
    serverId: string | null;
    serverName?: string;
    treeRowId: string;
    testID: string;
    dataIndex: number;
    session: Session | SessionListRenderableSession;
    status: SessionStatus;
    statusSignature: string;
    nextRuntimeFreshnessAtMs: number | null;
    secondaryLineMode: SessionListSecondaryLineMode;
    attention: Readonly<{
        listState: import('@/sync/domains/session/listing/deriveSessionListActivity').SessionListAttentionState;
        rowState: SessionRowAttentionState;
    }>;
    presentation: SessionRowPresentation;
    activity: Readonly<{
        mode: 'meaningful' | 'updatedAt';
        timestamp: number | null;
        label: string;
        bucket: string;
    }>;
    isIdentityLoading: boolean;
    title: string;
    subtitle: string;
    subtitleEllipsizeMode: 'head' | 'tail';
    groupKey: string;
    groupKind: SessionListRowSessionItem['groupKind'] | null;
    section: SessionListRowSessionItem['section'] | 'recent' | 'pinned' | 'archived' | null;
    variant: SessionListRowSessionItem['variant'] | null;
    folder: Readonly<{ id: string | null; depth: number }>;
    adjacency: Readonly<{ isFirst: boolean; isLast: boolean; isSingle: boolean }>;
    isSelected: boolean;
    isPinned: boolean;
    /**
     * The STORED standing for this session, not the reason it currently sits in the band. A standing
     * session that is also unread is placed for being unread, and its menu must still offer to
     * remove it from Needs attention.
     */
    isAttentionStanding: boolean;
    attentionStandingEnabled: boolean;
    isArchived: boolean;
    isActive: boolean;
    hasUnreadMessages: boolean;
    pendingCount: number;
    pendingBlockedCount: number;
    /** Stable, safe one-line projection from the canonical session-draft owner. */
    draft: Readonly<{ preview: string }> | null;
    /**
     * What agent work is live in this session, in the same words the composer chip uses.
     *
     * Always composed when the setting is on and always `null` when it is off, so a row never
     * carries a sentence the list is not drawing. Built from the session's published headline —
     * the only agent-activity source a list row can afford (see
     * `countSessionAgentActivityFromMetadata`) — through the chip's own label owner, because a row
     * that reduced it to one integer said "1 agent working" about a five-agent workflow.
     */
    agentActivityLabel: string | null;
    tags: readonly string[];
    allKnownTags: readonly string[];
    tagsEnabled: boolean;
    currentUserId: string | null;
    showServerBadge: boolean;
    compact: boolean;
    compactMinimal: boolean;
    identityDisplay: 'avatar' | 'agentLogo' | 'none';
    activeColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    workingIndicatorMode: 'spinner' | 'pulse';
    /** Retained working placement: show the working indicator without animation. */
    workingIndicatorPaused: boolean;
    hideInactiveSessions: boolean;
}>;
