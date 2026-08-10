import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
import type { SessionViewportAnchorSnapshot } from '@/sync/sync';
import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import type { ChatFooterDirectControlState } from './ChatFooter';
import type { PendingMessageEditRequest } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import type { TranscriptNavigationEntry } from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';
import type { TranscriptJumpResult } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import type { TranscriptSessionCommonProps } from '@/components/sessions/transcript/transcriptSessionCommon';
import type { TranscriptRollbackAction, SessionRollbackRangeV1 } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import type { TranscriptEventEmphasisByMessageId } from '@/components/sessions/transcript/events/transcriptEventEmphasis';

export type ChatTranscriptListItem = TranscriptRowShellItem;

/**
 * Which session each rendered row came from, for a transcript that concatenates a fork's
 * read-only ancestor context with its own rows. `null` for an ordinary transcript, where every
 * row belongs to the session being viewed.
 *
 * This is what makes a per-session fact — above all `seq`, which counts from each session's own
 * origin — answerable for a row in a mixed list.
 */
export type TranscriptForkMessageMetadataById = Readonly<Record<string, {
    originSessionId: string;
    isReadOnlyContext: boolean;
}>>;

export type ChatListBottomNotice = {
    title: string;
    body: string;
};

export type TranscriptViewportChangeState = Readonly<{
    isPinned: boolean;
    /**
     * Distance metadata for observed viewports. Omitted (or non-finite) means
     * "position unknown": the emit carries pin/detach intent only, and the sync
     * boundary preserves the previously stored offset metadata instead of
     * treating the emit as a measured position.
     */
    offsetY?: number;
    shouldPersistViewport?: boolean;
    shouldRestoreViewport: boolean;
    anchor?: SessionViewportAnchorSnapshot | null;
}>;

export type PendingJumpSeqViewportPromotion = Readonly<{
    emitViewportChange: ((state: TranscriptViewportChangeState) => void) | undefined;
    seq: number;
    sessionId: string;
}>;

export type PromotedJumpSeqViewportProtection = Readonly<{
    promotedAtMs: number;
    seq: number;
    sessionId: string;
}>;

export type ChatListProps = Readonly<{
    session: Session;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControlFooter?: ChatFooterDirectControlState;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    jumpToSeq?: number | null;
    followBottomIntentKey?: string | number | null;
    onJumpLanded?: (result: Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>) => void;
    onViewportChange?: (state: TranscriptViewportChangeState) => void;
    onEditPendingMessage?: (request: PendingMessageEditRequest) => void | Promise<void>;
    isWarmKeepAliveInstance?: boolean;
    routeHydrationPending?: boolean;
}>;

export type ChatListInternalProps = Readonly<{
    metadata: Metadata | null;
    sessionId: string;
    sessionActive: boolean;
    sessionThinking: boolean;
    groupingMode: string;
    forkedTranscriptEnabled: boolean;
    items: ChatTranscriptListItem[];
    maxTurnEntriesPerListItem: number;
    transcriptNavigationEntries: readonly TranscriptNavigationEntry[];
    messagePins: readonly PersistedSessionMessagePinV1[];
    onToggleMessagePin: (pin: PersistedSessionMessagePinV1) => void;
    messagesById: Readonly<Record<string, Message>>;
    eventEmphasisByMessageId: TranscriptEventEmphasisByMessageId;
    forkMessageMetadataById: TranscriptForkMessageMetadataById | null;
    committedMessagesCount: number;
    latestCommittedActivityKey: string | null;
    activeThinkingMessageId: string | null;
    rollbackRanges: readonly SessionRollbackRangeV1[];
    rollbackActionsByMessageId: Readonly<Record<string, TranscriptRollbackAction>>;
    isLoaded: boolean;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControlFooter?: ChatFooterDirectControlState;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    interaction: TranscriptInteraction;
    jumpToSeq?: number | null;
    followBottomIntentKey?: string | number | null;
    onJumpLanded?: (result: Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>) => void;
    onViewportChange?: (state: TranscriptViewportChangeState) => void;
    onEditPendingMessage?: (request: PendingMessageEditRequest) => void | Promise<void>;
    isWarmKeepAliveInstance?: boolean;
    routeHydrationPending?: boolean;
} & TranscriptSessionCommonProps>;
