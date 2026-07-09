import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionUsageLimitRecoveryResumePromptModeV1Schema, type SessionUsageLimitRecoveryResumePromptModeV1 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { sanitizeConnectedServiceRuntimeFailureClassification } from '../sanitizeConnectedServiceRuntimeFailureClassification';
import type {
  DrainRuntimeAuthFailureReportOutboxItemResult,
  DrainRuntimeAuthFailureReportOutboxItemsResult,
  EnqueueRuntimeAuthFailureReportOutboxItemResult,
  RuntimeAuthFailureReportOutboxClassification,
  RuntimeAuthFailureReportOutboxItem,
  RuntimeAuthFailureReportOutboxReport,
} from './runtimeAuthFailureReportOutboxTypes';

const OUTBOX_SCHEMA_VERSION = 1;
const OUTBOX_DIR_BASENAME = 'connected-service-runtime-auth-report-outbox';
const QUARANTINE_DIR_BASENAME = 'quarantine';
const SAFE_STRING_MAX_LENGTH = 512;

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
  return sanitizeConnectedServiceRuntimeFailureClassification(value);
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
  const fingerprint = {
    sessionId: input.sessionId,
    serviceId: input.classification.serviceId,
    profileId: input.classification.profileId,
    groupId: input.classification.groupId,
    kind: input.classification.kind,
    limitCategory: input.classification.limitCategory ?? null,
    resetsAtMs: input.classification.resetsAtMs,
    retryAfterMs: input.classification.retryAfterMs ?? null,
    quotaScope: input.classification.quotaScope ?? null,
    providerLimitId: input.classification.providerLimitId ?? null,
    sourceProviderAccountId: input.classification.sourceProviderAccountId ?? null,
    groupGeneration: input.classification.groupGeneration ?? null,
    action: input.classification.action ?? null,
    recoveryAction: input.classification.recoveryAction ?? null,
    connectedServiceRecovery: input.classification.connectedServiceRecovery ?? null,
    source: input.classification.source,
  };
  return `runtime-auth-failure-report:v1:${hashText(stableStringify(fingerprint))}`;
}

function buildFileId(reportKey: string): string {
  return `report-${hashText(reportKey).slice(0, 32)}`;
}

function sanitizeReport(report: RuntimeAuthFailureReportOutboxReport): RuntimeAuthFailureReportOutboxItem | null {
  const sessionId = readBoundedString(report.sessionId);
  const classification = sanitizeClassification(report.classification);
  if (!sessionId || !classification) return null;
  const resumePromptMode = readResumePromptMode(report.resumePromptMode);
  const reportKey = buildReportKey({ sessionId, classification });
  return {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    fileId: buildFileId(reportKey),
    reportKey,
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
  const sessionId = readBoundedString(value.sessionId);
  const classification = sanitizeClassification(value.classification);
  if (!fileId || !fileId.startsWith('report-') || !reportKey || !sessionId || !classification) return null;
  const resumePromptMode = readResumePromptMode(value.resumePromptMode);
  return {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    fileId,
    reportKey,
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
}>): Promise<EnqueueRuntimeAuthFailureReportOutboxItemResult> {
  const sanitized = sanitizeReport(input.report);
  if (!sanitized) return { status: 'rejected', reason: 'unclassified_report' };

  const outboxDir = resolveOutboxDir(input);
  const timestampMs = nowFrom(input);
  await mkdir(outboxDir, { recursive: true });
  const existing = await readExistingItem(outboxDir, sanitized.fileId);
  const item: RuntimeAuthFailureReportOutboxItem = {
    ...sanitized,
    switchesThisTurn: sanitized.switchesThisTurn,
    attemptCount: (existing?.attemptCount ?? 0) + 1,
    createdAtMs: existing?.createdAtMs ?? timestampMs,
    updatedAtMs: timestampMs,
  };
  await writeJsonAtomic(itemPath(outboxDir, item.fileId), item);
  return {
    status: 'enqueued',
    enqueue: existing ? 'coalesced' : 'accepted',
    item,
  };
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
}>): Promise<void> {
  const reportKey = readBoundedString(input.reportKey);
  if (!reportKey) return;
  const outboxDir = resolveOutboxDir(input);
  const fileId = buildFileId(reportKey);
  await unlink(itemPath(outboxDir, fileId)).catch((error) => {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') throw error;
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
      });
    }));
}

export function resolveRuntimeAuthFailureReportOutboxKey(report: RuntimeAuthFailureReportOutboxReport): string | null {
  const sanitized = sanitizeReport(report);
  return sanitized?.reportKey ?? null;
}

export async function drainRuntimeAuthFailureReportOutboxItems(input: Readonly<{
  outboxDir?: string;
  deliver: (item: RuntimeAuthFailureReportOutboxItem) => Promise<DrainRuntimeAuthFailureReportOutboxItemResult>;
  limit?: number;
}>): Promise<DrainRuntimeAuthFailureReportOutboxItemsResult> {
  const items = await readRuntimeAuthFailureReportOutboxItems({
    ...(input.outboxDir ? { outboxDir: input.outboxDir } : {}),
  });
  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
    ? Math.max(0, Math.trunc(input.limit))
    : items.length;
  let delivered = 0;
  let dropped = 0;
  let retried = 0;

  for (const item of items.slice(0, limit)) {
    let result: DrainRuntimeAuthFailureReportOutboxItemResult;
    try {
      result = await input.deliver(item);
    } catch {
      retried += 1;
      continue;
    }

    if (result.status === 'delivered' || result.status === 'drop') {
      await removeRuntimeAuthFailureReportOutboxItem({
        ...(input.outboxDir ? { outboxDir: input.outboxDir } : {}),
        reportKey: item.reportKey,
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
