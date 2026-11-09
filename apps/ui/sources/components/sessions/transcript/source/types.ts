import type { Message, TranscriptOlderPageLoadResult } from '@happier-dev/session-core/messages';
import type { ReducerState } from '@happier-dev/session-core/reducer';
import type { AgentState, Metadata } from '@happier-dev/session-core/state';
import type { SessionPendingRequestLists } from '@happier-dev/session-core/pending';
import type { SessionAwarenessProjectionV1} from '@happier-dev/protocol/sessions/awareness/projectionV1';
import type { SessionPermissionRespondRpcParamsV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionForkSupportSource } from '@/sync/domains/sessionFork/forkUiSupport';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import type { sync } from '@/sync/sync';

export type TranscriptTargetWindowRequest = Parameters<typeof sync.loadTargetWindowMessages>[1];
export type TranscriptHistoryState = Readonly<{
    isLoaded: boolean;
    hasOlder: boolean;
    isLoadingOlder: boolean;
    hasNewer?: boolean;
    isLoadingNewer?: boolean;
    targetWindow?: Readonly<{ windowId: string; targetSeq: number; olderCursor: number | null; newerCursor: number | null }> | null;
}>;
export type SessionTranscriptSubmitOptions = Pick<NonNullable<Parameters<typeof sync.submitMessage>[4]>, 'callerSurface'> & Readonly<{
    permissionModeOverride?: import('@/sync/domains/permissions/permissionTypes').PermissionMode;
}>;
export type SessionRequestReadOutcome = 'pending' | 'settled';
export type SessionTranscriptActions = Readonly<{
    respondToPermission(params: Omit<SessionPermissionRespondRpcParamsV1, 'answers'>): Promise<void>;
    answerUserAction(params:
        | (Pick<SessionPermissionRespondRpcParamsV1, 'id' | 'answerDetails'> & Required<Pick<SessionPermissionRespondRpcParamsV1, 'answers'>> & { decision?: never })
        | (Pick<SessionPermissionRespondRpcParamsV1, 'id'> & { decision: 'reject'; answers?: never })
    ): Promise<void>;
    abort(): Promise<void>;
    /**
     * Reads the exact Session on its own Home and says whether the request is still waiting for an answer
     * or has settled; a settled answer means the fresh Session is already published through the store owner.
     * Rejects when the read fails, cannot tell, or the Account it was bound to is no longer current; absent where the
     * source has no authority to read.
     */
    readRequestOutcome?(requestId: string): Promise<SessionRequestReadOutcome>;
    submitMessage(text: string, options?: SessionTranscriptSubmitOptions): Promise<void>;
}>;

export type SessionTranscriptSource = Readonly<{
    kind: 'app' | 'readOnly';
    sessionId: string;
    serverId: string | null;
    useInteraction(): TranscriptInteraction;
    useMessageIdsOldestFirst(): readonly string[];
    /** Structure consumers leave streaming text to the rendered row subscriptions. */
    useMessagesById(options?: Readonly<{ textUpdates?: boolean }>): Readonly<Record<string, Message>>;
    useMessage(messageId: string): Message | null;
    useMessagesByIds(ids: readonly string[]): readonly (Message | null)[];
    useReducerState(options?: Readonly<{ textUpdates?: boolean }>): ReducerState | null;
    useAwareness(): SessionAwarenessProjectionV1 | null;
    /** Runtime observation time for offline labels; static datasets have no runtime. */
    useRuntimeLastObservedAt(): number | null;
    useMetadata(): Metadata | null;
    useAgentState(): AgentState | null;
    useWorkspacePath(): string | null;
    useForkSupportSource(): SessionForkSupportSource | null;
    useAuthorship(): Readonly<{ viewerScope: ServerAccountScope | null; hasOtherNamedCollaborator: boolean }>;
    usePendingRequests(): SessionPendingRequestLists;
    useConnectionState(): 'live' | 'connecting' | 'offline' | 'static';
    history: Readonly<{
        useState(): TranscriptHistoryState;
        loadOlder: ((options?: Parameters<typeof sync.loadOlderMessages>[1]) => Promise<TranscriptOlderPageLoadResult>) | null;
        /** Find consumes both missing frontiers without leaving an active historical window. */
        loadFindPage?: ((direction: 'older' | 'newer', options?: Parameters<typeof sync.loadOlderMessages>[1]) => Promise<TranscriptOlderPageLoadResult>) | null;
        loadTargetWindow: ((target: TranscriptTargetWindowRequest, options?: Parameters<typeof sync.loadTargetWindowMessages>[2]) => ReturnType<typeof sync.loadTargetWindowMessages>) | null;
    }>;
    loadSidechain: ((sidechainId: string) => ReturnType<typeof sync.ensureSidechainMessagesLoaded>) | null;
    navigate: ((href: string) => void) | null;
    actions: SessionTranscriptActions | null;
}>;
