import {
  classifyProviderLimitEvidence,
  type ProviderLimitCategory as RuntimeLimitCategory,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { summarizePiConnectedServiceActiveProfiles } from './activeProfiles.js';

type RuntimeAuthFailureKind =
  | 'usage_limit'
  | 'rate_limit'
  | 'capacity'
  | 'temporary_throttle'
  | 'auth_expired'
  | 'plan'
  | 'validation'
  | 'account_disabled'
  | 'dependency_failure';

type PiRuntimeSelection = Readonly<{
  kind?: string | null;
  serviceId?: string | null;
  profileId?: string | null;
  activeProfileId?: string | null;
  groupId?: string | null;
}>;

const PI_REQUEST_AUTH_SERVICE_IDS = new Set([
  'openai-codex',
  'claude-subscription',
]);

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const text = readString(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readAssistantContentText(value: unknown): string | null {
  const record = readRecord(value);
  if (!record || !Array.isArray(record.content)) return null;
  let text = '';
  for (const item of record.content) {
    const entry = readRecord(item);
    if (!entry || entry.type !== 'text') continue;
    const chunk = readString(entry.text);
    if (chunk) text += chunk;
  }
  return text.length > 0 ? text : null;
}

function normalizeErrorEvidence(error: unknown): unknown {
  if (typeof error === 'string') return { message: error };
  if (error instanceof Error) {
    return {
      ...(readRecord(error) ?? {}),
      name: error.name,
      message: error.message,
    };
  }
  const record = readRecord(error);
  const message = readRecord(record?.message);
  const errorMessage = readString(message?.errorMessage ?? message?.error_message ?? record?.errorMessage ?? record?.error_message)
    ?? readAssistantContentText(message);
  if (!record || !errorMessage) return error;
  return {
    ...record,
    provider: readString(record.provider) ?? readString(message?.provider) ?? record.provider,
    message: errorMessage,
    piMessage: message,
  };
}

function collectEvidenceText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceText(item, output);
    return;
  }
  const record = readRecord(value);
  if (!record) return;
  for (const nested of Object.values(record)) collectEvidenceText(nested, output);
}

function readProviderFromError(error: unknown): string | null {
  const record = readRecord(error);
  const direct = readString(record?.provider ?? record?.providerId);
  if (direct) return direct;
  const message = readRecord(record?.message);
  return readString(message?.provider ?? message?.providerId);
}

function readServiceIdFromError(error: unknown): string | null {
  const record = readRecord(error);
  const direct = readString(record?.serviceId);
  if (direct) return direct;
  const message = readRecord(record?.message);
  return readString(message?.serviceId);
}

function readSelection(value: unknown): PiRuntimeSelection | null {
  const record = readRecord(value);
  if (!record) return null;
  const serviceId = readString(record.serviceId);
  if (!serviceId) return null;
  return {
    kind: readString(record.kind),
    serviceId,
    profileId: readString(record.profileId),
    activeProfileId: readString(record.activeProfileId),
    groupId: readString(record.groupId),
  };
}

function readSelections(value: unknown): PiRuntimeSelection[] {
  if (value instanceof Map) return [...value.values()].flatMap((entry) => {
    const selection = readSelection(entry);
    return selection ? [selection] : [];
  });
  if (Array.isArray(value)) return value.flatMap((entry) => {
    const selection = readSelection(entry);
    return selection ? [selection] : [];
  });
  const selection = readSelection(value);
  return selection ? [selection] : [];
}

function candidateServiceIdsForProvider(provider: string | null, serviceId: string | null): string[] {
  if (serviceId) return [serviceId];
  if (provider === 'anthropic') return ['claude-subscription', 'anthropic'];
  if (provider === 'openai-codex') return ['openai-codex'];
  if (provider === 'openai') return ['openai'];
  return [];
}

function chooseSelection(params: Readonly<{
  selection: unknown;
  serviceIds: readonly string[];
}>): PiRuntimeSelection | null {
  const selections = readSelections(params.selection);
  if (selections.length === 0) return null;
  for (const serviceId of params.serviceIds) {
    const match = selections.find((selection) => selection.serviceId === serviceId);
    if (match) return match;
  }
  return selections[0] ?? null;
}

function parseCompactDurationMs(value: unknown): number | null {
  const text = readString(value);
  if (!text) return null;
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)/giu)];
  if (matches.length === 0) return null;
  let total = 0;
  for (const match of matches) {
    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase() ?? '';
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (unit.startsWith('ms') || unit.startsWith('millisecond')) total += amount;
    else if (unit.startsWith('s') || unit.startsWith('sec')) total += amount * 1_000;
    else if (unit.startsWith('m') || unit.startsWith('min')) total += amount * 60_000;
    else if (unit.startsWith('h') || unit.startsWith('hr') || unit.startsWith('hour')) total += amount * 3_600_000;
  }
  return total > 0 ? Math.trunc(total) : null;
}

