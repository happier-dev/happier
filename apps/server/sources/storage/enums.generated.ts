// AUTO-GENERATED FILE - DO NOT EDIT.
// Source: prisma/schema.prisma
// Regenerate: yarn schema:sync

export const HomeRole = {
    owner: "owner",
    admin: "admin",
    member: "member",
} as const;

export type HomeRole = (typeof HomeRole)[keyof typeof HomeRole];

export const AccountStatus = {
    active: "active",
    suspended: "suspended",
    disabled: "disabled",
} as const;

export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const TeamCreationPolicy = {
    self_service: "self_service",
    managed_only: "managed_only",
    disabled: "disabled",
} as const;

export type TeamCreationPolicy = (typeof TeamCreationPolicy)[keyof typeof TeamCreationPolicy];

export const TeamRole = {
    owner: "owner",
    admin: "admin",
    member: "member",
    guest: "guest",
} as const;

export type TeamRole = (typeof TeamRole)[keyof typeof TeamRole];

export const TeamMembershipStatus = {
    active: "active",
    suspended: "suspended",
} as const;

export type TeamMembershipStatus = (typeof TeamMembershipStatus)[keyof typeof TeamMembershipStatus];

export const TeamSessionCreationPolicy = {
    private_default: "private_default",
    team_default: "team_default",
    team_required: "team_required",
} as const;

export type TeamSessionCreationPolicy = (typeof TeamSessionCreationPolicy)[keyof typeof TeamSessionCreationPolicy];

export const TeamExternalSharingPolicy = {
    allowed: "allowed",
    team_admins_only: "team_admins_only",
    disabled: "disabled",
} as const;

export type TeamExternalSharingPolicy = (typeof TeamExternalSharingPolicy)[keyof typeof TeamExternalSharingPolicy];

export const SessionHistoryAccess = {
    all_existing: "all_existing",
    from_membership: "from_membership",
} as const;

export type SessionHistoryAccess = (typeof SessionHistoryAccess)[keyof typeof SessionHistoryAccess];

export const TeamAdmissionMode = {
    invite_only: "invite_only",
    provisioned: "provisioned",
    jit: "jit",
} as const;

export type TeamAdmissionMode = (typeof TeamAdmissionMode)[keyof typeof TeamAdmissionMode];

export const IdentityProviderKind = {
    oidc: "oidc",
    workos_sso: "workos_sso",
    github_app_identity: "github_app_identity",
} as const;

export type IdentityProviderKind = (typeof IdentityProviderKind)[keyof typeof IdentityProviderKind];

export const TeamDirectorySourceKind = {
    workos_directory: "workos_directory",
    github_organization: "github_organization",
} as const;

export type TeamDirectorySourceKind = (typeof TeamDirectorySourceKind)[keyof typeof TeamDirectorySourceKind];

export const TeamDirectorySourceState = {
    initializing: "initializing",
    active: "active",
    paused: "paused",
    needs_attention: "needs_attention",
} as const;

export type TeamDirectorySourceState = (typeof TeamDirectorySourceState)[keyof typeof TeamDirectorySourceState];

export const TeamProvisionedIdentityState = {
    active: "active",
    suspended: "suspended",
    deleted: "deleted",
} as const;

export type TeamProvisionedIdentityState = (typeof TeamProvisionedIdentityState)[keyof typeof TeamProvisionedIdentityState];

export const TeamDirectoryGroupState = {
    active: "active",
    deleted: "deleted",
} as const;

export type TeamDirectoryGroupState = (typeof TeamDirectoryGroupState)[keyof typeof TeamDirectoryGroupState];

export const TeamExternalGroupBindingMode = {
    directory_created: "directory_created",
    native_target: "native_target",
} as const;

export type TeamExternalGroupBindingMode = (typeof TeamExternalGroupBindingMode)[keyof typeof TeamExternalGroupBindingMode];

export const TeamInvitationEmailDeliveryStatus = {
    sent: "sent",
    failed: "failed",
} as const;

export type TeamInvitationEmailDeliveryStatus = (typeof TeamInvitationEmailDeliveryStatus)[keyof typeof TeamInvitationEmailDeliveryStatus];

