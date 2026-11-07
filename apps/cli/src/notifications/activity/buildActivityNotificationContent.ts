import { buildAgentRequestNotificationContent } from '@happier-dev/protocol/activity/agentRequestNotificationContent';
import { buildReadyNotificationContent } from '@happier-dev/protocol/push/readyNotificationContent';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { WorkflowRunUpdateNotificationV1Schema } from '@happier-dev/protocol/activity/webhookPayload';
import type { AttentionPreviewBehavior } from '@happier-dev/protocol';
import { GuardStopWarningNotificationV1Schema, GuardAttentionNotificationV1Schema, buildGuardStopWarningPushDataV1 } from '@happier-dev/protocol/activity/webhookPayload';
import { MachineGuardActivityNotificationV1Schema } from '@happier-dev/protocol/activity/webhookPayload';
import { MachineVitalsNotificationV1Schema, MachineVitalsPushRoutingDataV1Schema } from '@happier-dev/protocol/activity/webhookPayload';
import { resolveMachineVitalsNextStepsV1 } from '@happier-dev/protocol/machines/vitals/resolveMachineVitalsNextStepsV1';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation/formatBytes';
import { ServiceHealthNoticeNotificationV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

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

/** "1 h 55 min", "41 min", "2 d": an idle time as the warning says it. */
function formatGuardIdle(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function buildActivityNotificationContent(
  event: ActivityNotificationEvent,
  options: Readonly<{
    readyIncludeMessageText: boolean;
    requestIncludeMessageText?: boolean;
    previewBehavior?: AttentionPreviewBehavior;
    /** The send time, for words that count down to a moment (a guard stop's "in 5 minutes"). */
    nowMs?: number;
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
  if (event.topic === 'service_health') {
    const notice = ServiceHealthNoticeNotificationV1Schema.parse(event);
    return { title: includePreview ? redactNotificationText(notice.title) : 'Happier',
      body: includePreview && options.requestIncludeMessageText !== false ? redactNotificationText(notice.body ?? '') : '',
      data: { ...notice.data } };
  }
  if (event.topic === 'plugin_notification') return {
    title: includePreview ? redactNotificationText(event.title) : 'Happier',
    body: includePreview && options.requestIncludeMessageText !== false ? redactNotificationText(event.body ?? '') : '',
    data: { ...event.data },
  };
  if (event.topic === 'follow_update') {
    if ('original' in event.follow) {
      const original = event.follow.original;
      if ('kind' in original) return { title: event.follow.event.kind === 'person_wrote'
        ? 'A person wrote in the discussion' : 'Discussion has a new message', body: '', data: { followOriginal: original,
          discussionId: original.discussion.discussionId, discussionMessageId: original.messageId } };
      return { title: event.follow.event.kind === 'update_posted' ? 'Run output ready'
        : event.follow.event.kind === 'needs_you' ? 'Run needs you'
        : event.follow.event.kind === 'finished' ? 'Run finished' : 'Run failed or stopped', body: '',
        data: { followOriginal: original, ...(original.source.kind === 'workflow_run' ? { runId: original.source.runId }
          : { ...('sessionId' in original.source ? { sessionId: original.source.sessionId } : { machineId: original.source.machineId }),
            executionRunId: original.source.runId }) } };
    }
    const descriptions = { finished: 'Session finished', failed_or_stopped: 'Session failed or stopped',
      stalled: 'Session stalled', update_posted: 'Session posted an update', person_wrote: 'A person wrote in the session',
      goal_changed: 'Session goal changed', message: 'Session has a new message', needs_you: 'Session needs you' };
    return { title: descriptions[event.follow.event.kind], body: '', data: { sessionId: 'sessionId' in event ? event.sessionId : undefined,
      ...(event.follow.sourceMessage ? { activityEventLocalId: event.follow.sourceMessage.localId } : {}),
      ...(event.follow.sourceRequests?.requests.length === 1 ? { requestId: event.follow.sourceRequests.requests[0]!.requestId } : {}),
    } };
  }
  if (event.topic === 'resource_limit') {
    const notice = MachineVitalsNotificationV1Schema.parse(event);
    const minutes = (notice.at - notice.since) / 60_000;
    const window = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    const recovered = notice.phase === 'recovered';
    const subject = notice.machineName && options.previewBehavior !== 'status_only' ? notice.machineName : 'Machine';
    const titles = { memory_pressure: 'memory alert', cpu_busy: 'CPU alert', disk_nearly_full: 'disk space alert' };
    const observation = notice.kind === 'memory_pressure'
      ? `The ${notice.evidence.level} memory alert condition ${recovered ? 'cleared' : 'held'} over ${window}.`
      : notice.kind === 'cpu_busy'
        ? `CPU stayed ${recovered ? 'at or below' : 'above'} ${notice.evidence.abovePct}% over ${window}; latest ${notice.evidence.busyPct}%.`
        : `${notice.volumeLabel || 'Volume'} ${recovered ? 'has recovered from' : 'is below'} its free-space threshold over ${window}; ${notice.evidence.freeBytes} bytes free of ${notice.evidence.totalBytes}.`;
    const working = notice.workingSessionCount === undefined ? ''
      : ` ${notice.workingSessionCount} ${notice.workingSessionCount === 1 ? 'session is' : 'sessions are'} currently working.`;
    return {
      title: `${subject} ${titles[notice.kind]}${recovered ? ' recovered' : ''}`,
      body: includePreview ? `${observation}${working} Nothing was stopped by this alert.` : '',
      data: MachineVitalsPushRoutingDataV1Schema.parse({ topic: notice.topic, kind: notice.kind, phase: notice.phase,
        machineId: notice.machineId,
        notificationId: `machine-vitals:${JSON.stringify([notice.machineId, notice.kind, 'volumeId' in notice ? notice.volumeId : null])}`,
        nextSteps: resolveMachineVitalsNextStepsV1(notice, { guardEnabled: notice.guardEnabled }),
        ...(includePreview ? { machineVitals: notice } : {}),
      }),
    };
  }
  if (event.topic === 'machine_guard_activity') {
    const episode = MachineGuardActivityNotificationV1Schema.parse(event);
    const summary = [
      episode.counts.stoppedSessions ? `${episode.counts.stoppedSessions} sessions stopped` : '',
      episode.counts.closedBrowsers ? `${episode.counts.closedBrowsers} browsers closed` : '',
      episode.counts.stoppedServices ? `${episode.counts.stoppedServices} services stopped` : '',
      episode.counts.stoppedLeftBehind ? `${episode.counts.stoppedLeftBehind} left-behind groups stopped` : '',
    ].filter(Boolean).join(', ');
    return {
      title: episode.outOfSteps ? 'Guard needs a look' : 'Guard activity',
      body: includePreview ? summary || 'Open the machine to review its activity.' : '',
      data: { ...episode, notificationId: `guard-episode:${episode.machineId}:${episode.episodeId}` },
    };
  }
  if (event.topic === 'guard_stop_warning') {
    const warning = GuardStopWarningNotificationV1Schema.parse(event);
    // Lab `rg` G3-3: the session by name, when it stops, how long it sat idle and where; both actions work
    // from the notification itself. Status-only previews keep to the bare fact.
    const leadMinutes = Math.max(1, Math.round((warning.stopAt - (options.nowMs ?? Date.now())) / 60_000));
    const inMinutes = `in ${leadMinutes} ${leadMinutes === 1 ? 'minute' : 'minutes'}`;
    if (warning.rule === 'idle_terminals') {
      return {
        title: `Closing an idle terminal ${inMinutes}`,
        body: includePreview ? `${warning.idleMs !== undefined ? `Idle for ${formatGuardIdle(warning.idleMs)}. ` : ''}Keep it running if a command still needs it.` : '',
        data: buildGuardStopWarningPushDataV1(warning),
      };
    }
    const title = includePreview && warning.sessionTitle?.trim() ? `Stopping “${warning.sessionTitle.trim()}” ${inMinutes}` : `Stopping a session ${inMinutes}`;
    const where = warning.machineName?.trim() ? ` on ${warning.machineName.trim()}` : '';
    const idle = warning.idleMs !== undefined ? `Idle for ${formatGuardIdle(warning.idleMs)}${where}. ` : where ? `On${where.slice(3)}. ` : '';
    return {
      title,
      body: includePreview
        ? warning.rule === 'memory_guard'
          ? `${idle}The machine is short on memory. It finished its work and wakes on your next message.`
          : `${idle}It finished its work and wakes on your next message.`
        : '',
      data: buildGuardStopWarningPushDataV1(warning),
    };
  }
  if (event.topic === 'guard_attention') {
    const notice = GuardAttentionNotificationV1Schema.parse(event);
    const measurement = notice.memory
      ? `${formatHappierDataBytes(notice.memory.usedBytes, { kind: 'memory', locale: 'en-US' })} of a ${formatHappierDataBytes(notice.memory.limitBytes, { kind: 'memory', locale: 'en-US' })} limit. ` : '';
    return { title: notice.kind === 'ceiling_near' ? 'Session is near its memory ceiling' : 'Session reached its memory ceiling',
      body: includePreview ? `${measurement}Review the session or change its memory ceiling.` : '',
      data: includePreview ? notice : (({ memory: _memory, ...routing }) => routing)(notice) };
  }
  if (event.topic === 'connected_service_usage') {
    const descriptions = {
      pace: 'Usage has crossed above even pace for this allowance window.',
      depletion: 'Observed usage now projects above the allowance at reset.',
      almost_out: 'Remaining allowance crossed your chosen notification threshold.',
      reset: 'A new allowance window has been observed.',
      ending: 'The allowance window crossed your chosen ending-notice threshold.',
      unused: 'The last observed allowance had unused capacity before the witnessed reset.',
      credit_expiry: 'A reset credit crossed your chosen expiry-notice threshold.',
    } as const;
    return { title: 'Usage update', body: includePreview ? descriptions[event.kind] : '',
      data: { topic: event.topic, kind: event.kind, ...(includePreview ? {
        serviceId: event.serviceId, profileId: event.profileId, issueFingerprint: event.issueFingerprint, evidence: event.evidence,
      } : {}) } };
  }
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
      ? { title: 'Workflow completed', body: 'Open it to see the result.' }
      : workflowEvent.updateKind === 'completed_with_failures'
        ? { title: 'Workflow completed with failures', body: 'Open it to see what failed.' }
        : workflowEvent.updateKind === 'review_required'
          ? { title: 'A workflow needs you', body: "Open it to see what's waiting for you." }
        : workflowEvent.updateKind === 'failed'
          ? { title: 'Workflow failed', body: 'Open it to see what went wrong.' }
          : workflowEvent.updateKind === 'paused'
            ? { title: 'Workflow paused', body: 'A workflow paused.' }
            : workflowEvent.updateKind === 'interrupted'
              ? { title: 'A workflow was interrupted', body: 'Open it to choose how to continue.' }
              : { title: 'A workflow needs attention', body: 'Its outcome could not be confirmed.' };
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
      turnId: event.turnId,
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
      sessionId: 'sessionId' in event ? event.sessionId : undefined,
    },
  };
}
