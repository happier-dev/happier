export type ActivityNotificationEvent =
  | Readonly<{
    topic: 'ready';
    sessionId: string;
    sessionTitle?: string | null;
    waitingForCommandLabel: string;
    assistantPreviewText?: string | null;
  }>
  | Readonly<{
    topic: 'permission_request';
    sessionId: string;
    sessionTitle?: string | null;
    agentDisplayName?: string | null;
    requestId: string;
    occurrenceId?: string;
    toolName: string;
    toolInput?: unknown;
    toolDetails?: string | null;
  }>
  | Readonly<{
    topic: 'user_action_request';
    sessionId: string;
    sessionTitle?: string | null;
    agentDisplayName?: string | null;
    requestId: string;
    occurrenceId?: string;
    toolName: string;
    toolInput?: unknown;
    toolDetails?: string | null;
  }>
  | Readonly<{
    topic: 'connected_service_account_switch';
    sessionId: string;
    sessionTitle?: string | null;
    serviceId: string;
    serviceDisplayName?: string | null;
    groupId: string;
    fromProfileId: string | null;
    toProfileId: string | null;
    fromProfileLabel?: string | null;
    toProfileLabel?: string | null;
    fromUsagePercent?: number | null;
    toUsagePercent?: number | null;
    fromUsage?: Readonly<{ label: string | null; remainingPercent: number }> | null;
    toUsage?: Readonly<{ label: string | null; remainingPercent: number }> | null;
    reason: string;
    limitCategory?: string | null;
    retryAfterMs?: number | null;
    quotaScope?: string | null;
    providerLimitId?: string | null;
    action?: Readonly<{ kind: 'open_url'; url: string }> | null;
  }>
  | Readonly<{
    topic: 'connected_service_credential_health';
    sessionId: string;
    sessionTitle?: string | null;
    serviceId: string;
    serviceDisplayName?: string | null;
    profileId: string;
    profileLabel?: string | null;
    status: 'reconnect_required' | 'refresh_failed_retryable';
    reason?: string | null;
    providerStatus?: number | null;
    providerErrorCode?: string | null;
    action?: Readonly<{ kind: 'open_url'; url: string }> | null;
  }>
  | Readonly<{
    topic: 'connected_service_quota_blocked';
    sessionId: string;
    sessionTitle?: string | null;
    serviceId: string;
    serviceDisplayName?: string | null;
    issueFingerprint: string;
    groupId?: string | null;
    profileId?: string | null;
    nativeAuth?: boolean | null;
    limitCategory?: string | null;
    retryAfterMs?: number | null;
    quotaScope?: string | null;
    providerLimitId?: string | null;
    action?: Readonly<{ kind: 'open_url'; url: string }> | null;
  }>
  | Readonly<{
    topic: 'connected_service_quota_recovered';
    sessionId?: string;
    recoveryReason?: 'automatic_quota_reset';
    sessionTitle?: string | null;
    serviceId: string;
    serviceDisplayName?: string | null;
    issueFingerprint: string;
    groupId?: string | null;
    profileId?: string | null;
    nativeAuth?: boolean | null;
    limitCategory?: string | null;
    retryAfterMs?: number | null;
    quotaScope?: string | null;
    providerLimitId?: string | null;
    action?: Readonly<{ kind: 'open_url'; url: string }> | null;
  }>;