export const AccountIdentityEligibilityStatus = {
    unknown: "unknown",
    eligible: "eligible",
    ineligible: "ineligible",
} as const;

export type AccountIdentityEligibilityStatus = (typeof AccountIdentityEligibilityStatus)[keyof typeof AccountIdentityEligibilityStatus];

export const SessionFollowNotificationLevel = {
    none: "none",
    important: "important",
    all_messages: "all_messages",
} as const;

export type SessionFollowNotificationLevel = (typeof SessionFollowNotificationLevel)[keyof typeof SessionFollowNotificationLevel];

export const SessionFollowDeliveredTurnStatus = {
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
} as const;

export type SessionFollowDeliveredTurnStatus = (typeof SessionFollowDeliveredTurnStatus)[keyof typeof SessionFollowDeliveredTurnStatus];

export const SessionFollowMode = {
    next_turn: "next_turn",
    wake_on_human_change: "wake_on_human_change",
} as const;

export type SessionFollowMode = (typeof SessionFollowMode)[keyof typeof SessionFollowMode];

export const SessionPendingMessageStatus = {
    queued: "queued",
    discarded: "discarded",
} as const;

export type SessionPendingMessageStatus = (typeof SessionPendingMessageStatus)[keyof typeof SessionPendingMessageStatus];

export const PendingProviderAction = {
    send: "send",
    steer: "steer",
    interrupt_and_send: "interrupt_and_send",
} as const;

export type PendingProviderAction = (typeof PendingProviderAction)[keyof typeof PendingProviderAction];

export const MachineKind = {
    persistent: "persistent",
    ephemeral_session_runner: "ephemeral_session_runner",
} as const;

export type MachineKind = (typeof MachineKind)[keyof typeof MachineKind];

export const MachineShareAccessLevel = {
    view: "view",
    admin: "admin",
} as const;

export type MachineShareAccessLevel = (typeof MachineShareAccessLevel)[keyof typeof MachineShareAccessLevel];

export const AutomationScheduleKind = {
    cron: "cron",
    interval: "interval",
    manual: "manual",
} as const;

export type AutomationScheduleKind = (typeof AutomationScheduleKind)[keyof typeof AutomationScheduleKind];

export const AutomationTargetType = {
    new_session: "new_session",
    existing_session: "existing_session",
    execution_run: "execution_run",
} as const;

export type AutomationTargetType = (typeof AutomationTargetType)[keyof typeof AutomationTargetType];

export const AutomationRunState = {
    queued: "queued",
    claimed: "claimed",
    running: "running",
    succeeded: "succeeded",
    failed: "failed",
    cancelled: "cancelled",
    expired: "expired",
    dispatch_failed: "dispatch_failed",
    skipped: "skipped",
    missed: "missed",
    outcome_uncertain: "outcome_uncertain",
    pause_requested: "pause_requested",
    paused: "paused",
    interrupted: "interrupted",
    waiting_for_review: "waiting_for_review",
} as const;

export type AutomationRunState = (typeof AutomationRunState)[keyof typeof AutomationRunState];

export const WorkflowRunCustodyState = {
    pending: "pending",
    settled: "settled",
} as const;

export type WorkflowRunCustodyState = (typeof WorkflowRunCustodyState)[keyof typeof WorkflowRunCustodyState];

export const WorkflowInvocationLifecycle = {
    pending: "pending",
    waiting_for_capacity: "waiting_for_capacity",
    admitting: "admitting",
    running: "running",
    waiting_for_approval: "waiting_for_approval",
    waiting_for_review: "waiting_for_review",
    needs_attention: "needs_attention",
    completed: "completed",
    failed: "failed",
    skipped: "skipped",
    cancel_requested: "cancel_requested",
    cancelled: "cancelled",
    outcome_uncertain: "outcome_uncertain",
    superseded: "superseded",
} as const;

export type WorkflowInvocationLifecycle = (typeof WorkflowInvocationLifecycle)[keyof typeof WorkflowInvocationLifecycle];

