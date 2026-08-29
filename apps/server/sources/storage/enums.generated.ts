// AUTO-GENERATED FILE - DO NOT EDIT.
// Source: prisma/schema.prisma
// Regenerate: yarn schema:sync

export const AccountIdentityEligibilityStatus = {
    unknown: "unknown",
    eligible: "eligible",
    ineligible: "ineligible",
} as const;

export type AccountIdentityEligibilityStatus = (typeof AccountIdentityEligibilityStatus)[keyof typeof AccountIdentityEligibilityStatus];

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

export const AutomationScheduleKind = {
    cron: "cron",
    interval: "interval",
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
} as const;

export type AutomationRunState = (typeof AutomationRunState)[keyof typeof AutomationRunState];

export const AutomationTriggerKind = {
    schedule: "schedule",
    pluginEvent: "pluginEvent",
    sessionLifecycle: "sessionLifecycle",
} as const;

export type AutomationTriggerKind = (typeof AutomationTriggerKind)[keyof typeof AutomationTriggerKind];

export const AutomationSessionLifecycleEvent = {
    parentTurnCompleted: "parentTurnCompleted",
} as const;

export type AutomationSessionLifecycleEvent = (typeof AutomationSessionLifecycleEvent)[keyof typeof AutomationSessionLifecycleEvent];

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
