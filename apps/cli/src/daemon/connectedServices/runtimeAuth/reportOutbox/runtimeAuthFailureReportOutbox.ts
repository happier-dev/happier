import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  type SessionUsageLimitRecoveryResumePromptModeV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { sanitizeConnectedServiceRuntimeFailureClassification } from '../sanitizeConnectedServiceRuntimeFailureClassification';
import { readStableRuntimeAuthFailureClassificationIdentity } from '../runtimeAuthFailureReportIdentity';
import type {
  DrainRuntimeAuthFailureReportOutboxItemResult,
  DrainRuntimeAuthFailureReportOutboxItemsResult,
  EnqueueRuntimeAuthFailureReportOutboxItemResult,
  RuntimeAuthFailureReportOutboxClassification,
  RuntimeAuthFailureReportOutboxItem,
  RuntimeAuthFailureReportOutboxReport,
} from './runtimeAuthFailureReportOutboxTypes';
import { withRuntimeAuthFailureReportOutboxFileLock } from './runtimeAuthFailureReportOutboxFileLock';

const OUTBOX_SCHEMA_VERSION = 1;
const OUTBOX_DIR_BASENAME = 'connected-service-runtime-auth-report-outbox';
const QUARANTINE_DIR_BASENAME = 'quarantine';
const SAFE_STRING_MAX_LENGTH = 512;
const REPORT_ID_MAX_LENGTH = 256;
export const DEFAULT_RUNTIME_AUTH_FAILURE_REPORT_OUTBOX_TTL_MS = 24 * 60 * 60_000;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function readBoundedString(value: unknown, maxLength = SAFE_STRING_MAX_LENGTH): string | null {
  const normalized = readNonEmptyString(value);
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function readNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  const parsed = SessionUsageLimitRecoveryResumePromptModeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function sanitizeClassification(value: unknown): RuntimeAuthFailureReportOutboxClassification | null {
  const classification = sanitizeConnectedServiceRuntimeFailureClassification(value);
  return classification ? { ...classification, rateLimits: null } : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function buildReportKey(input: Readonly<{
  sessionId: string;
  classification: RuntimeAuthFailureReportOutboxClassification;
}>): string {
  const classificationIdentity = readStableRuntimeAuthFailureClassificationIdentity(input.classification);
  if (!classificationIdentity) throw new Error('invalid_runtime_auth_failure_report_identity');
  const fingerprint = {
    sessionId: input.sessionId,
    ...classificationIdentity,
    action: input.classification.action ?? null,
    recoveryAction: input.classification.recoveryAction ?? null,
    source: input.classification.source,
  };
  return `runtime-auth-failure-report:v1:${hashText(stableStringify(fingerprint))}`;
}

function buildFileId(reportKey: string): string {
  return `report-${hashText(reportKey).slice(0, 32)}`;
}

function buildRuntimeAuthFailureReportId(): string {
  return `runtime-auth-report:${randomUUID()}`;
}

function readReportId(value: unknown): string | null {
  const reportId = readBoundedString(value, REPORT_ID_MAX_LENGTH);
  return reportId?.startsWith('runtime-auth-report:') ? reportId : null;
}

function sanitizeReport(report: RuntimeAuthFailureReportOutboxReport): RuntimeAuthFailureReportOutboxItem | null {
  const sessionId = readBoundedString(report.sessionId);
  const classification = sanitizeClassification(report.classification);
  if (!sessionId || !classification) return null;
  const reportKey = buildReportKey({
    sessionId,
    classification,
  });
  const reportId = readReportId(report.reportId) ?? buildRuntimeAuthFailureReportId();
  const resumePromptMode = readResumePromptMode(report.resumePromptMode);
  return {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    fileId: buildFileId(reportKey),
    reportKey,
    reportId,
    sessionId,
    switchesThisTurn: readNonNegativeInt(report.switchesThisTurn, 0),
    ...(resumePromptMode ? { resumePromptMode } : {}),
    classification,
    attemptCount: 1,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function nowFrom(input: Readonly<{ nowMs?: () => number }>): number {
  const value = input.nowMs ? input.nowMs() : Date.now();
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : Date.now();
}

function resolveOutboxDir(input: Readonly<{ outboxDir?: string }>): string {
  return input.outboxDir ?? resolveRuntimeAuthFailureReportOutboxDir();
}

function itemPath(outboxDir: string, fileId: string): string {
  return join(outboxDir, `${fileId}.json`);
}

function normalizePersistedItem(value: unknown): RuntimeAuthFailureReportOutboxItem | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== OUTBOX_SCHEMA_VERSION) return null;
  const fileId = readBoundedString(value.fileId);
  const reportKey = readBoundedString(value.reportKey);
  const reportId = readReportId(value.reportId)
    ?? (reportKey ? `runtime-auth-report:legacy:${hashText(reportKey)}` : null);
  const sessionId = readBoundedString(value.sessionId);
  const classification = sanitizeClassification(value.classification);
  if (!fileId || !fileId.startsWith('report-') || !reportKey || !reportId || !sessionId || !classification) return null;
  const resumePromptMode = readResumePromptMode(value.resumePromptMode);
  return {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    fileId,
    reportKey,
    reportId,
    sessionId,
    switchesThisTurn: readNonNegativeInt(value.switchesThisTurn, 0),
    ...(resumePromptMode ? { resumePromptMode } : {}),
    classification,
    attemptCount: Math.max(1, readNonNegativeInt(value.attemptCount, 1)),
    createdAtMs: readNonNegativeInt(value.createdAtMs, 0),
    updatedAtMs: readNonNegativeInt(value.updatedAtMs, 0),
  };
}

async function readExistingItem(outboxDir: string, fileId: string): Promise<RuntimeAuthFailureReportOutboxItem | null> {
  try {
    const parsed = JSON.parse(await readFile(itemPath(outboxDir, fileId), 'utf8')) as unknown;
    return normalizePersistedItem(parsed);
  } catch {
    return null;
  }
}

async function quarantineInvalidJson(outboxDir: string, entry: string): Promise<void> {
  const sourcePath = join(outboxDir, entry);
  const quarantineDir = join(outboxDir, QUARANTINE_DIR_BASENAME);
  await mkdir(quarantineDir, { recursive: true });
  const targetPath = join(quarantineDir, `${entry}.invalid-${Date.now()}`);
  try {
    await rename(sourcePath, targetPath);
  } catch {
    await unlink(sourcePath).catch(() => {});
  }
}

async function readOutboxEntries(outboxDir: string): Promise<string[]> {
  try {
    return await readdir(outboxDir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return [];
    throw error;
  }
}

export function resolveRuntimeAuthFailureReportOutboxDir(): string {
  return join(configuration.activeServerDir, OUTBOX_DIR_BASENAME);
}

export async function enqueueRuntimeAuthFailureReportOutboxItem(input: Readonly<{
  outboxDir?: string;
  report: RuntimeAuthFailureReportOutboxReport;
  nowMs?: () => number;
  incrementAttemptCount?: boolean;
}>): Promise<EnqueueRuntimeAuthFailureReportOutboxItemResult> {
  const sanitized = sanitizeReport(input.report);
  if (!sanitized) return { status: 'rejected', reason: 'unclassified_report' };

  const outboxDir = resolveOutboxDir(input);
  const timestampMs = nowFrom(input);
  await mkdir(outboxDir, { recursive: true });
  const path = itemPath(outboxDir, sanitized.fileId);
  return await withRuntimeAuthFailureReportOutboxFileLock(path, async () => {
    const existing = await readExistingItem(outboxDir, sanitized.fileId);
    const existingIsFresh = existing !== null
      && timestampMs - existing.updatedAtMs <= DEFAULT_RUNTIME_AUTH_FAILURE_REPORT_OUTBOX_TTL_MS;
    const canReuseExisting = existingIsFresh;
    const item: RuntimeAuthFailureReportOutboxItem = {
      ...sanitized,
      reportId: canReuseExisting ? existing.reportId : sanitized.reportId,
      switchesThisTurn: sanitized.switchesThisTurn,
      attemptCount: (canReuseExisting ? existing.attemptCount : 0)
        + (input.incrementAttemptCount === false && canReuseExisting ? 0 : 1),
      createdAtMs: canReuseExisting ? existing.createdAtMs : timestampMs,
      updatedAtMs: timestampMs,
    };
    await writeJsonAtomic(path, item);
    return { status: 'enqueued', item };
  });
}

export async function readRuntimeAuthFailureReportOutboxItems(input: Readonly<{
  outboxDir?: string;
}> = {}): Promise<RuntimeAuthFailureReportOutboxItem[]> {
  const outboxDir = resolveOutboxDir(input);
  const entries = await readOutboxEntries(outboxDir);
  const items: RuntimeAuthFailureReportOutboxItem[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = join(outboxDir, entry);
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      const item = normalizePersistedItem(parsed);
      if (item) {
        items.push(item);
        continue;
      }
    } catch {
      // handled below
    }
    await quarantineInvalidJson(outboxDir, entry);
  }
  return items.sort((left, right) => left.createdAtMs - right.createdAtMs || left.reportKey.localeCompare(right.reportKey));
}

export async function removeRuntimeAuthFailureReportOutboxItem(input: Readonly<{
  outboxDir?: string;
  reportKey: string;
  expectedItem?: RuntimeAuthFailureReportOutboxItem;
}>): Promise<void> {
  const reportKey = readBoundedString(input.reportKey);
  if (!reportKey) return;
  const outboxDir = resolveOutboxDir(input);
  const fileId = buildFileId(reportKey);
  const path = itemPath(outboxDir, fileId);
  await withRuntimeAuthFailureReportOutboxFileLock(path, async () => {
    if (input.expectedItem) {
      const current = await readExistingItem(outboxDir, fileId);
      if (!current || stableStringify(current) !== stableStringify(input.expectedItem)) return;
    }
    await unlink(path).catch((error) => {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') throw error;
    });
  });
}

export async function removeRuntimeAuthFailureReportOutboxItemsForSession(input: Readonly<{
  outboxDir?: string;
  sessionId: string;
}>): Promise<void> {
  const sessionId = readBoundedString(input.sessionId);
  if (!sessionId) return;
  const items = await readRuntimeAuthFailureReportOutboxItems({
    ...(input.outboxDir ? { outboxDir: input.outboxDir } : {}),
  });
  await Promise.all(items
    .filter((item) => item.sessionId === sessionId)
    .map(async (item) => {
      await removeRuntimeAuthFailureReportOutboxItem({
        ...(input.outboxDir ? { outboxDir: input.outboxDir } : {}),
        reportKey: item.reportKey,
        expectedItem: item,
      });
    }));
}

export function resolveRuntimeAuthFailureReportOutboxKey(report: RuntimeAuthFailureReportOutboxReport): string | null {
  const sanitized = sanitizeReport(report);
  return sanitized?.reportKey ?? null;
}

// RD-REC-6 / P3: reports not (re-)observed within this window are dead-lettered at
// drain time instead of redelivering at every daemon start forever. `updatedAtMs`
// is the freshness anchor: re-enqueueing the same report key refreshes it.
export async function drainRuntimeAuthFailureReportOutboxItems(input: Readonly<{
  outboxDir?: string;
  deliver: (item: RuntimeAuthFailureReportOutboxItem) => Promise<DrainRuntimeAuthFailureReportOutboxItemResult>;
  limit?: number;
  nowMs?: () => number;
  maxItemAgeMs?: number;
}>): Promise<DrainRuntimeAuthFailureReportOutboxItemsResult> {
  const items = await readRuntimeAuthFailureReportOutboxItems({
    ...(input.outboxDir ? { outboxDir: input.outboxDir } : {}),
  });
  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
    ? Math.max(0, Math.trunc(input.limit))
    : items.length;
  const nowMs = input.nowMs ?? (() => Date.now());
  const maxItemAgeMs = typeof input.maxItemAgeMs === 'number' && Number.isFinite(input.maxItemAgeMs) && input.maxItemAgeMs > 0
    ? Math.trunc(input.maxItemAgeMs)
    : DEFAULT_RUNTIME_AUTH_FAILURE_REPORT_OUTBOX_TTL_MS;
  let delivered = 0;
  let dropped = 0;
  let retried = 0;

  for (const item of items.slice(0, limit)) {
    let result: DrainRuntimeAuthFailureReportOutboxItemResult;
    if (nowMs() - item.updatedAtMs > maxItemAgeMs) {
      result = { status: 'drop' };
    } else {
      try {
        result = await input.deliver(item);
      } catch {
        retried += 1;
        continue;
      }
    }

    if (result.status === 'delivered' || result.status === 'drop') {
      await removeRuntimeAuthFailureReportOutboxItem({
        ...(input.outboxDir ? { outboxDir: input.outboxDir } : {}),
        reportKey: item.reportKey,
        expectedItem: item,
      });
      if (result.status === 'delivered') {
        delivered += 1;
      } else {
        dropped += 1;
      }
      continue;
    }

    retried += 1;
  }

  return { delivered, dropped, retried };
}
