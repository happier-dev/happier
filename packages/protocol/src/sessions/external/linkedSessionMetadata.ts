import { z } from 'zod';

import { RuntimeDescriptorV1Schema } from '../../sessionMetadata/runtimeDescriptorV1.js';
import { CODEX_BACKEND_MODES } from '../../providers/codex/backendMode.js';
import {
  ExternalSessionsProviderIdSchema,
  ExternalSessionsSourceSchema,
} from './sourceCatalog.js';
import type { ExternalSessionTranscriptRawMessageV1 } from './daemonRpcV1.js';

export type ExternalSessionFollowPolicy = 'attached_only' | 'background_follow';

export type ExternalSessionFollowPolicyV1 = Readonly<{
  v: 1;
  policy: ExternalSessionFollowPolicy;
  updatedAtMs?: number;
}>;

export type ExternalSessionAttentionV1 = Readonly<{
  observedProgressToken?: string;
  viewedProgressToken?: string;
  observedAtMs?: number;
  viewedAtMs?: number;
}>;

export type ExternalSessionObservedProgress = Readonly<{
  token: string;
  atMs: number;
}>;

const LinkedExternalSessionV1Schema = z
  .object({
    v: z.literal(1),
    providerId: ExternalSessionsProviderIdSchema,
    machineId: z.string().min(1),
    remoteSessionId: z.string().min(1),
    source: ExternalSessionsSourceSchema,
    linkedAtMs: z.number().int().min(0).optional(),
    lastKnownActivityAtMs: z.number().int().min(0).optional(),
    codexBackendMode: z.enum(CODEX_BACKEND_MODES).optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
  })
  .passthrough();

export type LinkedExternalSessionV1 = z.infer<typeof LinkedExternalSessionV1Schema>;

const LEGACY_LINKED_SESSION_METADATA_KEY = 'direct' + 'SessionV1';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readLinkedExternalSessionV1FromMetadata(metadata: unknown): LinkedExternalSessionV1 | null {
  const record = asRecord(metadata);
  if (!record) return null;

  const canonical = LinkedExternalSessionV1Schema.safeParse(record.externalSessionV1);
  if (canonical.success) return canonical.data;

  const legacy = LinkedExternalSessionV1Schema.safeParse(record[LEGACY_LINKED_SESSION_METADATA_KEY]);
  return legacy.success ? legacy.data : null;
}

export function normalizeLinkedExternalSessionMetadataV1(metadata: unknown): Record<string, unknown> | null {
  const record = asRecord(metadata);
  if (!record) return null;

  const canonical = LinkedExternalSessionV1Schema.safeParse(record.externalSessionV1);
  if (canonical.success) return record;

  const legacy = LinkedExternalSessionV1Schema.safeParse(record[LEGACY_LINKED_SESSION_METADATA_KEY]);
  if (!legacy.success) return record;

  return {
    ...record,
    externalSessionV1: legacy.data,
  };
}

export function removeLinkedExternalSessionMetadataV1(metadata: unknown): Record<string, unknown> {
  const record = asRecord(metadata);
  const next: Record<string, unknown> = record ? { ...record } : {};
  delete next.externalSessionV1;
  delete next[LEGACY_LINKED_SESSION_METADATA_KEY];
  return next;
}

