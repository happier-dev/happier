import { buildAgentRequestNotificationContent } from '@happier-dev/protocol/activity/agentRequestNotificationContent';
import { buildReadyNotificationContent } from '@happier-dev/protocol/push/readyNotificationContent';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { WorkflowRunUpdateNotificationV1Schema } from '@happier-dev/protocol/activity/webhookPayload';
import type { AttentionPreviewBehavior } from '@happier-dev/protocol';

import type { ActivityNotificationEvent } from './activityNotificationEvent';

const RAW_JSON_SECRET_KEY_PATTERN =
  /("(?:access_token|refresh_token|id_token|client_secret|api_key|authorization|openai_api_key|anthropic_api_key)"\s*:\s*")([^"]*)(")/giu;
const OAUTH_PROVIDER_ERROR_CODE_PATTERN =
  /\b(invalid_grant|invalid_client|invalid_request|unauthorized_client|unsupported_grant_type|invalid_scope|temporarily_unavailable)\b/iu;
const MODULE_RESOLUTION_PATTERN =
  /\b(?:Cannot find module|MODULE_NOT_FOUND|Require stack|node_modules|ERR_MODULE_NOT_FOUND)\b/u;

function redactNotificationText(value: string): string {
  return redactBugReportSensitiveText(value.replace(RAW_JSON_SECRET_KEY_PATTERN, '$1[redacted]$3'));
}

function readSafeOauthProviderErrorCode(value: string): string | null {
  const match = value.match(OAUTH_PROVIDER_ERROR_CODE_PATTERN);
  return match?.[1]?.toLowerCase() ?? null;
}

function sanitizeProviderDiagnostic(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const safeCode = readSafeOauthProviderErrorCode(trimmed);
  if (safeCode) return safeCode;
  if (MODULE_RESOLUTION_PATTERN.test(trimmed)) return 'provider_runtime_error';
  const redacted = redactNotificationText(trimmed).trim();
  if (!redacted) return null;
  if (MODULE_RESOLUTION_PATTERN.test(redacted)) return 'provider_runtime_error';
  return redacted;
}

type NotificationOpenUrlAction = Readonly<{ kind: 'open_url'; url: string }>;

function sanitizeNotificationAction(
  value: NotificationOpenUrlAction | null | undefined,
): NotificationOpenUrlAction | null {
  if (!value || value.kind !== 'open_url') return null;
  const trimmed = value.url.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    url.search = '';
    url.hash = '';
    return { kind: 'open_url', url: url.toString() };
  } catch {
    const redacted = redactNotificationText(trimmed).trim();
    return redacted ? { kind: 'open_url', url: redacted } : null;
  }
}

function resolveDisplayText(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return normalized ? normalized : null;
}

function resolveConnectedServiceDisplayName(serviceId: string, explicit?: string | null): string {
  const normalizedExplicit = resolveDisplayText(explicit);
  if (normalizedExplicit) return normalizedExplicit;
  return resolveDisplayText(serviceId) ?? 'Provider';
}

function buildSwitchReasonSentence(reason: string, serviceDisplayName: string): string {
  if (reason === 'soft_threshold') {
    return `Happier switched ${serviceDisplayName} accounts preventively because the previous account was near the configured soft limit.`;
  }
  if (reason === 'usage_limit' || reason === 'rate_limit') {
    return `The provider reported a usage or quota issue, so Happier switched ${serviceDisplayName} accounts.`;
  }
  if (reason === 'auth_invalid' || reason === 'auth_expired' || reason === 'refresh_failure' || reason === 'refresh_failed') {
    return `The ${serviceDisplayName} credential stopped working, so Happier switched accounts.`;
  }
  if (reason === 'manual') {
    return `The session ${serviceDisplayName} account changed.`;
  }
  return `Happier switched ${serviceDisplayName} accounts.`;
}

