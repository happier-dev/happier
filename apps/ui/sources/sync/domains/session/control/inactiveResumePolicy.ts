export const SESSION_INACTIVE_RESUME_POLICY_VALUES = [
    'when_available',
    'online_only',
    'manual',
] as const;

export type SessionInactiveResumePolicy = typeof SESSION_INACTIVE_RESUME_POLICY_VALUES[number];

export const DEFAULT_SESSION_INACTIVE_RESUME_POLICY: SessionInactiveResumePolicy = 'online_only';