function normalizeOptionalToken(value: unknown): string | undefined {
  const token = typeof value === 'string' ? value.trim() : '';
  return token || undefined;
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function buildProgressToken(message: Pick<ExternalSessionTranscriptRawMessageV1, 'createdAtMs' | 'id'>): string {
  return `${message.createdAtMs}:${message.id}`;
}

function compareProgressTokens(left: string, right: string): number {
  return left.localeCompare(right);
}

export function readExternalSessionFollowPolicyV1(value: unknown): ExternalSessionFollowPolicyV1 | null {
  const candidate = asRecord(value);
  if (!candidate || candidate.v !== 1) return null;

  const policy = candidate.policy;
  if (policy !== 'attached_only' && policy !== 'background_follow') return null;

  const updatedAtMs = normalizeOptionalTimestamp(candidate.updatedAtMs);
  return {
    v: 1,
    policy,
    ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
  };
}

export function buildExternalSessionFollowPolicyV1(
  value: Readonly<{
    policy: ExternalSessionFollowPolicy;
    updatedAtMs?: number;
  }>,
): ExternalSessionFollowPolicyV1 {
  const updatedAtMs = normalizeOptionalTimestamp(value.updatedAtMs);
  return {
    v: 1,
    policy: value.policy,
    ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
  };
}

export function readExternalSessionAttentionV1(value: unknown): ExternalSessionAttentionV1 | null {
  const candidate = asRecord(value);
  if (!candidate || candidate.v !== 1) return null;

  const observedProgressToken = normalizeOptionalToken(candidate.observedProgressToken);
  const viewedProgressToken = normalizeOptionalToken(candidate.viewedProgressToken);
  const observedAtMs = normalizeOptionalTimestamp(candidate.observedAtMs);
  const viewedAtMs = normalizeOptionalTimestamp(candidate.viewedAtMs);

  if (!observedProgressToken && !viewedProgressToken && observedAtMs === undefined && viewedAtMs === undefined) {
    return null;
  }

  return {
    ...(observedProgressToken ? { observedProgressToken } : {}),
    ...(viewedProgressToken ? { viewedProgressToken } : {}),
    ...(observedAtMs !== undefined ? { observedAtMs } : {}),
    ...(viewedAtMs !== undefined ? { viewedAtMs } : {}),
  };
}

export function buildExternalSessionAttentionV1(value: ExternalSessionAttentionV1) {
  return {
    v: 1 as const,
    ...(value.observedProgressToken ? { observedProgressToken: value.observedProgressToken } : {}),
    ...(value.viewedProgressToken ? { viewedProgressToken: value.viewedProgressToken } : {}),
    ...(value.observedAtMs !== undefined ? { observedAtMs: value.observedAtMs } : {}),
    ...(value.viewedAtMs !== undefined ? { viewedAtMs: value.viewedAtMs } : {}),
  };
}

export function deriveExternalSessionObservedProgress(
  items: ReadonlyArray<Pick<ExternalSessionTranscriptRawMessageV1, 'createdAtMs' | 'id'>>,
): ExternalSessionObservedProgress | null {
  let latest: Pick<ExternalSessionTranscriptRawMessageV1, 'createdAtMs' | 'id'> | null = null;
  let latestToken: string | null = null;
  for (const item of items) {
    const itemToken = buildProgressToken(item);
    if (!latest) {
      latest = item;
      latestToken = itemToken;
      continue;
    }
    if (item.createdAtMs > latest.createdAtMs) {
      latest = item;
      latestToken = itemToken;
      continue;
    }
    if (item.createdAtMs === latest.createdAtMs && latestToken && compareProgressTokens(itemToken, latestToken) > 0) {
      latest = item;
      latestToken = itemToken;
    }
  }

  if (!latest) return null;
  return {
    token: latestToken ?? buildProgressToken(latest),
    atMs: latest.createdAtMs,
  };
}

export function applyObservedProgressToExternalSessionAttentionV1(
  current: ExternalSessionAttentionV1 | null | undefined,
  progress: ExternalSessionObservedProgress | null | undefined,
): ExternalSessionAttentionV1 | null {
  const nextObservedProgress = progress ?? null;
  if (!nextObservedProgress) {
    return current ?? null;
  }

  const currentObservedAtMs = current?.observedAtMs;
  if (typeof currentObservedAtMs === 'number' && currentObservedAtMs > nextObservedProgress.atMs) {
    return current ?? null;
  }
  if (
    typeof currentObservedAtMs === 'number'
    && currentObservedAtMs === nextObservedProgress.atMs
    && typeof current?.observedProgressToken === 'string'
    && current.observedProgressToken.trim().length > 0
    && compareProgressTokens(current.observedProgressToken, nextObservedProgress.token) >= 0
  ) {
    return current ?? null;
  }
  if (
    current?.observedProgressToken === nextObservedProgress.token
    && currentObservedAtMs === nextObservedProgress.atMs
  ) {
    return current ?? null;
  }

  return {
    ...(current?.observedProgressToken ? { observedProgressToken: current.observedProgressToken } : {}),
    ...(current?.viewedProgressToken ? { viewedProgressToken: current.viewedProgressToken } : {}),
    ...(current?.observedAtMs !== undefined ? { observedAtMs: current.observedAtMs } : {}),
    ...(current?.viewedAtMs !== undefined ? { viewedAtMs: current.viewedAtMs } : {}),
    observedProgressToken: nextObservedProgress.token,
    observedAtMs: nextObservedProgress.atMs,
  };
}

export function markExternalSessionAttentionViewedV1(
  current: ExternalSessionAttentionV1 | null | undefined,
): ExternalSessionAttentionV1 | null {
  if (!current) return null;

  const nextViewedProgressToken = current.observedProgressToken ?? current.viewedProgressToken;
  const nextViewedAtMs = current.observedAtMs ?? current.viewedAtMs;

  if (
    current.viewedProgressToken === nextViewedProgressToken
    && current.viewedAtMs === nextViewedAtMs
  ) {
    return current;
  }

  return {
    ...(current.observedProgressToken ? { observedProgressToken: current.observedProgressToken } : {}),
    ...(current.observedAtMs !== undefined ? { observedAtMs: current.observedAtMs } : {}),
    ...(nextViewedProgressToken ? { viewedProgressToken: nextViewedProgressToken } : {}),
    ...(nextViewedAtMs !== undefined ? { viewedAtMs: nextViewedAtMs } : {}),
  };
}

export function markExternalSessionAttentionUnreadV1(
  current: ExternalSessionAttentionV1 | null | undefined,
): ExternalSessionAttentionV1 | null {
  if (!current) return null;

  const hasObservedProgress = Boolean(current.observedProgressToken) || current.observedAtMs !== undefined;
  if (!hasObservedProgress) {
    return current;
  }

  if (current.viewedProgressToken === undefined && current.viewedAtMs === undefined) {
    return current;
  }

  return {
    ...(current.observedProgressToken ? { observedProgressToken: current.observedProgressToken } : {}),
    ...(current.observedAtMs !== undefined ? { observedAtMs: current.observedAtMs } : {}),
  };
}

export function deriveExternalSessionAttentionHasUnread(
  attention: ExternalSessionAttentionV1 | null | undefined,
): boolean | null {
  if (!attention) return null;

  if (attention.observedProgressToken) {
    if (!attention.viewedProgressToken) return true;
    return attention.observedProgressToken !== attention.viewedProgressToken;
  }

  if (attention.observedAtMs !== undefined) {
    if (attention.viewedAtMs === undefined) return true;
    return attention.observedAtMs > attention.viewedAtMs;
  }

  return null;
}
