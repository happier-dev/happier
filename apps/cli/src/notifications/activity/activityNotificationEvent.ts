import type { WorkflowRunUpdateNotificationV1 } from '@happier-dev/protocol';
import type { ConnectedServiceUsageNotificationV1 } from '@happier-dev/protocol/activity/webhookPayload';

export type ActivityNotificationEvent =
  | ConnectedServiceUsageNotificationV1
  | WorkflowRunUpdateNotificationV1
  | Readonly<{
    topic: 'notify_me';
    message: string;
    title?: string;
    open?: Readonly<{ kind: 'session'; sessionId: string }> | Readonly<{ kind: 'workflow_run'; runId: string }>;
    actionRequestId?: string;
  }>
  | Readonly<{
    topic: 'ready';
    sessionId: string;
    sessionTitle?: string | null;
    waitingForCommandLabel: string;
    assistantPreviewText?: string | null;
    committedLocalId?: string;
    committedSequence?: number;
  }>
  | Readonly<{
    topic: 'permission_request' | 'user_action_request';
    sessionId: string;
    sessionTitle?: string | null;
    agentDisplayName?: string | null;
    requestId: string;
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
  | (Readonly<{
    topic: 'connected_service_quota_blocked';
    sessionId: string;
  }> | Readonly<{
    topic: 'connected_service_quota_recovered';
    sessionId?: string;
    recoveryReason?: 'automatic_quota_reset';
  }>) & Readonly<{
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
