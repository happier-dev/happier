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
import {
  enqueueRuntimeAuthFailureReportOutboxItem,
  readRuntimeAuthFailureReportOutboxItem,
  removeRuntimeAuthFailureReportOutboxItem,
  resolveRuntimeAuthFailureReportOutboxKey,
} from './reportOutbox/runtimeAuthFailureReportOutbox';
import type { RuntimeAuthFailureReportOutboxItem } from './reportOutbox/runtimeAuthFailureReportOutboxTypes';
import { scheduleRuntimeAuthFailureReportOutboxDrainToDaemon } from './reportOutbox/runtimeAuthFailureReportOutboxDrainScheduler';
import { resolveRuntimeAuthFailureReportOutboxDelivery } from './reportOutbox/resolveRuntimeAuthFailureReportOutboxDelivery';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './sanitizeConnectedServiceRuntimeFailureClassification';

type RuntimeAuthFailureNotifyBody = Readonly<{
  reportId: string;
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
  recoveryReceipt?: Readonly<{
    reportId: string;
    attemptId: string;
  }>;
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

function readRuntimeAuthRecoveryReceipt(value: unknown): Readonly<{
  reportId: string;
  attemptId: string;
}> | null {
  const record = readRecord(value);
  const reportId = record?.reportId;
  const attemptId = record?.attemptId;
  if (
    typeof reportId !== 'string'
    || reportId.length < 1
    || reportId.length > 256
    || typeof attemptId !== 'string'
    || attemptId.length < 1
    || attemptId.length > 256
  ) {
    return null;
  }
  return { reportId, attemptId };
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
  let reportBody: RuntimeAuthFailureNotifyBody = {
    reportId: input.createReportId?.() ?? `runtime-auth-report:${randomUUID()}`,
    sessionId: input.sessionId,
    switchesThisTurn: input.switchesThisTurn ?? 0,
    ...(resumePromptMode ? { resumePromptMode } : {}),
    classification: sanitizedClassification,
  };

  async function enqueueOutboxBestEffort(scheduleDrain: boolean): Promise<RuntimeAuthFailureReportOutboxItem | null> {
    try {
      const result = await enqueueRuntimeAuthFailureReportOutboxItem({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        report: reportBody,
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
      });
      if (result.status === 'enqueued' && scheduleDrain && result.enqueue === 'accepted') {
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

  async function readExpectedOutboxItemBestEffort(): Promise<RuntimeAuthFailureReportOutboxItem | null> {
    const reportKey = resolveRuntimeAuthFailureReportOutboxKey(reportBody);
    if (!reportKey) return null;
    try {
      return await readRuntimeAuthFailureReportOutboxItem({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        reportKey,
      });
    } catch (error) {
      logger.debug(`${logPrefix} Failed to snapshot connected-service runtime auth failure report outbox item (non-fatal)`, error);
      return null;
    }
  }

  async function removeOutboxBestEffort(expectedItem: RuntimeAuthFailureReportOutboxItem | null): Promise<void> {
    if (!expectedItem) return;
    try {
      await removeRuntimeAuthFailureReportOutboxItem({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        reportKey: expectedItem.reportKey,
        expectedItem,
      });
    } catch (error) {
      logger.debug(`${logPrefix} Failed to remove connected-service runtime auth failure report outbox item (non-fatal)`, error);
    }
  }

  async function retainOutboxBestEffort(expectedItem: RuntimeAuthFailureReportOutboxItem | null): Promise<void> {
    if (expectedItem) {
      scheduleOutboxDrain({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
      });
      return;
    }
    await enqueueOutboxBestEffort(true);
  }

  async function performReport(): Promise<ConnectedServiceRuntimeAuthFailureDaemonReport> {
    const stagedItem = await enqueueOutboxBestEffort(false);
    if (stagedItem) {
      reportBody = { ...reportBody, reportId: stagedItem.reportId };
    }
    const expectedOutboxItem = stagedItem ?? await readExpectedOutboxItemBestEffort();
    try {
      const report = await notify(reportBody, {
        timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
      });
      const statusNote = resolveConnectedServiceRuntimeAuthFailureStatusMessage(report);
      const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
        report,
        statusNote,
      });
      const reportRecord = readRecord(report);
      const recoveryReceipt = readRuntimeAuthRecoveryReceipt(reportRecord?.recoveryReceipt);
      const deliveryDisposition = expectedOutboxItem
        ? resolveRuntimeAuthFailureReportOutboxDelivery({
            expectedReportId: expectedOutboxItem.reportId,
            response: report,
          })
        : 'retry';
      if (deliveryDisposition === 'delivered' || deliveryDisposition === 'drop') {
        await removeOutboxBestEffort(expectedOutboxItem);
      } else {
        await retainOutboxBestEffort(expectedOutboxItem);
      }
      return {
        handled: projection.handled,
        report,
        statusCode: projection.statusCode,
        statusMessage: projection.statusMessage,
        ...(Object.prototype.hasOwnProperty.call(reportRecord ?? {}, 'ok') ? { ok: reportRecord?.ok } : {}),
        ...(Object.prototype.hasOwnProperty.call(reportRecord ?? {}, 'result') ? { result: reportRecord?.result } : {}),
        ...(Object.prototype.hasOwnProperty.call(reportRecord ?? {}, 'errorCode') ? { errorCode: reportRecord?.errorCode } : {}),
        ...(recoveryReceipt ? { recoveryReceipt } : {}),
        ...(resumePromptMode ? { resumePromptMode } : {}),
        ...(projection.uxDiagnostic ? { uxDiagnostic: projection.uxDiagnostic } : {}),
        projection,
      };
    } catch (error) {
      if (stagedItem?.attemptCount === 1) {
        scheduleOutboxDrain({ ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}) });
      } else if (!expectedOutboxItem) {
        await retainOutboxBestEffort(null);
      }
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
    ...(resumePromptMode ? { resumePromptMode } : {}),
    classification: sanitizedClassification,
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
