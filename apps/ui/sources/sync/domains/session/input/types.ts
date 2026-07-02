import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { PermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import type {
    BusySteerSendPolicy,
    MessageSendMode,
    SessionMessageDirectBypassReason,
} from '@/sync/domains/session/control/submitMode';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ResumeSessionOptions, ResumeSessionResult } from '@/sync/ops/sessions';

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
    | 'sync_submit_message';

export type SubmitSessionUserMessageOptions = Readonly<{
    sessionId: string;
    session: Session;
    text: string;
    displayText?: string;
    metaOverrides?: Record<string, unknown>;
    configuredMode: MessageSendMode;
    busySteerSendPolicy?: BusySteerSendPolicy;
    explicitMode?: MessageSendMode;
    forceImmediate?: boolean;
    profileId?: string | null;
    localId?: string | null;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    resumeTargetOverride?: SessionSubmitWakeTargetOverride | null;
    permissionOverride?: PermissionModeOverrideForSpawn | null;
    serverId?: string | null;
    requestRemoteControlAfterPendingEnqueue?: boolean;
    onOutboundHandoff?: (handoff: SubmitSessionOutboundHandoff) => void;
    callerSurface?: SessionMessageCallerSurface | null;
    nowMs?: number;
    /** `sessionNonSteerableSendPrompt` setting; `off` restores legacy silent steering (G4). */
    nonSteerableSendPrompt?: 'on' | 'off';
    /** `sessionPermissionModeApplyTiming` setting; `next_prompt` skips the mode-change steer gate. */
    permissionModeApplyTiming?: 'current_turn' | 'next_prompt';
    /**
     * G4 explicit user choice ("Apply setting & steer now"): let the mode-change payload take the
     * steer path because the backend owns the delta in-turn. Only honored when the session
     * publishes `inFlightConfigApplySupported` (fail-closed); never honored for special commands.
     */
    applyConfigAndSteer?: boolean;
    /**
     * G4 explicit user choice ("Steer now without applying"): the TEXT steers the running turn
     * while the setting stays desired-state and applies on the next message. The caller is
     * responsible for sending the message with the published current mode so no delta rides it.
     */
    steerWithoutConfig?: boolean;
}>;

export type PendingMessageSubmitResult = Readonly<{
    localId?: string;
}> | void;

export type DirectMessageSubmitResult = Readonly<{
    localId?: string;
    seq?: number;
}> | void;

export type DirectMessageLocalPendingProjection = Readonly<{
    localId: string;
}>;

export type DirectMessageBypassReason = SessionMessageDirectBypassReason;

export interface SessionSubmitPort {
    enqueuePendingMessage(
        sessionId: string,
        text: string,
        displayText?: string,
        metaOverrides?: Record<string, unknown>,
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
    resumeSession(options: ResumeSessionOptions): Promise<ResumeSessionResult>;
    refreshSessionForSubmit?(
        sessionId: string,
        options?: Readonly<{ serverId?: string | null }>,
    ): Promise<Session | null | undefined>;
    abortSession?(sessionId: string): Promise<void>;
    switchSessionControlToRemote?(sessionId: string): Promise<void>;
    canWakeMachineId?(machineId: string): boolean;
}
