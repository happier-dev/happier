import type { DirectTranscriptRawMessageV1 } from './daemonRpcV1.js';

export type DirectSessionFollowPolicy = 'attached_only' | 'background_follow';

export type DirectSessionFollowPolicyV1 = Readonly<{
  v: 1;
  policy: DirectSessionFollowPolicy;
  updatedAtMs?: number;
}>;

export type DirectSessionAttentionV1 = Readonly<{
  observedProgressToken?: string;
  viewedProgressToken?: string;
  observedAtMs?: number;
  viewedAtMs?: number;
}>;

export type DirectSessionObservedProgress = Readonly<{
  token: string;
  atMs: number;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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

function buildProgressToken(message: Pick<DirectTranscriptRawMessageV1, 'createdAtMs' | 'id'>): string {
  return `${message.createdAtMs}:${message.id}`;
}

function compareProgressTokens(left: string, right: string): number {
  return left.localeCompare(right);
}

export function readDirectSessionFollowPolicyV1(value: unknown): DirectSessionFollowPolicyV1 | null {
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

export function buildDirectSessionFollowPolicyV1(
  value: Readonly<{
    policy: DirectSessionFollowPolicy;
    updatedAtMs?: number;
  }>,
): DirectSessionFollowPolicyV1 {
  const updatedAtMs = normalizeOptionalTimestamp(value.updatedAtMs);
  return {
    v: 1,
    policy: value.policy,
    ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
  };
}

export function readDirectSessionAttentionV1(value: unknown): DirectSessionAttentionV1 | null {
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

export function buildDirectSessionAttentionV1(value: DirectSessionAttentionV1) {
  return {
    v: 1 as const,
    ...(value.observedProgressToken ? { observedProgressToken: value.observedProgressToken } : {}),
    ...(value.viewedProgressToken ? { viewedProgressToken: value.viewedProgressToken } : {}),
    ...(value.observedAtMs !== undefined ? { observedAtMs: value.observedAtMs } : {}),
    ...(value.viewedAtMs !== undefined ? { viewedAtMs: value.viewedAtMs } : {}),
  };
}

export function deriveDirectSessionObservedProgress(
  items: ReadonlyArray<Pick<DirectTranscriptRawMessageV1, 'createdAtMs' | 'id'>>,
): DirectSessionObservedProgress | null {
  let latest: Pick<DirectTranscriptRawMessageV1, 'createdAtMs' | 'id'> | null = null;
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

export function applyObservedProgressToDirectSessionAttentionV1(
  current: DirectSessionAttentionV1 | null | undefined,
  progress: DirectSessionObservedProgress | null | undefined,
): DirectSessionAttentionV1 | null {
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

export function markDirectSessionAttentionViewedV1(
  current: DirectSessionAttentionV1 | null | undefined,
): DirectSessionAttentionV1 | null {
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

export function deriveDirectSessionAttentionHasUnread(
  attention: DirectSessionAttentionV1 | null | undefined,
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
