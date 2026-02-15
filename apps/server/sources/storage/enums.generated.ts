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

export const AutomationScheduleKind = {
    cron: "cron",
    interval: "interval",
} as const;

export type AutomationScheduleKind = (typeof AutomationScheduleKind)[keyof typeof AutomationScheduleKind];

export const AutomationTargetType = {
    new_session: "new_session",
    existing_session: "existing_session",
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
} as const;

export type AutomationRunState = (typeof AutomationRunState)[keyof typeof AutomationRunState];

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
