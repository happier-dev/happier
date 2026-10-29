import { accountSettingsParse, type AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import {
  buildUsageLimitIssueFingerprint, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { AccountSettingMutationV1Schema } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import type { Metadata } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { resolveUsageLimitRecoveryEnabled } from '@/features/usageLimitRecoveryFeatureGate';
import { UsageLimitRecoveryScheduler } from '@/daemon/connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { resolveInactiveUsageLimitRecoverySchedulerResult } from '@/daemon/connectedServices/usageLimitRecovery/resolveInactiveUsageLimitRecoverySchedulerResult';
import { continueSessionAfterUsageLimitReset } from '@/daemon/connectedServices/continuation/continueSessionAfterUsageLimitReset';
import { resolveRoutedUsageLimitRecoveryResumePromptMode } from './resolveRoutedUsageLimitRecoveryResumePromptMode';
import { updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { logger } from '@/ui/logger';
import { buildRecoveryIntentFromLatestUsageLimitIssue, buildRecoveryIntentFromUsageLimitIssue, routeSessionUsageLimitRecoveryCheckNow } from './sessionUsageLimitRecoveryControlRouter';
import { readLatestUsageLimitFailureIssue } from './readLatestUsageLimitFailureIssue';
import { hasSameUsageLimitRecoveryIdentity, isPendingUsageLimitRecoveryStatus, mergeUsageLimitRecoveryExplicitRearm } from './mergeUsageLimitRecoveryIntent';
import { mergeUsageLimitRecoveryFieldIntoMetadata } from './mergeUsageLimitRecoveryFieldIntoMetadata';
import { DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS } from './createBackoffSessionUsageLimitRecoveryControlAdapter';

const storedUsageLimitRecoverySchema = createStoredReadSchema(SessionUsageLimitRecoveryV1Schema);

type RuntimeControls = Required<Pick<SessionRuntimeControls,
  'enableUsageLimitWaitResume' | 'cancelUsageLimitWaitResume' | 'checkUsageLimitRecoveryNow'>>;

/** The live Session owns ordinary quota waits; inactive recovery uses the same router and Pending continuation. */
export function createSessionUsageLimitRecoveryRuntime(deps: Readonly<{
  sessionId: string;
  getMetadata: () => Metadata | null;
  updateMetadata: (update: (metadata: Metadata) => Metadata) => Promise<void>;
  /** Current owner credentials and storage envelopes come from the bound Session transport owner. */
  readContext: () => Promise<(Readonly<{
    credentials: StoredCredentials;
    rawSession: RawSessionRecord;
    metadata: Record<string, unknown>;
  }> & SessionStoredContentCryptoContext) | null>;
  currentMachineId: string | null;
  runRequest: <T>(operation: () => Promise<T>) => Promise<T>;
  isFeatureEnabled?: () => Promise<boolean>;
  readNativeReadiness?: RuntimeControls['checkUsageLimitRecoveryNow'];
  getAccountSettings: () => AccountSettings | null;
  nowMs?: () => number;
}>) {
  const nowMs = deps.nowMs ?? Date.now;
  let disposed = false;
  let acceptedFailure: SessionRuntimeIssueV1 | null = null;
  const read = (): SessionUsageLimitRecoveryV1 | null => {
    const parsed = storedUsageLimitRecoverySchema.safeParse(deps.getMetadata()?.[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
    return parsed.success ? parsed.data : null;
  };
  const persist = async (intent: SessionUsageLimitRecoveryV1) => {
    const baseMetadata = deps.getMetadata() ?? {};
    await deps.updateMetadata((metadata) => {
      return mergeUsageLimitRecoveryFieldIntoMetadata({ latestMetadata: metadata,
        baseMetadata, candidateMetadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: intent } }) as Metadata;
    });
  };
  const scheduler = new UsageLimitRecoveryScheduler({ nowMs,
    store: {
      read,
      write: async (_sessionId, intent) => await persist(intent),

    },
    recover: async (intent) => {
      if (disposed || intent.runtimeAuthRecoveryAttemptId) return { status: 'superseded' };
      if (!await (deps.isFeatureEnabled ?? resolveUsageLimitRecoveryEnabled)()) return { status: 'wait',
        nextCheckAtMs: nowMs() + DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS, lastProbeError: 'feature_disabled' };
      const context = await readContext();
      if (!context) return { status: 'wait', nextCheckAtMs: nowMs() + DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS,
        lastProbeError: 'usage_limit_recovery_session_unavailable' };
      const latest = readLatestUsageLimitFailureIssue(context.rawSession);
      const current = read();
      if (!current || !isPendingUsageLimitRecoveryStatus(current.status) || !hasSameUsageLimitRecoveryIdentity(current, intent)) return { status: 'superseded' };
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
    const context = await deps.readContext();
    if (!context) return null;
    return { ...context, token: context.credentials.token, sessionId: deps.sessionId,
      currentMachineId: deps.currentMachineId,
      stageUsageLimitRecoveryMutation: async (mutation: Parameters<typeof applyRegisteredSessionStateFieldMutationToMetadata>[1]) => {
        await deps.updateMetadata(metadata => applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation));
      } };
  }

  async function runRoutedCheck(context: NonNullable<Awaited<ReturnType<typeof readContext>>>, intent: SessionUsageLimitRecoveryV1) {
      return await deps.runRequest(async () => {
      const result = await routeSessionUsageLimitRecoveryCheckNow({ ...context,
        request: { sessionId: deps.sessionId },
        readCurrentUsageLimitRecovery: () => read(),
        callLiveSessionRpc: async () => {
          const dueAtMs = intent.nextCheckAtMs ?? intent.resetAtMs;
          return typeof dueAtMs === 'number' && dueAtMs <= nowMs()
            ? { ok: false, errorCode: 'unsupported_session_runtime_method' }
            : deps.readNativeReadiness
              ? await deps.readNativeReadiness({ sessionId: deps.sessionId })
              : { ok: false, errorCode: 'unsupported_session_runtime_method' };
        },
        resumeInactiveSessionWhenReady: async ({ rawSession, metadata, readiness }) => {
          const parsed = storedUsageLimitRecoverySchema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
          if (!parsed.success) return false;
          const continued = await continueSessionAfterUsageLimitReset({ credentials: context.credentials,
            sessionId: deps.sessionId, rawSession, metadata, recovery: parsed.data, readiness,
            nowMs: nowMs(), customResumePrompt: deps.getAccountSettings()?.usageLimitRecoverySettingsV1?.customResumePrompt,
            isCurrent: () => {
              const fresh = read();
              return !disposed && Boolean(fresh && fresh.status !== 'cancelled' && fresh.status !== 'exhausted'
                && hasSameUsageLimitRecoveryIdentity(fresh, intent) && !fresh.runtimeAuthRecoveryAttemptId);
            },
          });
          return continued;
        },
      });
      const record = result && typeof result === 'object' ? result as Record<string, unknown> : null;
      const nextMetadata = record?.metadata;
      if (nextMetadata && typeof nextMetadata === 'object') {
        const next = storedUsageLimitRecoverySchema.safeParse((nextMetadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
        if (next.success) await persist(next.data);
      }
      return result;
      });
  }

  async function enable(request: Parameters<RuntimeControls['enableUsageLimitWaitResume']>[0], probeUnknownTiming = true) {
    return await deps.runRequest(async () => {
    if (disposed || request.sessionId !== deps.sessionId) return { ok: false, errorCode: 'invalid_input' };
    const context = await readContext();
    if (!context) return { ok: false, errorCode: 'usage_limit_recovery_session_unavailable' };
    const existing = read();
    if (existing?.runtimeAuthRecoveryAttemptId) return { ok: false, errorCode: 'unsupported_session_runtime_method' };
    const resumePromptMode = await resolveRoutedUsageLimitRecoveryResumePromptMode({ explicit: request.resumePromptMode,
      existingIntent: existing, accountSettings: deps.getAccountSettings() });
    const intent = buildRecoveryIntentFromLatestUsageLimitIssue({ rawSession: context.rawSession,
      connectedServices: context.metadata.connectedServices, resumePromptMode,
      ...(request.issueFingerprint ? { issueFingerprint: request.issueFingerprint } : {}) });
    if (!intent) return { ok: false, errorCode: 'usage_limit_issue_unavailable' };
    if (request.rememberPreference) await updateAccountSettingsV2WithRetry({ credentials: context.credentials,
      prepareMutation: (raw) => AccountSettingMutationV1Schema.parse({ operations: [{ op: 'set', key: 'usageLimitRecoverySettingsV1',
        value: { ...accountSettingsParse(raw).usageLimitRecoverySettingsV1, v: 1, mode: 'auto_wait' } }] }) });
    return await arm(intent, probeUnknownTiming && intent.resetAtMs === null
      && readLatestUsageLimitFailureIssue(context.rawSession)?.usageLimit?.retryAfterMs == null);
    });
  }

  async function arm(intent: SessionUsageLimitRecoveryV1, probeUnknownTiming: boolean) {
    const armed = mergeUsageLimitRecoveryExplicitRearm(read(), { ...intent, armedAtMs: nowMs() });
    await scheduler.upsertScheduled({ sessionId: deps.sessionId, intent: armed });
    if (probeUnknownTiming) {
      await scheduler.checkNow({ sessionId: deps.sessionId });
    }
    const recovery = read() ?? armed;
    return { ok: true, status: isPendingUsageLimitRecoveryStatus(recovery.status) ? 'waiting'
      : recovery.status === 'paused' ? 'ready' : recovery.status, recovery };
  }

  const controls: RuntimeControls = {
    enableUsageLimitWaitResume: enable,
    cancelUsageLimitWaitResume: async (request) => {
      if (request.sessionId !== deps.sessionId) return { ok: false, errorCode: 'invalid_input' };
      const linked = read();
      if (linked?.runtimeAuthRecoveryAttemptId) {
        let settled = false;
        await deps.updateMetadata(metadata => {
          settled = false;
          const current = storedUsageLimitRecoverySchema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
          if (!current.success || !hasSameUsageLimitRecoveryIdentity(current.data, request)) return metadata;
          settled = true;
          return { ...metadata, [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
            ...current.data, status: 'cancelled', nextCheckAtMs: null,
          } };
        });
        return settled ? { ok: true, status: 'cancelled' }
          : { ok: false, errorCode: 'usage_limit_recovery_attempt_superseded' };
      }
      const cancelled = await scheduler.cancelExact(request);
      return cancelled.status === 'cancelled' ? { ok: true, status: 'cancelled', recovery: cancelled.intent }
        : { ok: false, errorCode: 'usage_limit_recovery_attempt_superseded' };
    },
    checkUsageLimitRecoveryNow: async (request) => {
      if (request.sessionId !== deps.sessionId) return { ok: false, errorCode: 'invalid_input' };
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
      return { ok: true, ...await scheduler.checkNow({ sessionId: deps.sessionId }) };
    },
  };

  return {
    controls,
    restore: async () => {
      const intent = read();
      if (!intent || intent.runtimeAuthRecoveryAttemptId
        || !isPendingUsageLimitRecoveryStatus(intent.status)) return;
      if (!await (deps.isFeatureEnabled ?? resolveUsageLimitRecoveryEnabled)() || disposed) return;
      await scheduler.upsertScheduled({ sessionId: deps.sessionId, intent });
    },
    observeFailure: async (issue: SessionRuntimeIssueV1) => {
      acceptedFailure = issue.source === 'usage_limit' ? issue : null;
      if (disposed || issue.source !== 'usage_limit' || !issue.usageLimit
        || issue.usageLimit.recoverability !== 'wait' || deps.getAccountSettings()?.usageLimitRecoverySettingsV1?.mode !== 'auto_wait') return;
      if (!await (deps.isFeatureEnabled ?? resolveUsageLimitRecoveryEnabled)() || disposed || acceptedFailure !== issue) return;
      const existing = read();
      if (existing?.issueFingerprint === buildUsageLimitIssueFingerprint(issue)) return;
      const resumePromptMode = await resolveRoutedUsageLimitRecoveryResumePromptMode({ existingIntent: existing,
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
