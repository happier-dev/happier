import {
  buildAgentRequestNotificationContent,
  buildReadyNotificationContent,
  getConnectedAccountDescriptor,
  redactBugReportSensitiveText,
} from '@happier-dev/protocol';

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

const CONNECTED_SERVICE_PROVIDER_DISPLAY_NAMES_BY_KEY: Readonly<Record<string, string>> = {
  'connectedServices.serviceNames.openaiCodex': 'OpenAI',
  'connectedServices.serviceNames.openai': 'OpenAI',
  'connectedServices.serviceNames.anthropic': 'Claude',
  'connectedServices.serviceNames.claudeSubscription': 'Claude',
  'connectedServices.serviceNames.gemini': 'Gemini',
  'connectedServices.serviceNames.github': 'GitHub',
};

function resolveDisplayText(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return normalized ? normalized : null;
}

function resolveConnectedServiceDisplayName(serviceId: string, explicit?: string | null): string {
  const normalizedExplicit = resolveDisplayText(explicit);
  if (normalizedExplicit) return normalizedExplicit;
  const descriptor = getConnectedAccountDescriptor(serviceId);
  const descriptorName = descriptor
    ? CONNECTED_SERVICE_PROVIDER_DISPLAY_NAMES_BY_KEY[descriptor.displayKey]
    : undefined;
  return resolveDisplayText(descriptorName) ?? resolveDisplayText(serviceId) ?? 'Provider';
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
  }>,
): Readonly<{
  title: string;
  body: string;
  data: Record<string, unknown>;
  toolDetails?: string | null;
}> {
  if (event.topic === 'ready') {
    const content = buildReadyNotificationContent({
      sessionTitle: event.sessionTitle,
      defaultTitle: event.waitingForCommandLabel,
      waitingForCommandLabel: event.waitingForCommandLabel,
      fallbackBody: `${event.waitingForCommandLabel} is waiting for your command`,
      includeMessageText: options.readyIncludeMessageText,
      messageText: event.assistantPreviewText,
    });
    return {
      title: content.title,
      body: content.body,
      data: {
        sessionId: event.sessionId,
      },
    };
  }

  if (event.topic === 'connected_service_account_switch') {
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
      title: event.sessionTitle ?? `${serviceDisplayName} account switched`,
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
    const serviceDisplayName = resolveConnectedServiceDisplayName(event.serviceId, event.serviceDisplayName);
    return {
      title: event.sessionTitle ?? (event.topic === 'connected_service_quota_recovered' ? `${serviceDisplayName} quota recovered` : `${serviceDisplayName} quota blocked`),
      body: event.topic === 'connected_service_quota_recovered'
        ? `Quota is available again for ${serviceDisplayName}.`
        : `Waiting for quota availability for ${serviceDisplayName}.`,
      data: {
        topic: event.topic,
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
      title: event.sessionTitle ?? (event.status === 'reconnect_required' ? `${serviceDisplayName} account needs reconnect` : `${serviceDisplayName} account refresh failed`),
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
      sessionTitle: event.sessionTitle,
      agentDisplayName: event.agentDisplayName,
      requestId: event.requestId,
      toolName: event.toolName,
      toolInput: event.toolInput,
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
    title: event.sessionTitle ?? 'Activity update',
    body: 'Session activity changed.',
    data: {
      topic: event.topic,
      sessionId: event.sessionId,
    },
  };
}