function parseResetTiming(evidence: unknown): Readonly<{ retryAfterMs: number | null; resetAtMs: number | null }> {
  const record = readRecord(evidence);
  const retryAfterMs = readNonNegativeNumber(record?.retryAfterMs ?? record?.['retry-after-ms']);
  if (retryAfterMs !== null) return { retryAfterMs: Math.trunc(retryAfterMs), resetAtMs: null };
  const resetAtMs = readNonNegativeNumber(record?.resetAtMs ?? record?.resetAt ?? record?.resetsAt);
  if (resetAtMs !== null) return { retryAfterMs: Math.max(0, Math.trunc(resetAtMs - Date.now())), resetAtMs: Math.trunc(resetAtMs) };

  const textParts: string[] = [];
  collectEvidenceText(evidence, textParts);
  for (const text of textParts) {
    const delayText = /\b(?:reset|resets|retry|try again)\s+(?:after|in)\s+([0-9][0-9a-zA-Z.\s]*)/iu.exec(text)?.[1]?.trim();
    const durationMs = parseCompactDurationMs(delayText);
    if (durationMs !== null) {
      return { retryAfterMs: durationMs, resetAtMs: Date.now() + durationMs };
    }
  }

  return { retryAfterMs: null, resetAtMs: null };
}

export function mapPiLimitCategoryToRuntimeAuthFailureKind(
  category: RuntimeLimitCategory,
): RuntimeAuthFailureKind | null {
  if (category === 'temporary_throttle') return 'temporary_throttle';
  if (category === 'usage_limit') return 'usage_limit';
  if (category === 'rate_limit') return 'rate_limit';
  if (category === 'capacity') return 'capacity';
  if (category === 'auth_invalid') return 'auth_expired';
  if (category === 'plan_invalid') return 'plan';
  if (category === 'validation_failed') return 'validation';
  if (category === 'disabled') return 'account_disabled';
  return null;
}

function isCompactionDependencyFailure(text: string): boolean {
  return /\bcompaction\b/u.test(text)
    && /\b(dependency|dependencies|unavailable|failed|failure)\b/u.test(text);
}

function activeProfiles(input: Readonly<{ selection?: unknown; target?: unknown }>) {
  const selection = readRecord(input.selection);
  return summarizePiConnectedServiceActiveProfiles({
    openaiCodexProfileId: readString(selection?.openaiCodexProfileId),
    openaiProfileId: readString(selection?.openaiProfileId),
    claudeSubscriptionProfileId: readString(selection?.claudeSubscriptionProfileId),
    anthropicProfileId: readString(selection?.anthropicProfileId),
  });
}

function classifyPiRuntimeAuthFailure(input: Readonly<{
  error: unknown;
  selection: unknown;
}>): Record<string, unknown> | null {
  const evidence = normalizeErrorEvidence(input.error);
  const textParts: string[] = [];
  collectEvidenceText(evidence, textParts);
  const text = textParts.join(' ').toLowerCase();
  const providerEvidence = classifyProviderLimitEvidence(evidence);
  const dependencyFailure = isCompactionDependencyFailure(text);
  const category = providerEvidence.category === 'unknown' && /\b(no|missing)\s+api\s+key\b/u.test(text)
    ? 'auth_invalid'
    : providerEvidence.category;
  const kind = dependencyFailure ? 'dependency_failure' : mapPiLimitCategoryToRuntimeAuthFailureKind(category);
  if (!kind) return null;

  const provider = readProviderFromError(evidence);
  const serviceIds = candidateServiceIdsForProvider(provider, readServiceIdFromError(evidence));
  const selection = chooseSelection({ selection: input.selection, serviceIds });
  const serviceId = selection?.serviceId ?? serviceIds[0] ?? null;
  if (!serviceId) return null;
  // Request-auth providers report exact structured failures at the request leaf. Reclassifying their
  // terminal assistant text here would create a second recovery owner and would be especially unsafe
  // for Anthropic, whose supported Pi seam exposes only incidental SDK-formatted error text.
  if (!dependencyFailure && PI_REQUEST_AUTH_SERVICE_IDS.has(serviceId)) return null;

  const timing = parseResetTiming(evidence);

  return {
    kind,
    ...(dependencyFailure ? {} : { limitCategory: category }),
    serviceId,
    profileId: selection?.activeProfileId ?? selection?.profileId ?? null,
    groupId: selection?.groupId ?? null,
    resetsAtMs: timing.resetAtMs,
    retryAfterMs: timing.retryAfterMs,
    ...(providerEvidence.quotaScope !== 'unknown'
      ? { quotaScope: providerEvidence.quotaScope }
      : {}),
    providerLimitId: null,
    action: null,
    planType: null,
    rateLimits: evidence,
    source: providerEvidence.provenance.kind === 'structured'
      ? 'structured_provider_error'
      : 'stable_provider_message',
  };
}

const unsupportedHotApply = Object.freeze({ supported: false, reason: 'restart_required' });

export function createPiConnectedServiceRuntimeAuthAdapter() {
  return {
    classifyRuntimeAuthFailure(input: Readonly<{ error: unknown; selection: unknown; target?: unknown }>) {
      return classifyPiRuntimeAuthFailure(input);
    },
    async materializeActiveProfile(input: Readonly<{ selection?: unknown; target?: unknown }>) {
      return { supported: true, activeProfiles: activeProfiles(input) };
    },
    canHotApply() {
      return unsupportedHotApply;
    },
    async hotApply() {
      return { applied: false, reason: 'restart_required' };
    },
    async recoverAfterRuntimeAuthSwitch() {
      return { recovered: false, reason: 'restart_required' };
    },
    async probeQuota() {
      return { status: 'unknown', reason: 'not_supported' };
    },
    async refreshActiveProfile(input: Readonly<{ selection?: unknown; target?: unknown }>) {
      return { status: 'available', activeProfiles: activeProfiles(input) };
    },
  };
}
