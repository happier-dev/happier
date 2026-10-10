import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { PermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import type {
    BusySteerSendPolicy,
    MessageSendMode,
    SessionMessageDirectBypassReason,
} from '@/sync/domains/session/control/submitMode';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { CurrentSessionRunnerProcessIdentity } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import type { ResumeSessionOptions, PendingInputRuntimeEnsureResult } from '@/sync/ops/sessions';
import type {
    PendingRequestedActionV1,
    ParticipantRecipientV1,
    ProviderBoundModelRef,
    SessionPermissionMode,
    SessionInactiveResumePolicy,
    SessionInputAdmissionRejectionCodeV1,
} from '@happier-dev/protocol';

export const SESSION_INPUT_TARGET_UPDATE_REQUIRED_ERROR_CODE =
    'session_input_target_update_required' satisfies SessionInputAdmissionRejectionCodeV1;
export const SESSION_INPUT_ACCOUNT_SCOPE_RETIRED_ERROR_CODE = 'session_account_scope_retired';

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
    | 'pending'
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
    | 'scm_conflict_resolution'
    | 'review_findings_apply'
    | 'review_comments_delegate'
    | 'participant_composer'
    | 'message_option'
    | 'voice_turn'
    | 'subagent_command'
    | 'pending_message_steer_now'
    | 'pending_message_send_now'
    | 'sync_submit_message';

/**
 * Trusted in-process admission selector. This never crosses Action/plugin JSON
 * or a server wire shape; the canonical Message record builder consumes it.
 */
export type SessionMessageHostAdmissionOrigin = 'voice';

export type SubmitSessionUserMessageOptions = Readonly<{
    sessionId: string;
    recipient?: ParticipantRecipientV1;
    session: Session;
    text: string;
    displayText?: string;
    metaOverrides?: Record<string, unknown>;
    configuredMode: MessageSendMode;
    busySteerSendPolicy?: BusySteerSendPolicy;
    /** How ordinary input may resume an inactive/offline runtime. */
    sessionInactiveResumePolicy?: SessionInactiveResumePolicy;
    explicitMode?: MessageSendMode;
    forceImmediate?: boolean;
    /** Action explicitly selected for an already-durable row. */
    requestedAction?: PendingRequestedActionV1;
    profileId?: string | null;
    localId?: string | null;
    existingDurablePendingMessage?: boolean;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    resumeTargetOverride?: SessionSubmitWakeTargetOverride | null;
    permissionOverride?: PermissionModeOverrideForSpawn | null;
    serverId?: string | null;
    /** Exact route credential lifetime; authoritative for every asynchronous admission effect. */
    accountLifetime?: ServerAccountScopeLifetime;
    requestRemoteControlAfterPendingEnqueue?: boolean;
    onOutboundHandoff?: (handoff: SubmitSessionOutboundHandoff) => void;
    callerSurface?: SessionMessageCallerSurface | null;
    hostAdmissionOrigin?: SessionMessageHostAdmissionOrigin;
    /**
     * The models this sender may run (an embed's grant, a narrowing presentation): a message on
     * Automatic or a refused model runs on the first allowed one. `null`/absent: any model.
     */
    allowedModels?: readonly ProviderBoundModelRef[] | null;
    allowedPermissionModes?: readonly SessionPermissionMode[] | null;
    nowMs?: number;
    agentTargetKey?: string | null;
    currentRunnerProcessIdentity?: CurrentSessionRunnerProcessIdentity | null;
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
    accepted?: boolean;
    /** The exact row was durably cancelled while its enqueue operation was in flight. */
    cancelled?: true;
    terminal?: true;
}> | void;

export type DirectMessageSubmitResult = Readonly<{
    localId?: string;
    seq?: number;
    persistence?: Extract<SubmitPersistence, 'pending' | 'transcript_committed' | 'provider_direct'>;
    providerAcceptancePending?: boolean;
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
        options?: Readonly<{
            localId?: string | null;
            serverId?: string | null;
            accountLifetime?: ServerAccountScopeLifetime;
            recipient?: ParticipantRecipientV1;
            hostAdmissionOrigin?: SessionMessageHostAdmissionOrigin;
            onLocalPendingProjectionCreated?: (event: DirectMessageLocalPendingProjection) => void;
            requestedAction: PendingRequestedActionV1;
            resumeWhenAvailable?: true;
            allowedModels?: readonly ProviderBoundModelRef[] | null;
            allowedPermissionModes?: readonly SessionPermissionMode[] | null;
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
            serverId?: string | null;
            accountLifetime?: ServerAccountScopeLifetime;
            session?: Session;
            hostAdmissionOrigin?: SessionMessageHostAdmissionOrigin;
            bypassPendingQueueReason?: DirectMessageBypassReason;
            onLocalPendingProjectionCreated?: (event: DirectMessageLocalPendingProjection) => void;
            allowedModels?: readonly ProviderBoundModelRef[] | null;
            allowedPermissionModes?: readonly SessionPermissionMode[] | null;
        }>,
    ): Promise<DirectMessageSubmitResult>;
    ensureSessionRuntimeForPendingInput(options: ResumeSessionOptions): Promise<PendingInputRuntimeEnsureResult>;
    shouldDelegatePendingActivationToDaemon?(
        session: Session,
        serverId?: string | null,
        machineId?: string | null,
    ): Promise<boolean>;
    /** Current reachability of the exact resume target; used only for a user-present one-shot attempt. */
    isMachineReachable?(machineId: string): boolean;
    refreshSessionForSubmit?(
        sessionId: string,
        options?: Readonly<{
            serverId?: string | null;
            accountLifetime?: ServerAccountScopeLifetime;
        }>,
    ): Promise<Session | null | undefined>;
    abortSession?(sessionId: string): Promise<void>;
    updatePendingRequestedAction?(
        sessionId: string,
        localId: string,
        requestedAction: PendingRequestedActionV1,
        options?: Readonly<{
            resumeWhenAvailable?: boolean;
            serverId?: string | null;
            accountLifetime?: ServerAccountScopeLifetime;
        }>,
    ): Promise<void> | void;
    switchSessionControlToRemote?(
        sessionId: string,
        options?: Readonly<{
            serverId?: string | null;
            accountLifetime?: ServerAccountScopeLifetime;
        }>,
    ): Promise<void>;
    canWakeMachineId?(machineId: string): boolean;
    /**
     * Source-owned routing fact for the current active server. Host admission
     * uses it only to prevent an incompatible remote target from taking the
     * active-socket direct fallback.
     */
    isSessionTargetRemoteToActiveServer(sessionId: string): boolean;
}
