import {
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  type SessionUsageLimitRecoveryResumePromptModeV1,
} from '@happier-dev/protocol';

import { notifyDaemonConnectedServiceRuntimeAuthFailure } from '@/daemon/controlClient';
import { logger as defaultLogger } from '@/ui/logger';

import {
  isRetryableConnectedServiceRuntimeAuthFailureReportDelivery,
  resolveConnectedServiceRuntimeAuthFailureStatusMessage,
} from './resolveConnectedServiceRuntimeAuthFailureStatusMessage';
import {
  normalizeConnectedServiceRuntimeAuthRecoveryProjection,
  type ConnectedServiceRuntimeAuthRecoveryProjection,
} from './projection/connectedServiceRuntimeAuthRecoveryProjection';
import {
  enqueueRuntimeAuthFailureReportOutboxItem,
  removeRuntimeAuthFailureReportOutboxItem,
  resolveRuntimeAuthFailureReportOutboxKey,
} from './reportOutbox/runtimeAuthFailureReportOutbox';
import { scheduleRuntimeAuthFailureReportOutboxDrainToDaemon } from './reportOutbox/runtimeAuthFailureReportOutboxDrainScheduler';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './sanitizeConnectedServiceRuntimeFailureClassification';

type RuntimeAuthFailureNotifyBody = Readonly<{
  sessionId: string;
  switchesThisTurn?: number;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  classification: unknown;
}>;

type RuntimeAuthFailureNotifyOptions = Readonly<{
  timeoutMs?: number;
}>;

type RuntimeAuthFailureNotify = (
  body: RuntimeAuthFailureNotifyBody,
  options?: RuntimeAuthFailureNotifyOptions,
) => Promise<unknown>;

type RuntimeAuthFailureLogger = Readonly<{
  debug: (message: string, error?: unknown) => void;
}>;

type RuntimeAuthFailureReportOutboxDrainScheduler = (input: Readonly<{
  outboxDir?: string;
}>) => void;

export type ConnectedServiceRuntimeAuthFailureDaemonReport = Readonly<{
  handled: boolean;
  report: unknown | null;
  statusCode: string | null;
  statusMessage: string | null;
  ok?: unknown;
  result?: unknown;
  errorCode?: unknown;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  uxDiagnostic?: ConnectedServiceRuntimeAuthRecoveryProjection['uxDiagnostic'];
  projection?: ConnectedServiceRuntimeAuthRecoveryProjection;
}>;

export const CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS = 120_000;

// Incident Jun-11 H-C / FIX-2: one failed turn can be observed by multiple independent
// triggers, each of which calls this shared report path. Dedupe lives HERE — the single
// owner in front of the daemon — keyed on STABLE identity only (no Date.now-derived
// retryAfterMs), with a short TTL window. Concurrent duplicates coalesce onto the
// in-flight daemon call.
const RUNTIME_AUTH_FAILURE_REPORT_DEDUPE_WINDOW_MS = 15_000;

type RuntimeAuthFailureReportDedupeEntry = Readonly<{
  reportedAtMs: number;
  result: Promise<ConnectedServiceRuntimeAuthFailureDaemonReport>;
}>;

const recentRuntimeAuthFailureReportsByStableKey = new Map<string, RuntimeAuthFailureReportDedupeEntry>();

