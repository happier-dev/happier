import { randomUUID } from 'node:crypto';

import {
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  type SessionUsageLimitRecoveryResumePromptModeV1,
} from '@happier-dev/protocol';
import { notifyDaemonConnectedServiceRuntimeAuthFailure } from '@/daemon/controlClient';
import { logger as defaultLogger } from '@/ui/logger';
import {
  resolveConnectedServiceRuntimeAuthFailureStatusMessage,
} from './resolveConnectedServiceRuntimeAuthFailureStatusMessage';
import {
  normalizeConnectedServiceRuntimeAuthRecoveryProjection,
  type ConnectedServiceRuntimeAuthRecoveryProjection,
} from './projection/connectedServiceRuntimeAuthRecoveryProjection';
import { buildStableRuntimeAuthFailureReportDedupeKey } from './runtimeAuthFailureReportIdentity';
import {
  enqueueRuntimeAuthFailureReportOutboxItem,
  removeRuntimeAuthFailureReportOutboxItem,
  resolveRuntimeAuthFailureReportOutboxKey,
} from './reportOutbox/runtimeAuthFailureReportOutbox';
import { scheduleRuntimeAuthFailureReportOutboxDrainToDaemon } from './reportOutbox/runtimeAuthFailureReportOutboxDrainScheduler';
import type { RuntimeAuthFailureReportOutboxItem } from './reportOutbox/runtimeAuthFailureReportOutboxTypes';
import { resolveRuntimeAuthFailureReportOutboxDelivery } from './reportOutbox/resolveRuntimeAuthFailureReportOutboxDelivery';

type RuntimeAuthFailureNotifyBody = Readonly<{
  reportId: string;
  sessionId: string;
  switchesThisTurn?: number;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  classification: unknown;
}>;

type RuntimeAuthFailureNotifyOptions = Readonly<{
  timeoutMs?: number | null;
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
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  uxDiagnostic?: ConnectedServiceRuntimeAuthRecoveryProjection['uxDiagnostic'];
  projection?: ConnectedServiceRuntimeAuthRecoveryProjection;
  recoveryReceipt?: Readonly<{
    reportId: string;
    attemptId: string;
    transition: string;
    eventLocalId: string;
  }>;
}>;

// The local daemon owns recovery after the report is durably staged. A fixed
// caller deadline can only manufacture an ambiguous failure while healthy
// multi-session fan-out continues; process exit/caller cancellation still
// settles the underlying local transport.
export const CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS = null;

// Incident Jun-11 H-C / FIX-2: one failed turn is observed by multiple independent triggers
// (e.g. Claude's StopFailure hook, the SDK inbound loop, and the bridge transcript observer),
// each of which calls this shared report path. Dedupe lives HERE — the single owner in front
// of the daemon — keyed on STABLE identity only (no Date.now-derived retryAfterMs), with a
// short TTL window. Concurrent duplicates coalesce onto the in-flight daemon call.
const RUNTIME_AUTH_FAILURE_REPORT_DEDUPE_WINDOW_MS = 15_000;

type RuntimeAuthFailureReportDedupeEntry = Readonly<{
  reportedAtMs: number;
  result: Promise<ConnectedServiceRuntimeAuthFailureDaemonReport>;
}>;

const recentRuntimeAuthFailureReportsByStableKey = new Map<string, RuntimeAuthFailureReportDedupeEntry>();

