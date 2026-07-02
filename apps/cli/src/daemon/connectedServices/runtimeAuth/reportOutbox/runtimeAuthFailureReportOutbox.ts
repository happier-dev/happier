import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readConnectedServiceLimitCategoryV1,
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  type SessionUsageLimitRecoveryResumePromptModeV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  ConnectedServiceRuntimeAuthFailureKindSchema,
  type ConnectedServiceRuntimeAuthFailureKind,
  type ConnectedServiceRuntimeLimitCategory,
  type ConnectedServiceRuntimeQuotaScope,
} from '../types';
import type {
  DrainRuntimeAuthFailureReportOutboxItemResult,
  DrainRuntimeAuthFailureReportOutboxItemsResult,
  EnqueueRuntimeAuthFailureReportOutboxItemResult,
  RuntimeAuthFailureReportOutboxAction,
  RuntimeAuthFailureReportOutboxClassification,
  RuntimeAuthFailureReportOutboxItem,
  RuntimeAuthFailureReportOutboxRecoveryAction,
  RuntimeAuthFailureReportOutboxReport,
} from './runtimeAuthFailureReportOutboxTypes';

const OUTBOX_SCHEMA_VERSION = 1;
const OUTBOX_DIR_BASENAME = 'connected-service-runtime-auth-report-outbox';
const QUARANTINE_DIR_BASENAME = 'quarantine';
const SAFE_STRING_MAX_LENGTH = 512;
const SAFE_ACTION_URL_MAX_LENGTH = 2_048;

const QUOTA_SCOPES = new Set<ConnectedServiceRuntimeQuotaScope>([
  'account',
  'workspace',
  'organization',
  'model',
  'provider',
  'unknown',
]);

const SOURCES = new Set<RuntimeAuthFailureReportOutboxClassification['source']>([
  'structured_provider_error',
  'stable_provider_message',
  'provider_runtime_marker',
]);

const SECRETISH_VALUE_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|bearer|secret|password|credential)\b/i;

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

function readSafeProviderString(value: unknown): string | null {
  const normalized = readBoundedString(value);
  if (!normalized || SECRETISH_VALUE_PATTERN.test(normalized)) return null;
  return normalized;
}

function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return readBoundedString(value);
}

function readNullableSafeProviderString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return readSafeProviderString(value);
}

function readNullableTimestampMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

function readNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function readKind(value: unknown): ConnectedServiceRuntimeAuthFailureKind | null {
  const parsed = ConnectedServiceRuntimeAuthFailureKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readLimitCategory(value: unknown): ConnectedServiceRuntimeLimitCategory | undefined {
  return readConnectedServiceLimitCategoryV1(value) ?? undefined;
}

function readQuotaScope(value: unknown): ConnectedServiceRuntimeQuotaScope | undefined {
  return typeof value === 'string' && QUOTA_SCOPES.has(value as ConnectedServiceRuntimeQuotaScope)
    ? value as ConnectedServiceRuntimeQuotaScope
    : undefined;
}

function readSource(value: unknown): RuntimeAuthFailureReportOutboxClassification['source'] | null {
  return typeof value === 'string' && SOURCES.has(value as RuntimeAuthFailureReportOutboxClassification['source'])
    ? value as RuntimeAuthFailureReportOutboxClassification['source']
    : null;
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  const parsed = SessionUsageLimitRecoveryResumePromptModeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readSafeAction(value: unknown): RuntimeAuthFailureReportOutboxAction | null {
  if (!isRecord(value) || value.kind !== 'open_url') return null;
  const rawUrl = readBoundedString(value.url, SAFE_ACTION_URL_MAX_LENGTH);
  if (!rawUrl || SECRETISH_VALUE_PATTERN.test(rawUrl)) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return { kind: 'open_url', url: parsed.toString() };
}

function readRecoveryAction(value: unknown): RuntimeAuthFailureReportOutboxRecoveryAction | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'provider_state_sharing_required') return { kind: 'provider_state_sharing_required' };
  if (value.kind === 'quota_recovery_required') return { kind: 'quota_recovery_required' };
  return null;
}

function sanitizeClassification(value: unknown): RuntimeAuthFailureReportOutboxClassification | null {
  if (!isRecord(value)) return null;
  const kind = readKind(value.kind);
  const serviceId = readBoundedString(value.serviceId);
  const source = readSource(value.source);
  if (!kind || !serviceId || !source) return null;

  const limitCategory = readLimitCategory(value.limitCategory);
  const retryAfterMs = readNullableTimestampMs(value.retryAfterMs);
  const quotaScope = readQuotaScope(value.quotaScope);
  const providerLimitId = readNullableSafeProviderString(value.providerLimitId);
  const action = readSafeAction(value.action);
  const recoveryAction = readRecoveryAction(value.recoveryAction);

  return {
    kind,
    ...(limitCategory ? { limitCategory } : {}),
    serviceId,
    profileId: readNullableString(value.profileId),
    groupId: readNullableString(value.groupId),
    resetsAtMs: readNullableTimestampMs(value.resetsAtMs),
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(quotaScope ? { quotaScope } : {}),
    ...(value.providerLimitId === undefined ? {} : { providerLimitId }),
    ...(value.action === undefined ? {} : { action }),
    planType: readNullableSafeProviderString(value.planType),
    rateLimits: null,
    source,
    ...(value.recoveryAction === undefined ? {} : { recoveryAction }),
  };
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
    action: input.classification.action ?? null,
    recoveryAction: input.classification.recoveryAction ?? null,
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
  return { status: 'enqueued', item };
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