export const AutomationTriggerKind = {
    schedule: "schedule",
    pluginEvent: "pluginEvent",
    sessionLifecycle: "sessionLifecycle",
    runLifecycle: "runLifecycle",
    prComment: "prComment",
    ciFailed: "ciFailed",
} as const;

export type AutomationTriggerKind = (typeof AutomationTriggerKind)[keyof typeof AutomationTriggerKind];

export const AutomationSessionLifecycleEvent = {
    parentTurnCompleted: "parentTurnCompleted",
    parentTurnFailed: "parentTurnFailed",
    parentTurnCancelled: "parentTurnCancelled",
    userActionRequired: "userActionRequired",
    sessionStarted: "sessionStarted",
    sessionArchived: "sessionArchived",
} as const;

export type AutomationSessionLifecycleEvent = (typeof AutomationSessionLifecycleEvent)[keyof typeof AutomationSessionLifecycleEvent];

export const AutomationSessionLifecyclePolicyKind = {
    currentTurn: "currentTurn",
    firstMatch: "firstMatch",
    nextMatches: "nextMatches",
    everyMatch: "everyMatch",
} as const;

export type AutomationSessionLifecyclePolicyKind = (typeof AutomationSessionLifecyclePolicyKind)[keyof typeof AutomationSessionLifecyclePolicyKind];

export const AutomationSessionLifecycleRequestKind = {
    permission: "permission",
    user_action: "user_action",
} as const;

export type AutomationSessionLifecycleRequestKind = (typeof AutomationSessionLifecycleRequestKind)[keyof typeof AutomationSessionLifecycleRequestKind];

export const AutomationObservationTransport = {
    checkpointedPull: "checkpointedPull",
    durablePush: "durablePush",
    socket: "socket",
} as const;

export type AutomationObservationTransport = (typeof AutomationObservationTransport)[keyof typeof AutomationObservationTransport];

export const AutomationRunCauseKind = {
    trigger: "trigger",
    manual: "manual",
    conversation: "conversation",
} as const;

export type AutomationRunCauseKind = (typeof AutomationRunCauseKind)[keyof typeof AutomationRunCauseKind];

export const AutomationExecutionDispatchState = {
    notStarted: "notStarted",
    dispatchPermitted: "dispatchPermitted",
    retryWaiting: "retryWaiting",
    started: "started",
    settled: "settled",
    outcomeUnknown: "outcomeUnknown",
} as const;

export type AutomationExecutionDispatchState = (typeof AutomationExecutionDispatchState)[keyof typeof AutomationExecutionDispatchState];

export const AutomationRunReplyHandoffState = {
    none: "none",
    awaitingResult: "awaitingResult",
    ready: "ready",
    handingOff: "handingOff",
    accepted: "accepted",
    suppressed: "suppressed",
    blocked: "blocked",
} as const;

export type AutomationRunReplyHandoffState = (typeof AutomationRunReplyHandoffState)[keyof typeof AutomationRunReplyHandoffState];

export const AutomationEventSourceStatusState = {
    uninitialized: "uninitialized",
    baselined: "baselined",
    observing: "observing",
    backingOff: "backingOff",
    attention: "attention",
} as const;

export type AutomationEventSourceStatusState = (typeof AutomationEventSourceStatusState)[keyof typeof AutomationEventSourceStatusState];

export const AutomationEventSourceCatalogStatusState = {
    current: "current",
    reconciling: "reconciling",
    reconciliationLate: "reconciliationLate",
} as const;

export type AutomationEventSourceCatalogStatusState = (typeof AutomationEventSourceCatalogStatusState)[keyof typeof AutomationEventSourceCatalogStatusState];

export const RelationshipStatus = {
    none: "none",
    requested: "requested",
    pending: "pending",
    friend: "friend",
    rejected: "rejected",
} as const;

export type RelationshipStatus = (typeof RelationshipStatus)[keyof typeof RelationshipStatus];

export const ShareAccessLevel = {
    view: "view",
    edit: "edit",
    admin: "admin",
} as const;

export type ShareAccessLevel = (typeof ShareAccessLevel)[keyof typeof ShareAccessLevel];