export function resetConnectedServiceRuntimeAuthFailureReportDedupeForTests(): void {
  recentRuntimeAuthFailureReportsByStableKey.clear();
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  const parsed = SessionUsageLimitRecoveryResumePromptModeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Stable failure fingerprint: identity + failure kind + provider-declared reset horizon
// (bucketed to absorb parse jitter). Volatile per-trigger fields (`retryAfterMs`,
// `statusMessage`, rate-limit telemetry) are deliberately excluded — they are recomputed
// from Date.now() per trigger and would make every key unique.
function buildStableRuntimeAuthFailureReportDedupeKey(input: Readonly<{
  sessionId: string;
  switchesThisTurn: number;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  classification: unknown;
}>): string | null {
  const classification = sanitizeConnectedServiceRuntimeFailureClassification(input.classification);
  if (!classification) return null;
  const resetsAtMsBucket = typeof classification.resetsAtMs === 'number' && Number.isFinite(classification.resetsAtMs)
    ? Math.floor(classification.resetsAtMs / 60_000)
    : null;
  return JSON.stringify({
    sessionId: input.sessionId,
    switchesThisTurn: input.switchesThisTurn,
    kind: classification.kind ?? null,
    serviceId: classification.serviceId ?? null,
    profileId: classification.profileId ?? null,
    groupId: classification.groupId ?? null,
    limitCategory: classification.limitCategory ?? null,
    providerLimitId: classification.providerLimitId ?? null,
    sourceProviderAccountId: classification.sourceProviderAccountId ?? null,
    failingAccessTokenFingerprint: classification.failingAccessTokenFingerprint ?? null,
    groupGeneration: classification.groupGeneration ?? null,
    recoveryActionKind: classification.recoveryAction?.kind ?? null,
    resumePromptMode: input.resumePromptMode ?? null,
    resetsAtMsBucket,
  });
}

function pruneStaleRuntimeAuthFailureReportDedupeEntries(nowMs: number): void {
  for (const [key, entry] of recentRuntimeAuthFailureReportsByStableKey.entries()) {
    if (nowMs - entry.reportedAtMs > RUNTIME_AUTH_FAILURE_REPORT_DEDUPE_WINDOW_MS) {
      recentRuntimeAuthFailureReportsByStableKey.delete(key);
    }
  }
}

export async function reportConnectedServiceRuntimeAuthFailureToDaemon(input: Readonly<{
  sessionId: string;
  switchesThisTurn?: number;
  resumePromptMode?: unknown;
  classification: unknown;
  notify?: RuntimeAuthFailureNotify;
  logger?: RuntimeAuthFailureLogger;
  logPrefix?: string;
  reportOutboxDir?: string;
  scheduleOutboxDrain?: RuntimeAuthFailureReportOutboxDrainScheduler;
  nowMs?: () => number;
}>): Promise<ConnectedServiceRuntimeAuthFailureDaemonReport> {
  const notify = input.notify ?? notifyDaemonConnectedServiceRuntimeAuthFailure;
  const logger = input.logger ?? defaultLogger;
  const logPrefix = input.logPrefix ?? '[connected-services]';
  const scheduleOutboxDrain = input.scheduleOutboxDrain ?? ((args: Readonly<{ outboxDir?: string }>) => {
    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      ...(args.outboxDir ? { outboxDir: args.outboxDir } : {}),
      logger,
      logPrefix,
    });
  });
  const resumePromptMode = readResumePromptMode(input.resumePromptMode);
  const sanitizedClassification = sanitizeConnectedServiceRuntimeFailureClassification(input.classification);
  if (!sanitizedClassification) {
    logger.debug(`${logPrefix} Dropped connected-service runtime auth failure report with malformed classification`);
    return {
      handled: false,
      report: null,
      statusCode: null,
      statusMessage: null,
      ...(resumePromptMode ? { resumePromptMode } : {}),
    };
  }
  const reportBody: RuntimeAuthFailureNotifyBody = {
    sessionId: input.sessionId,
    switchesThisTurn: input.switchesThisTurn ?? 0,
    ...(resumePromptMode ? { resumePromptMode } : {}),
    classification: sanitizedClassification,
  };

  async function enqueueOutboxBestEffort(): Promise<void> {
    try {
      const result = await enqueueRuntimeAuthFailureReportOutboxItem({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        report: reportBody,
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
      });
      if (result.status === 'enqueued' && result.enqueue === 'accepted') {
        scheduleOutboxDrain({
          ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        });
      }
    } catch (error) {
      logger.debug(`${logPrefix} Failed to enqueue connected-service runtime auth failure report outbox item (non-fatal)`, error);
    }
  }

  async function removeOutboxBestEffort(): Promise<void> {
    const reportKey = resolveRuntimeAuthFailureReportOutboxKey(reportBody);
    if (!reportKey) return;
    try {
      await removeRuntimeAuthFailureReportOutboxItem({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        reportKey,
      });
    } catch (error) {
      logger.debug(`${logPrefix} Failed to remove connected-service runtime auth failure report outbox item (non-fatal)`, error);
    }
  }

  async function performReport(): Promise<ConnectedServiceRuntimeAuthFailureDaemonReport> {
    try {
      const report = await notify(reportBody, {
        timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
      });
      const statusNote = resolveConnectedServiceRuntimeAuthFailureStatusMessage(report);
      const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
        report,
        statusNote,
      });
      if (projection.handled) {
        await removeOutboxBestEffort();
      } else if (isRetryableConnectedServiceRuntimeAuthFailureReportDelivery(report)) {
        await enqueueOutboxBestEffort();
      }
      const reportRecord = readRecord(report);
      return {
        handled: projection.handled,
        report,
        statusCode: projection.statusCode,
        statusMessage: projection.statusMessage,
        ...(Object.prototype.hasOwnProperty.call(reportRecord ?? {}, 'ok') ? { ok: reportRecord?.ok } : {}),
        ...(Object.prototype.hasOwnProperty.call(reportRecord ?? {}, 'result') ? { result: reportRecord?.result } : {}),
        ...(Object.prototype.hasOwnProperty.call(reportRecord ?? {}, 'errorCode') ? { errorCode: reportRecord?.errorCode } : {}),
        ...(resumePromptMode ? { resumePromptMode } : {}),
        ...(projection.uxDiagnostic ? { uxDiagnostic: projection.uxDiagnostic } : {}),
        projection,
      };
    } catch (error) {
      await enqueueOutboxBestEffort();
      logger.debug(`${logPrefix} Failed to report connected-service runtime auth failure to daemon (non-fatal)`, error);
      return {
        handled: false,
        report: null,
        statusCode: null,
        statusMessage: null,
        ...(resumePromptMode ? { resumePromptMode } : {}),
      };
    }
  }

  const nowMs = (input.nowMs ?? Date.now)();
  const dedupeKey = buildStableRuntimeAuthFailureReportDedupeKey({
    sessionId: input.sessionId,
    switchesThisTurn: input.switchesThisTurn ?? 0,
    ...(resumePromptMode ? { resumePromptMode } : {}),
    classification: sanitizedClassification,
  });
  if (!dedupeKey) {
    return await performReport();
  }
  pruneStaleRuntimeAuthFailureReportDedupeEntries(nowMs);
  const recent = recentRuntimeAuthFailureReportsByStableKey.get(dedupeKey);
  if (recent && nowMs - recent.reportedAtMs <= RUNTIME_AUTH_FAILURE_REPORT_DEDUPE_WINDOW_MS) {
    logger.debug(`${logPrefix} Suppressed duplicate connected-service runtime auth failure report (stable-key dedupe)`);
    return await recent.result;
  }
  const result = performReport();
  recentRuntimeAuthFailureReportsByStableKey.set(dedupeKey, {
    reportedAtMs: nowMs,
    result,
  });
  // A FAILED delivery (notify threw → report:null) must not hold the window: concurrent
  // duplicates coalesce onto the in-flight call, but once it settles unreported the next
  // trigger is a legitimate retry (the outbox replay/clear flow depends on it).
  void result.then((report) => {
    if (report.report !== null) return;
    const current = recentRuntimeAuthFailureReportsByStableKey.get(dedupeKey);
    if (current?.result === result) {
      recentRuntimeAuthFailureReportsByStableKey.delete(dedupeKey);
    }
  });
  return await result;
}
