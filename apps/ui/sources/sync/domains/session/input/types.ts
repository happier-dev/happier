import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { PermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import type {
    BusySteerSendPolicy,
    MessageSendMode,
    NonSteerablePayloadReason,
    NonSteerableSendPromptSetting,
    SessionMessageDirectBypassReason,
} from '@/sync/domains/session/control/submitMode';
import type { PendingRequestedActionV1 } from '@happier-dev/protocol';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ResumeSessionOptions, ResumeSessionResult } from '@/sync/ops/sessions';
import type { SessionInactiveResumePolicy } from '@/sync/domains/session/control/inactiveResumePolicy';

export type SubmitResultType =
    | 'success'
    | 'wake_pending'
    | 'wake_failed'
    | 'send_failed'
    | 'rejected';

export type SubmitPersistence =
    | 'pending'
    | 'transcript_committed'
    | 'provider_direct'
    | 'none';

export type SubmitWakeState =
    | 'not_needed'
    | 'started'
    | 'already_active'
    | 'failed';

export type SubmitSessionUserMessageResult = Readonly<{
    type: SubmitResultType;
    persistence: SubmitPersistence;
    providerAcceptancePending?: boolean;
    wake: Readonly<{
        attempted: boolean;
        state: SubmitWakeState;
        errorMessage?: string;
    }>;
    errorCode?: string;
    errorMessage?: string;
    localId?: string;
}>;

export type SubmitSessionOutboundHandoff = Readonly<{
    persistence: Extract<SubmitPersistence, 'pending' | 'transcript_committed' | 'provider_direct'>;
    localId?: string;
}>;

export type SessionSubmitWakeTargetOverride = Readonly<{
    machineId?: string | null;
    directory?: string | null;
}>;

export type SessionMessageCallerSurface =
    | 'session_composer'
    | 'session_attachment_composer'
    | 'session_attachment_review_comment_composer'
    | 'session_review_comment_composer'
    | 'plan_output_adopt'
    | 'review_findings_apply'
    | 'participant_composer'
    | 'message_option'
    | 'pending_message_steer_now'
    | 'pending_message_send_now'
    | 'subagent_control'
    | 'voice_turn'
    | 'voice_spawn_first_turn'
    | 'sync_submit_message';

export type SubmitSessionUserMessageOptions = Readonly<{
    sessionId: string;
    session: Session;
    text: string;
    displayText?: string;
    metaOverrides?: Record<string, unknown>;
    configuredMode: MessageSendMode;
    busySteerSendPolicy?: BusySteerSendPolicy;
    /** How ordinary input may resume an inactive/offline runtime. */
    sessionInactiveResumePolicy?: SessionInactiveResumePolicy;
    /** `sessionPermissionModeApplyTiming` setting for the payload-aware steer gate (lane P). */
    permissionModeApplyTiming?: 'immediate' | 'next_prompt';
    /** `sessionNonSteerableSendPrompt` setting; `off` restores the legacy silent behavior. */
    nonSteerableSendPrompt?: NonSteerableSendPromptSetting;
    /** Provider-owned classifier output for outgoing config metadata that cannot be steered. */
    providerNonSteerablePayloadReason?: Extract<NonSteerablePayloadReason, 'provider_config_change_refused'> | null;
    explicitMode?: MessageSendMode;
    forceImmediate?: boolean;
    /** Action already chosen by the caller for an existing durable Pending row. */
    requestedAction?: PendingRequestedActionV1;
    /** Lane Q: explicit user choice — apply the message's config delta in-turn and steer. */
    applyConfigAndSteer?: boolean;
    /**
     * Lane X (X3 Case B): explicit user choice — steer the TEXT only; the caller sends this
     * message with the published current mode and the desired setting applies on the next message.
     */
    steerWithoutConfig?: boolean;
    profileId?: string | null;
    localId?: string | null;
    existingDurablePendingMessage?: boolean;
    /** Persist through the canonical pending owner before publishing a runtime wake. */
    resumeCapabilityOptions: ResumeCapabilityOptions;
    resumeTargetOverride?: SessionSubmitWakeTargetOverride | null;
    permissionOverride?: PermissionModeOverrideForSpawn | null;
    serverId?: string | null;
    requestRemoteControlAfterPendingEnqueue?: boolean;
    onOutboundHandoff?: (handoff: SubmitSessionOutboundHandoff) => void;
    callerSurface?: SessionMessageCallerSurface | null;
    nowMs?: number;
}>;

export type PendingMessageSubmitResult = Readonly<{
    localId?: string;
    accepted?: boolean;
    /** The row was durably cancelled while its enqueue operation was in flight. */
    cancelled?: true;
    /** The server reports that this row was already resolved during the enqueue ACK. */
    terminal?: true;
}> | void;

export type DirectMessageSubmitResult = Readonly<{
    localId?: string;
    seq?: number;
    persistence?: Extract<SubmitPersistence, 'pending' | 'transcript_committed' | 'provider_direct'>;
    providerAcceptancePending?: boolean;
}> | void;

export type SessionMessageLocalPendingProjection = Readonly<{
    localId: string;
}>;

export type DirectMessageLocalPendingProjection = SessionMessageLocalPendingProjection;

export type DirectMessageBypassReason = SessionMessageDirectBypassReason;

export interface SessionSubmitPort {
    enqueuePendingMessage(
        sessionId: string,
        text: string,
        displayText?: string,
        metaOverrides?: Record<string, unknown>,
        options?: Readonly<{
            localId?: string | null;
            onLocalPendingProjectionCreated?: (event: SessionMessageLocalPendingProjection) => void;
            requestedAction: PendingRequestedActionV1;
        }>,
    ): Promise<PendingMessageSubmitResult>;
    sendMessage(
        sessionId: string,
        text: string,
        displayText?: string,
        metaOverrides?: Record<string, unknown>,
        options?: Readonly<{
            profileId?: string | null;
            localId?: string | null;
            bypassPendingQueueReason?: DirectMessageBypassReason;
            onLocalPendingProjectionCreated?: (event: DirectMessageLocalPendingProjection) => void;
        }>,
    ): Promise<DirectMessageSubmitResult>;
    ensureSessionRuntimeForPendingInput(options: ResumeSessionOptions): Promise<ResumeSessionResult>;
    shouldDelegatePendingActivationToDaemon?(session: Session, serverId?: string | null, machineId?: string | null): Promise<boolean>;
    /** Current reachability of the exact resume target; used only for a user-present one-shot attempt. */
    isMachineReachable?(machineId: string): boolean;
    refreshSessionForSubmit?(
        sessionId: string,
        options?: Readonly<{ serverId?: string | null }>,
    ): Promise<Session | null | undefined>;
    abortSession?(sessionId: string): Promise<void>;
    /** Change the action on a still-unclaimed durable Pending row. */
    updatePendingRequestedAction?(
        sessionId: string,
        localId: string,
        requestedAction: PendingRequestedActionV1,
    ): Promise<void> | void;
    switchSessionControlToRemote?(sessionId: string): Promise<void>;
    canWakeMachineId?(machineId: string): boolean;
}