export function resetConnectedServiceRuntimeAuthFailureReportDedupeForTests(): void {
  recentRuntimeAuthFailureReportsByStableKey.clear();
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  const parsed = SessionUsageLimitRecoveryResumePromptModeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readRecoveryReceipt(value: unknown): ConnectedServiceRuntimeAuthFailureDaemonReport['recoveryReceipt'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const readBounded = (candidate: unknown, maxLength: number): string | null => {
    const normalized = typeof candidate === 'string' ? candidate.trim() : '';
    return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
  };
  const reportId = readBounded(record.reportId, 256);
  const attemptId = readBounded(record.attemptId, 256);
  const transition = readBounded(record.transition, 64);
  const eventLocalId = readBounded(record.eventLocalId, 256);
  if (!reportId || !attemptId || !transition || !eventLocalId) return null;
  return { reportId, attemptId, transition, eventLocalId };
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
  createReportId?: () => string;
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
  const reportIdCandidate = input.createReportId?.() ?? `runtime-auth-report:${randomUUID()}`;
  const reportId = reportIdCandidate.startsWith('runtime-auth-report:') && reportIdCandidate.length <= 256
    ? reportIdCandidate
    : `runtime-auth-report:${randomUUID()}`;
  let reportBody: RuntimeAuthFailureNotifyBody = {
    reportId,
    sessionId: input.sessionId,
    switchesThisTurn: input.switchesThisTurn ?? 0,
    ...(resumePromptMode ? { resumePromptMode } : {}),
    classification: input.classification,
  };

  async function enqueueOutboxBestEffort(options: Readonly<{
    scheduleDrain: boolean;
    incrementAttemptCount?: boolean;
  }>): Promise<RuntimeAuthFailureReportOutboxItem | null> {
    try {
      const result = await enqueueRuntimeAuthFailureReportOutboxItem({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        report: reportBody,
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
        incrementAttemptCount: options.incrementAttemptCount,
      });
      if (result.status === 'enqueued' && options.scheduleDrain) {
        scheduleOutboxDrain({
          ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        });
      }
      return result.status === 'enqueued' ? result.item : null;
    } catch (error) {
      logger.debug(`${logPrefix} Failed to enqueue connected-service runtime auth failure report outbox item (non-fatal)`, error);
      return null;
    }
  }

  async function removeOutboxBestEffort(expectedItem: RuntimeAuthFailureReportOutboxItem): Promise<void> {
    const reportKey = resolveRuntimeAuthFailureReportOutboxKey(reportBody);
    if (!reportKey) return;
    try {
      await removeRuntimeAuthFailureReportOutboxItem({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        reportKey,
        expectedItem,
      });
    } catch (error) {
      logger.debug(`${logPrefix} Failed to remove connected-service runtime auth failure report outbox item (non-fatal)`, error);
    }
  }

  async function retainOutboxBestEffort(stagedItem: RuntimeAuthFailureReportOutboxItem | null): Promise<void> {
    if (stagedItem) {
      scheduleOutboxDrain({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
      });
      return;
    }
    await enqueueOutboxBestEffort({ scheduleDrain: true, incrementAttemptCount: false });
  }

  async function performReport(): Promise<ConnectedServiceRuntimeAuthFailureDaemonReport> {
    // Queue before delivery so a client timeout/crash after daemon claim cannot mint a second id.
    // Successful direct delivery removes the staged item; failed/ambiguous delivery schedules drain.
    const stagedItem = await enqueueOutboxBestEffort({ scheduleDrain: false });
    if (stagedItem) {
      reportBody = {
        ...reportBody,
        reportId: stagedItem.reportId,
      };
    }
    try {
      const report = await notify(reportBody, {
        timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
      });
      const statusNote = resolveConnectedServiceRuntimeAuthFailureStatusMessage(report);
      const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
        report,
        statusNote,
      });
      const recoveryReceipt = readRecoveryReceipt(
        report && typeof report === 'object' && !Array.isArray(report)
          ? (report as Readonly<Record<string, unknown>>).recoveryReceipt
          : null,
      );
      const durableResumePromptMode = readResumePromptMode(
        report && typeof report === 'object' && !Array.isArray(report)
          ? (report as Readonly<Record<string, unknown>>).resumePromptMode
          : null,
      ) ?? resumePromptMode;
      const deliveryDisposition = stagedItem
        ? resolveRuntimeAuthFailureReportOutboxDelivery({
            expectedReportId: stagedItem.reportId,
            response: report,
          })
        : 'retry';
      if ((deliveryDisposition === 'delivered' || deliveryDisposition === 'drop') && stagedItem) {
        await removeOutboxBestEffort(stagedItem);
      } else {
        await retainOutboxBestEffort(stagedItem);
      }
      return {
        handled: projection.handled,
        report,
        statusCode: projection.statusCode,
        statusMessage: projection.statusMessage,
        ...(durableResumePromptMode ? { resumePromptMode: durableResumePromptMode } : {}),
        ...(projection.uxDiagnostic ? { uxDiagnostic: projection.uxDiagnostic } : {}),
        projection,
        ...(recoveryReceipt ? { recoveryReceipt } : {}),
      };
    } catch (error) {
      await enqueueOutboxBestEffort({ scheduleDrain: true, incrementAttemptCount: false });
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
	  const stableDedupeKey = buildStableRuntimeAuthFailureReportDedupeKey({
	    sessionId: input.sessionId,
	    switchesThisTurn: input.switchesThisTurn ?? 0,
	    resumePromptMode,
	    classification: input.classification,
	  });
  if (!stableDedupeKey) {
    return await performReport();
  }
  const dedupeKey = stableDedupeKey;
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
