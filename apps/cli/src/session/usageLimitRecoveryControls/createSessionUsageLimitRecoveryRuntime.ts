import { accountSettingsParse, buildUsageLimitIssueFingerprint, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, SessionUsageLimitRecoveryV1Schema,
  resolveSessionUsageLimitRecoveryResumePromptModeV1, type AccountSettings, type SessionRuntimeIssueV1,
  type SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import type { Metadata } from '@/api/types';
import type { Credentials } from '@/persistence';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { resolveUsageLimitRecoveryFeatureEnabled } from '@/features/usageLimitRecoveryFeatureGate';
import { UsageLimitRecoveryScheduler } from '@/daemon/connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { resolveInactiveUsageLimitRecoverySchedulerResult } from '@/daemon/connectedServices/usageLimitRecovery/resolveInactiveUsageLimitRecoverySchedulerResult';
import { continueSessionAfterUsageLimitReset } from '@/daemon/connectedServices/continuation/continueSessionAfterUsageLimitReset';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { resolveSessionEncryptionContextFromCredentials, resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { logger } from '@/ui/logger';
import { buildRecoveryIntentFromLatestUsageLimitIssue, buildRecoveryIntentFromUsageLimitIssue, routeSessionUsageLimitRecoveryCheckNow } from './sessionUsageLimitRecoveryControlRouter';
import { readLatestUsageLimitFailureIssue } from './readLatestUsageLimitFailureIssue';
import { hasSameUsageLimitRecoveryIdentity, isPendingUsageLimitRecoveryStatus, mergeUsageLimitRecoveryExplicitRearm } from './mergeUsageLimitRecoveryIntent';
import { mergeUsageLimitRecoveryFieldIntoMetadata } from './persistUsageLimitRecoveryFieldDurably';
import { DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS } from './createBackoffSessionUsageLimitRecoveryControlAdapter';

type RuntimeControls = Required<Pick<SessionRuntimeControls,
  'enableUsageLimitWaitResume' | 'cancelUsageLimitWaitResume' | 'checkUsageLimitRecoveryNow'>>;

/** The live Session owns ordinary quota waits; inactive recovery uses the same router and Pending continuation. */
export function createSessionUsageLimitRecoveryRuntime(deps: Readonly<{
  sessionId: string;
  getMetadata: () => Metadata | null;
  updateMetadata: (update: (metadata: Metadata) => Metadata) => Promise<void>;
  getCredentials: () => Promise<Credentials | null>;
  getAccountSettings: () => AccountSettings | null;
  nowMs?: () => number;
}>) {
  const nowMs = deps.nowMs ?? Date.now;
  let disposed = false;
  let acceptedFailure: SessionRuntimeIssueV1 | null = null;
  const read = (): SessionUsageLimitRecoveryV1 | null => {
    const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(deps.getMetadata()?.[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
    return parsed.success ? parsed.data : null;
  };
  const persist = async (intent: SessionUsageLimitRecoveryV1) => {
    const baseMetadata = deps.getMetadata() ?? {};
    await deps.updateMetadata((metadata) => {
      const current = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
      if (current.success && current.data.runtimeAuthRecoveryAttemptId) return metadata;
      return mergeUsageLimitRecoveryFieldIntoMetadata({ latestMetadata: metadata,
        baseMetadata, candidateMetadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: intent } }) as Metadata;
    });
  };
  const scheduler = new UsageLimitRecoveryScheduler({ nowMs,
    store: {
      read,
      write: async (_sessionId, intent) => await persist(intent),
      merge: async (_sessionId, intent, merge) => {
        let committed: SessionUsageLimitRecoveryV1 | null = null;
        await deps.updateMetadata((metadata) => {
          const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
          committed = parsed.success && parsed.data.runtimeAuthRecoveryAttemptId ? parsed.data : merge(parsed.success ? parsed.data : null, intent);
          return committed ? { ...metadata, [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: committed } : metadata;
        });
        return committed;
      },
    },
    recover: async (intent) => {
      if (disposed || intent.runtimeAuthRecoveryAttemptId) return { status: 'superseded' };
      if (!await resolveUsageLimitRecoveryFeatureEnabled()) {
        return { status: 'wait', nextCheckAtMs: nowMs() + DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS,
          lastProbeError: 'feature_disabled' };
      }
      const context = await readContext();
      if (!context) return { status: 'wait', nextCheckAtMs: nowMs() + DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS,
        lastProbeError: 'usage_limit_recovery_session_unavailable' };
      const latest = readLatestUsageLimitFailureIssue(context.rawSession);
      const current = read();
      if (!current || !hasSameUsageLimitRecoveryIdentity(current, intent)) return { status: 'superseded' };
      if (!latest || buildUsageLimitIssueFingerprint(latest) !== intent.issueFingerprint) {
        const awaitingAcceptedFailure = acceptedFailure && buildUsageLimitIssueFingerprint(acceptedFailure) === intent.issueFingerprint
          && (latest?.occurredAt ?? 0) < acceptedFailure.occurredAt
          && (context.rawSession.latestTurnStatusObservedAt ?? 0) < acceptedFailure.occurredAt;
        return awaitingAcceptedFailure ? { status: 'wait', nextCheckAtMs: nowMs() + DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS,
          lastProbeError: 'usage_limit_recovery_terminal_mutation_pending' } : { status: 'superseded' };
      }
      const result = await runRoutedCheck(context, intent);
      return resolveInactiveUsageLimitRecoverySchedulerResult({ result, nowMs: nowMs(), fallbackRetryDelayMs: DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS });
    },
  });

  async function readContext() {
    const credentials = await deps.getCredentials();
    if (!credentials) return null;
    const rawSession = await fetchSessionById({ token: credentials.token, sessionId: deps.sessionId });
    if (!rawSession) return null;
    const metadata = tryDecryptSessionMetadata({ credentials, rawSession });
    if (!metadata) return null;
    return { credentials, token: credentials.token, sessionId: deps.sessionId, rawSession, metadata,
      currentMachineId: deps.getMetadata()?.machineId ?? null,
      ctx: resolveSessionEncryptionContextFromCredentials(credentials, rawSession), mode: resolveSessionStoredContentEncryptionMode(rawSession) };
  }

  async function runRoutedCheck(context: NonNullable<Awaited<ReturnType<typeof readContext>>>, intent: SessionUsageLimitRecoveryV1, operation?: 'consume_reset_credit') {
      const result = await routeSessionUsageLimitRecoveryCheckNow({ ...context,
        request: { sessionId: deps.sessionId, ...(operation ? { operation } : {}) },
        callLiveSessionRpc: async () => ({ ok: false, errorCode: 'unsupported_session_runtime_method' }),
        resumeInactiveSessionWhenReady: async ({ rawSession, metadata, readiness }) => {
          const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
          if (!parsed.success) return false;
          const continued = await continueSessionAfterUsageLimitReset({ credentials: context.credentials,
            sessionId: deps.sessionId, rawSession, metadata, recovery: parsed.data,
            ...(readiness ? { readiness } : {}),
            nowMs: nowMs(), customResumePrompt: deps.getAccountSettings()?.usageLimitRecoverySettingsV1?.customResumePrompt,
            isCurrent: () => {
              const fresh = read();
              return !disposed && Boolean(fresh && fresh.status !== 'cancelled' && fresh.status !== 'exhausted'
                && hasSameUsageLimitRecoveryIdentity(fresh, intent) && !fresh.runtimeAuthRecoveryAttemptId);
            }, ensureRuntime: async () => !disposed,
          });
          return continued;
        },
      });
      const record = result && typeof result === 'object' ? result as Record<string, unknown> : null;
      const nextMetadata = record?.metadata;
      if (nextMetadata && typeof nextMetadata === 'object') {
        const next = SessionUsageLimitRecoveryV1Schema.safeParse((nextMetadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
        if (next.success) await persist(next.data);
      }
      return result;
  }

  async function enable(request: Parameters<RuntimeControls['enableUsageLimitWaitResume']>[0], probeUnknownTiming = true) {
    if (disposed || request.sessionId !== deps.sessionId) return { ok: false, errorCode: 'invalid_input' };
    const context = await readContext();
    if (!context) return { ok: false, errorCode: 'usage_limit_recovery_session_unavailable' };
    const existing = read();
    if (existing?.runtimeAuthRecoveryAttemptId) return { ok: false, errorCode: 'unsupported_session_runtime_method' };
    const resumePromptMode = resolveSessionUsageLimitRecoveryResumePromptModeV1({ explicit: request.resumePromptMode,
      existingIntent: existing, accountSettings: deps.getAccountSettings() });
    const intent = buildRecoveryIntentFromLatestUsageLimitIssue({ rawSession: context.rawSession,
      connectedServices: context.metadata.connectedServices, resumePromptMode,
      ...(request.issueFingerprint ? { issueFingerprint: request.issueFingerprint } : {}) });
    if (!intent) return { ok: false, errorCode: 'usage_limit_issue_unavailable' };
    if (request.rememberPreference) await updateAccountSettingsV2WithRetry({ credentials: context.credentials,
      mutate: (settings) => ({ ...settings, usageLimitRecoverySettingsV1: {
        ...accountSettingsParse(settings).usageLimitRecoverySettingsV1, v: 1, mode: 'auto_wait' } }) });
    return await arm(intent, probeUnknownTiming && intent.resetAtMs === null
      && readLatestUsageLimitFailureIssue(context.rawSession)?.usageLimit?.retryAfterMs == null);
  }

  async function arm(intent: SessionUsageLimitRecoveryV1, probeUnknownTiming: boolean) {
    const armed = mergeUsageLimitRecoveryExplicitRearm(read(), { ...intent, armedAtMs: nowMs() });
    await scheduler.upsertScheduled({ sessionId: deps.sessionId, intent: armed });
    if (probeUnknownTiming) {
      await scheduler.checkNow({ sessionId: deps.sessionId });
    }
    return { ok: true, recovery: read() ?? armed };
  }

  const controls: RuntimeControls = {
    enableUsageLimitWaitResume: enable,
    cancelUsageLimitWaitResume: async (request) => {
      if (request.sessionId !== deps.sessionId) return { ok: false, errorCode: 'invalid_input' };
      const cancelled = await scheduler.cancelExact(request);
      return cancelled.status === 'cancelled' ? { ok: true, recovery: cancelled.intent }
        : { ok: false, errorCode: 'usage_limit_recovery_attempt_superseded' };
    },
    checkUsageLimitRecoveryNow: async (request) => {
      if (request.sessionId !== deps.sessionId) return { ok: false, errorCode: 'invalid_input' };
      if (request.operation === 'switch_account_now') return { ok: false, errorCode: 'unsupported_session_runtime_method' };
      let current = read();
      if (current?.status === 'cancelled') return { ok: true, status: 'cancelled' };
      if (current?.status === 'exhausted') return { ok: true, status: 'exhausted' };
      if (!current || current.status === 'paused') {
        const enabled = await enable(request, false);
        if (!enabled.ok) return enabled;
        current = read();
      }
      if (current && request.resumePromptMode && current.resumePromptMode !== request.resumePromptMode) {
        await persist({ ...current, resumePromptMode: request.resumePromptMode });
      }
      if (request.operation === 'consume_reset_credit') {
        if (!current || current.runtimeAuthRecoveryAttemptId) return { ok: false, errorCode: 'unsupported_session_runtime_method' };
        const context = await readContext();
        if (!context) return { ok: false, errorCode: 'usage_limit_recovery_session_unavailable' };
        const result = await runRoutedCheck(context, current, 'consume_reset_credit');
        const latest = read();
        if (latest) await scheduler.upsertScheduled({ sessionId: deps.sessionId, intent: latest });
        return result;
      }
      return { ok: true, ...await scheduler.checkNow({ sessionId: deps.sessionId }) };
    },
  };

  return {
    controls,
    restore: async () => {
      const intent = read();
      if (!intent || intent.runtimeAuthRecoveryAttemptId
        || !isPendingUsageLimitRecoveryStatus(intent.status)) return;
      if (!await resolveUsageLimitRecoveryFeatureEnabled() || disposed) return;
      await scheduler.upsertScheduled({ sessionId: deps.sessionId, intent });
    },
    observeFailure: async (issue: SessionRuntimeIssueV1) => {
      acceptedFailure = issue.source === 'usage_limit' ? issue : null;
      if (disposed || issue.source !== 'usage_limit' || !issue.usageLimit
        || issue.usageLimit.recoverability !== 'wait' || deps.getAccountSettings()?.usageLimitRecoverySettingsV1?.mode !== 'auto_wait') return;
      if (!await resolveUsageLimitRecoveryFeatureEnabled() || disposed || acceptedFailure !== issue || read()?.runtimeAuthRecoveryAttemptId) return;
      const existing = read();
      if (existing?.issueFingerprint === buildUsageLimitIssueFingerprint(issue)) return;
      const resumePromptMode = resolveSessionUsageLimitRecoveryResumePromptModeV1({ existingIntent: existing,
        accountSettings: deps.getAccountSettings() });
      const intent = buildRecoveryIntentFromUsageLimitIssue({ issue, resumePromptMode,
        connectedServices: deps.getMetadata()?.connectedServices });
      if (intent) await arm(intent, intent.resetAtMs === null && issue.usageLimit.retryAfterMs == null);
    },
    observeSupersession: async () => {
      acceptedFailure = null;
      const intent = read();
      if (intent && !intent.runtimeAuthRecoveryAttemptId) await scheduler.cancelExact({ sessionId: deps.sessionId,
        issueFingerprint: intent.issueFingerprint, armedAtMs: intent.armedAtMs });
    },
    dispose: () => { disposed = true; scheduler.dispose(); },
    reportError: (error: unknown) => logger.warn('[usage-limit-recovery] Session recovery could not progress', {
      sessionId: deps.sessionId, errorType: error instanceof Error ? error.name : 'unknown' }),
  };
}