export function buildActivityNotificationContent(
  event: ActivityNotificationEvent,
  options: Readonly<{
    readyIncludeMessageText: boolean;
    requestIncludeMessageText?: boolean;
    previewBehavior?: AttentionPreviewBehavior;
  }>,
): Readonly<{
  title: string;
  body: string;
  data: Record<string, unknown>;
  toolDetails?: string | null;
}> {
  const sessionTitle = options.previewBehavior === 'status_only' || !('sessionTitle' in event)
    ? null
    : event.sessionTitle;
  const includePreview = options.previewBehavior === undefined || options.previewBehavior === 'include_preview';
  if (event.topic === 'notify_me') {
    return {
      title: options.previewBehavior === 'status_only' ? 'You have a new notification' : event.title ?? 'Workflow update',
      body: includePreview ? event.message : '',
      data: {
        topic: event.topic,
        ...(event.open?.kind === 'session' ? { sessionId: event.open.sessionId } : {}),
        ...(event.open?.kind === 'workflow_run' ? { runId: event.open.runId } : {}),
      },
    };
  }
  if (event.topic === 'workflow_run_update') {
    const workflowEvent = WorkflowRunUpdateNotificationV1Schema.parse(event);
    const presentation = workflowEvent.updateKind === 'completed'
      ? { title: 'Workflow completed', body: 'A workflow Run completed.' }
      : workflowEvent.updateKind === 'completed_with_failures'
        ? { title: 'Workflow completed with failures', body: 'A workflow Run completed with failures.' }
        : workflowEvent.updateKind === 'review_required'
          ? { title: 'A workflow needs you', body: "Open it to see what's waiting for you." }
        : workflowEvent.updateKind === 'failed'
          ? { title: 'Workflow failed', body: 'A workflow Run failed.' }
          : workflowEvent.updateKind === 'paused'
            ? { title: 'Workflow paused', body: 'A workflow Run paused at its saved boundary.' }
            : workflowEvent.updateKind === 'interrupted'
              ? { title: 'Workflow needs attention', body: 'A workflow Run was interrupted and needs attention.' }
              : { title: 'Workflow outcome uncertain', body: 'A workflow Run needs attention because its outcome is uncertain.' };
    return {
      ...presentation,
      data: {
        topic: workflowEvent.topic,
        runId: workflowEvent.runId,
        updateKind: workflowEvent.updateKind,
        ...(workflowEvent.reason ? { reason: workflowEvent.reason } : {}),
      },
    };
  }

  if (event.topic === 'ready') {
    // Producers may use the private Session title as their waiting label.
    const waitingForCommandLabel = options.previewBehavior === 'status_only' ? 'Session' : event.waitingForCommandLabel;
    const content = buildReadyNotificationContent({
      sessionTitle,
      defaultTitle: waitingForCommandLabel,
      waitingForCommandLabel,
      fallbackBody: `${waitingForCommandLabel} is waiting for your command`,
      includeMessageText: includePreview && options.readyIncludeMessageText,
      messageText: event.assistantPreviewText,
    });
    return {
      title: content.title,
      body: content.body,
      data: {
        sessionId: event.sessionId,
        ...(event.committedLocalId ? { activityEventLocalId: event.committedLocalId } : {}),
        ...(event.committedSequence ? {
          activityEvent: { type: 'ready', sequenceDomain: 'session_transcript', messageSeq: event.committedSequence },
        } : {}),
      },
    };
  }

  if (event.topic === 'connected_service_account_switch') {
    if (!includePreview) {
      return {
        title: sessionTitle ?? 'Provider account switched',
        body: 'Happier switched provider accounts.',
        data: {
          topic: event.topic,
          sessionId: event.sessionId,
          serviceId: event.serviceId,
          groupId: event.groupId,
          fromProfileId: event.fromProfileId,
          toProfileId: event.toProfileId,
        },
      };
    }
    const serviceDisplayName = resolveConnectedServiceDisplayName(event.serviceId, event.serviceDisplayName);
    const fromProfile = typeof event.fromProfileLabel === 'string' && event.fromProfileLabel.trim()
      ? event.fromProfileLabel.trim()
      : event.fromProfileId;
    const toProfile = typeof event.toProfileLabel === 'string' && event.toProfileLabel.trim()
      ? event.toProfileLabel.trim()
      : event.toProfileId;
    const accountClause = fromProfile && toProfile
      ? ` from ${fromProfile} to ${toProfile}`
      : toProfile
      ? ` to ${toProfile}`
      : '';
    const usageParts = [
      typeof event.fromUsagePercent === 'number' && Number.isFinite(event.fromUsagePercent)
        ? `${Math.round(event.fromUsagePercent)}% used`
        : null,
      typeof event.toUsagePercent === 'number' && Number.isFinite(event.toUsagePercent)
        ? `${Math.round(event.toUsagePercent)}% used`
        : null,
    ].filter((part): part is string => part !== null);
    const usageClause = usageParts.length === 2
      ? ` (${usageParts[0]} -> ${usageParts[1]})`
      : usageParts.length === 1
      ? ` (${usageParts[0]})`
      : '';
    const reasonSentence = buildSwitchReasonSentence(event.reason, serviceDisplayName);
    return {
      title: sessionTitle ?? `${serviceDisplayName} account switched`,
      body: `${reasonSentence}${accountClause ? ` Account changed${accountClause}${usageClause}.` : ''}`,
      data: {
        topic: event.topic,
        sessionId: event.sessionId,
        serviceId: event.serviceId,
        serviceDisplayName,
        groupId: event.groupId,
        fromProfileId: event.fromProfileId,
        toProfileId: event.toProfileId,
        fromProfileLabel: event.fromProfileLabel ?? null,
        toProfileLabel: event.toProfileLabel ?? null,
        fromUsagePercent: event.fromUsagePercent ?? null,
        toUsagePercent: event.toUsagePercent ?? null,
        reason: event.reason,
        limitCategory: event.limitCategory ?? null,
        retryAfterMs: event.retryAfterMs ?? null,
        quotaScope: event.quotaScope ?? null,
        providerLimitId: event.providerLimitId ?? null,
        action: event.action ?? null,
      },
    };
  }

  if (event.topic === 'connected_service_quota_blocked' || event.topic === 'connected_service_quota_recovered') {
    const automaticReset = event.topic === 'connected_service_quota_recovered' && event.recoveryReason === 'automatic_quota_reset';
    if (!includePreview) {
      const recovered = event.topic === 'connected_service_quota_recovered';
      return {
        title: sessionTitle ?? (automaticReset ? 'Provider reset credit used' : recovered ? 'Provider quota recovered' : 'Provider quota blocked'),
        body: automaticReset ? 'Happier automatically used a reset credit.' : recovered ? 'Provider quota is available again.' : 'Waiting for provider quota availability.',
        data: {
          topic: event.topic,
          ...(automaticReset ? { recoveryReason: 'automatic_quota_reset' } : {}),
          sessionId: event.sessionId,
          serviceId: event.serviceId,
          issueFingerprint: event.issueFingerprint,
          groupId: event.groupId ?? null,
          profileId: event.profileId ?? null,
        },
      };
    }
    const serviceDisplayName = resolveConnectedServiceDisplayName(event.serviceId, event.serviceDisplayName);
    const resetAccount = redactNotificationText(event.profileId ?? 'selected account');
    const resetPool = redactNotificationText(event.groupId ?? 'account pool');
    return {
      title: automaticReset ? `${serviceDisplayName} reset credit used` : sessionTitle ?? (event.topic === 'connected_service_quota_recovered' ? `${serviceDisplayName} quota recovered` : `${serviceDisplayName} quota blocked`),
      body: automaticReset ? `Happier automatically used a reset credit for ${resetAccount} in pool ${resetPool}.` : event.topic === 'connected_service_quota_recovered'
        ? `Quota is available again for ${serviceDisplayName}.`
        : `Waiting for quota availability for ${serviceDisplayName}.`,
      data: {
        topic: event.topic,
        ...(automaticReset ? { recoveryReason: 'automatic_quota_reset' } : {}),
        sessionId: event.sessionId,
        serviceId: event.serviceId,
        serviceDisplayName,
        issueFingerprint: event.issueFingerprint,
        groupId: event.groupId ?? null,
        profileId: event.profileId ?? null,
        nativeAuth: event.nativeAuth ?? null,
        limitCategory: event.limitCategory ?? null,
        retryAfterMs: event.retryAfterMs ?? null,
        quotaScope: event.quotaScope ?? null,
        providerLimitId: event.providerLimitId ?? null,
        action: event.action ?? null,
      },
    };
  }

  if (event.topic === 'connected_service_credential_health') {
    if (!includePreview) {
      const reconnectRequired = event.status === 'reconnect_required';
      return {
        title: sessionTitle ?? (reconnectRequired ? 'Provider account needs reconnect' : 'Provider account refresh failed'),
        body: reconnectRequired ? 'A provider account needs to be reconnected.' : 'A provider account could not be refreshed. Happier will retry automatically.',
        data: {
          topic: event.topic,
          sessionId: event.sessionId,
          serviceId: event.serviceId,
          profileId: event.profileId,
          status: event.status,
        },
      };
    }
    const serviceDisplayName = resolveConnectedServiceDisplayName(event.serviceId, event.serviceDisplayName);
    const profileLabel = typeof event.profileLabel === 'string' && event.profileLabel.trim()
      ? event.profileLabel.trim()
      : event.profileId;
    const safeReason = sanitizeProviderDiagnostic(event.providerErrorCode)
      ?? sanitizeProviderDiagnostic(event.reason);
    const safeAction = sanitizeNotificationAction(event.action);
    const reasonClause = safeReason ? ` Provider code: ${safeReason}.` : '';
    const body = event.status === 'reconnect_required'
      ? `${serviceDisplayName} account ${profileLabel} needs to be reconnected before Happier can use it again.${reasonClause}`
      : `${serviceDisplayName} account ${profileLabel} could not be refreshed. Happier will retry automatically.${reasonClause}`;
    return {
      title: sessionTitle ?? (event.status === 'reconnect_required' ? `${serviceDisplayName} account needs reconnect` : `${serviceDisplayName} account refresh failed`),
      body,
      data: {
        topic: event.topic,
        sessionId: event.sessionId,
        serviceId: event.serviceId,
        serviceDisplayName,
        profileId: event.profileId,
        profileLabel: event.profileLabel ?? null,
        status: event.status,
        reason: sanitizeProviderDiagnostic(event.reason),
        providerStatus: event.providerStatus ?? null,
        providerErrorCode: sanitizeProviderDiagnostic(event.providerErrorCode),
        action: safeAction,
      },
    };
  }

  if (event.topic === 'permission_request' || event.topic === 'user_action_request') {
    const kind = event.topic === 'user_action_request' ? 'user_action' : 'permission';
    const built = buildAgentRequestNotificationContent({
      kind,
      sessionId: event.sessionId,
      sessionTitle,
      agentDisplayName: event.agentDisplayName,
      requestId: event.requestId,
      toolName: event.toolName,
      toolInput: event.toolInput,
      includeMessageText: includePreview && options.requestIncludeMessageText !== false,
      toolDetails: event.toolDetails,
    });
    return {
      title: built.title,
      body: built.body,
      data: built.data,
      toolDetails: built.toolDetails,
    };
  }

  return {
    title: sessionTitle ?? 'Activity update',
    body: 'Session activity changed.',
    data: {
      topic: event.topic,
      sessionId: event.sessionId,
    },
  };
}
