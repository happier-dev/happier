import { summarizeToolInputForNotification } from '@happier-dev/protocol';
import { buildReadyNotificationContent, redactBugReportSensitiveText } from '@happier-dev/protocol';

import { readSafeOauthProviderErrorCode } from '../../cloud/safeOauthProviderError';
import { resolveConnectedServiceProviderDisplayName } from '../../daemon/connectedServices/descriptors/connectedAccountDescriptors';
import type { ActivityNotificationEvent } from './activityNotificationEvent';
import {
  buildAgentRequestNotificationContent,
} from './buildAgentRequestNotificationContent';

const RAW_JSON_SECRET_KEY_PATTERN = /(["']?)(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|authorization|openai_api_key|anthropic_api_key)(\1)\s*:\s*(["'])[^"']*\4/gi;
const EMBEDDED_OAUTH_ERROR_CODE_PATTERN = /["'](?:error|code|type)["']\s*:\s*["']([A-Za-z0-9_.:-]{1,120})["']/i;
const MODULE_RESOLUTION_PATTERN = /\b(Cannot find module|MODULE_NOT_FOUND|Require stack:|node_modules)\b/i;

function resolveConnectedServiceDisplayName(serviceId: string, explicit?: string | null): string {
  return resolveConnectedServiceProviderDisplayName(serviceId, explicit);
}

function resolveDisplayText(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return normalized ? normalized : null;
}

function redactNotificationText(value: string | null | undefined): string | null {
  const normalized = resolveDisplayText(value);
  if (!normalized) return null;
  const redactedJson = normalized.replace(
    RAW_JSON_SECRET_KEY_PATTERN,
    (_match, quote: string, key: string, closingQuote: string, valueQuote: string) =>
      `${quote}${key}${closingQuote}: ${valueQuote}[REDACTED]${valueQuote}`,
  );
  const redacted = redactBugReportSensitiveText(redactedJson).replace(/\s+/g, ' ').trim();
  return redacted || null;
}

function sanitizeProviderDiagnostic(value: string | null | undefined): Readonly<{
  data: string | null;
  display: string | null;
}> {
  const normalized = resolveDisplayText(value);
  if (!normalized) return { data: null, display: null };
  const oauthCode = readSafeOauthProviderErrorCode(normalized)
    ?? EMBEDDED_OAUTH_ERROR_CODE_PATTERN.exec(normalized)?.[1]
    ?? null;
  const hasModuleResolution = MODULE_RESOLUTION_PATTERN.test(normalized);
  if (oauthCode || hasModuleResolution) {
    const parts = [
      oauthCode,
      hasModuleResolution ? 'provider_runtime_error' : null,
    ].filter((part): part is string => Boolean(part));
    const data = parts.join(' ');
    return {
      data,
      display: data.replace(/\bprovider_runtime_error\b/g, 'provider runtime error'),
    };
  }
  const redacted = redactNotificationText(normalized);
  return { data: redacted, display: redacted };
}

function sanitizeNotificationAction(
  action: Readonly<{ kind: 'open_url'; url: string }> | null | undefined,
): Readonly<{ kind: 'open_url'; url: string }> | null {
  if (!action) return null;
  return {
    kind: action.kind,
    url: redactNotificationText(action.url) ?? '[REDACTED]',
  };
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

function formatUsageSide(label: string, usage: Readonly<{ label: string | null; remainingPercent: number }>): string {
  const meterLabel = resolveDisplayText(usage.label);
  const pct = Math.round(Math.max(0, Math.min(100, usage.remainingPercent)));
  return `${label}: ${meterLabel ? `${meterLabel} ` : ''}${pct}% remaining`;
}

export function buildActivityNotificationContent(
  event: ActivityNotificationEvent,
  options: Readonly<{
    readyIncludeMessageText: boolean;
    requestIncludeMessageText?: boolean;
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
    const fromProfileLabel = redactNotificationText(event.fromProfileLabel);
    const toProfileLabel = redactNotificationText(event.toProfileLabel);
    const fromProfile = fromProfileLabel ?? event.fromProfileId;
    const toProfile = toProfileLabel ?? event.toProfileId;
    const action = sanitizeNotificationAction(event.action);
    const accountClause = fromProfile && toProfile
      ? ` from ${fromProfile} to ${toProfile}`
      : toProfile
      ? ` to ${toProfile}`
      : '';
    const usageParts = [
      event.fromUsage ? formatUsageSide('Previous account', event.fromUsage) : null,
      event.toUsage ? formatUsageSide('New account', event.toUsage) : null,
    ].filter((part): part is string => part !== null);
    const usageClause = usageParts.length > 0 ? ` ${usageParts.join('. ')}.` : '';
    const reasonSentence = buildSwitchReasonSentence(event.reason, serviceDisplayName);
    return {
      title: event.sessionTitle ?? `${serviceDisplayName} account switched`,
      body: `${reasonSentence}${accountClause ? ` Account changed${accountClause}.` : ''}${usageClause}`,
      data: {
        topic: event.topic,
        sessionId: event.sessionId,
        serviceId: event.serviceId,
        serviceDisplayName,
        groupId: event.groupId,
        fromProfileId: event.fromProfileId,
        toProfileId: event.toProfileId,
        reason: event.reason,
        limitCategory: event.limitCategory ?? null,
        retryAfterMs: event.retryAfterMs ?? null,
        quotaScope: event.quotaScope ?? null,
        providerLimitId: event.providerLimitId ?? null,
        fromProfileLabel,
        toProfileLabel,
        fromUsagePercent: event.fromUsagePercent ?? null,
        toUsagePercent: event.toUsagePercent ?? null,
        fromUsage: event.fromUsage ?? null,
        toUsage: event.toUsage ?? null,
        action,
      },
    };
  }

  if (event.topic === 'connected_service_quota_blocked' || event.topic === 'connected_service_quota_recovered') {
    const serviceDisplayName = resolveConnectedServiceDisplayName(event.serviceId, event.serviceDisplayName);
    const automaticReset = event.topic === 'connected_service_quota_recovered' && event.recoveryReason === 'automatic_quota_reset';
    const resetAccount = redactNotificationText(event.profileId) ?? 'selected account';
    const resetPool = redactNotificationText(event.groupId) ?? 'account pool';
    const action = sanitizeNotificationAction(event.action);
    return {
      title: automaticReset ? `${serviceDisplayName} reset credit used` : event.sessionTitle ?? (event.topic === 'connected_service_quota_recovered' ? `${serviceDisplayName} quota recovered` : `${serviceDisplayName} quota blocked`),
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
        action,
      },
    };
  }

  if (event.topic === 'connected_service_credential_health') {
    const serviceDisplayName = resolveConnectedServiceDisplayName(event.serviceId, event.serviceDisplayName);
    const profileLabel = redactNotificationText(event.profileLabel) ?? event.profileId;
    const providerErrorCode = sanitizeProviderDiagnostic(event.providerErrorCode);
    const reason = sanitizeProviderDiagnostic(event.reason);
    const safeReason = providerErrorCode.display ?? reason.display;
    const reasonClause = safeReason ? ` Provider code: ${safeReason}.` : '';
    const body = event.status === 'reconnect_required'
      ? `${serviceDisplayName} account ${profileLabel} needs to be reconnected before Happier can use it again.${reasonClause}`
      : `${serviceDisplayName} account ${profileLabel} could not be refreshed. Happier will retry automatically.${reasonClause}`;
    const action = sanitizeNotificationAction(event.action);
    return {
      title: event.sessionTitle ?? (event.status === 'reconnect_required' ? `${serviceDisplayName} account needs reconnect` : `${serviceDisplayName} account refresh failed`),
      body,
      data: {
        topic: event.topic,
        sessionId: event.sessionId,
        serviceId: event.serviceId,
        serviceDisplayName,
        profileId: event.profileId,
        profileLabel,
        status: event.status,
        reason: reason.data,
        providerStatus: event.providerStatus ?? null,
        providerErrorCode: providerErrorCode.data,
        action,
      },
    };
  }

  if (event.topic === 'permission_request' || event.topic === 'user_action_request') {
    const kind = event.topic === 'user_action_request' ? 'user_action' : 'permission';
    const toolDetails = options.requestIncludeMessageText === false ? null : typeof event.toolDetails === 'string' && event.toolDetails.trim()
      ? event.toolDetails.trim()
      : summarizeToolInputForNotification(event.toolName, event.toolInput);
    const built = buildAgentRequestNotificationContent({
      kind,
      sessionId: event.sessionId,
      sessionTitle: event.sessionTitle,
      agentDisplayName: event.agentDisplayName,
      requestId: event.requestId,
      occurrenceId: event.occurrenceId,
      toolName: event.toolName,
      toolDetails,
      toolInput: options.requestIncludeMessageText === false ? undefined : event.toolInput,
    });
    return {
      title: built.title,
      body: built.body,
      data: built.data,
      toolDetails,
    };
  }

  const _exhaustive: never = event;
  return _exhaustive;
}
