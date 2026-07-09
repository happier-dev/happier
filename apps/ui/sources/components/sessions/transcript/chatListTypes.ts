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

export type ChatTranscriptListItem = TranscriptRowShellItem;

export type ChatListBottomNotice = {
    title: string;
    body: string;
};

export type TranscriptViewportChangeState = Readonly<{
    isPinned: boolean;
    offsetY: number;
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
    forkMessageMetadataById: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>> | null;
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
