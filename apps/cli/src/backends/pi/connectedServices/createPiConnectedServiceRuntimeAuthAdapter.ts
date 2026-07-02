import { classifyProviderLimitEvidence, parseProviderResetAt } from '@/daemon/connectedServices/quotas/normalization';
import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeFailureClassification,
  ConnectedServiceRuntimeFailureInput,
  ConnectedServiceRuntimeAuthFailureKind,
  ConnectedServiceRuntimeLimitCategory,
  ConnectedServiceRuntimeAuthTargetInput,
  ConnectedServiceRuntimeQuotaScope,
} from '@/daemon/connectedServices/runtimeAuth/types';

import { summarizePiConnectedServiceActiveProfiles } from './piConnectedServiceActiveProfiles';

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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

function activeProfiles(input: ConnectedServiceRuntimeAuthTargetInput) {
  const selection = readRecord(input.selection);
  return summarizePiConnectedServiceActiveProfiles({
    openaiCodexProfileId: readString(selection?.openaiCodexProfileId),
    openaiProfileId: readString(selection?.openaiProfileId),
    claudeSubscriptionProfileId: readString(selection?.claudeSubscriptionProfileId),
    anthropicProfileId: readString(selection?.anthropicProfileId),
  });
}

function normalizeErrorEvidence(error: unknown): unknown {
  if (typeof error === 'string') return { message: error };
  if (error instanceof Error) return { name: error.name, message: error.message };
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

type PiRuntimeSelection = Readonly<{
  kind?: string | null;
  serviceId?: string | null;
  profileId?: string | null;
  activeProfileId?: string | null;
  groupId?: string | null;
}>;

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

export function mapPiLimitCategoryToRuntimeAuthFailureKind(
  category: ConnectedServiceRuntimeLimitCategory,
): ConnectedServiceRuntimeAuthFailureKind | null {
  if (category === 'usage_limit') return 'usage_limit';
  if (category === 'rate_limit') return 'rate_limit';
  if (category === 'capacity') return 'capacity';
  if (category === 'temporary_throttle') return 'temporary_throttle';
  if (category === 'auth_invalid') return 'auth_expired';
  if (category === 'plan_invalid') return 'plan';
  if (category === 'validation_failed') return 'validation';
  if (category === 'disabled') return 'account_disabled';
  return null;
}

function quotaScopeForCategory(category: ConnectedServiceRuntimeLimitCategory): ConnectedServiceRuntimeQuotaScope | undefined {
  return category === 'usage_limit' || category === 'rate_limit' || category === 'temporary_throttle'
    ? 'account'
    : undefined;
}

function isCompactionDependencyFailure(text: string): boolean {
  return /\bcompaction\b/u.test(text)
    && /\b(dependency|dependencies|unavailable|failed|failure)\b/u.test(text);
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

function classifyPiRuntimeAuthFailure(
  input: ConnectedServiceRuntimeFailureInput,
): ConnectedServiceRuntimeFailureClassification | null {
  const evidence = normalizeErrorEvidence(input.error);
  const textParts: string[] = [];
  collectEvidenceText(evidence, textParts);
  const text = textParts.join(' ').toLowerCase();
  const providerCategory = classifyProviderLimitEvidence(evidence) as ConnectedServiceRuntimeLimitCategory;
  const dependencyFailure = isCompactionDependencyFailure(text);
  const category = providerCategory === 'unknown' && /\b(no|missing)\s+api\s+key\b/u.test(text)
    ? 'auth_invalid'
    : providerCategory;
  const kind = dependencyFailure ? 'dependency_failure' : mapPiLimitCategoryToRuntimeAuthFailureKind(category);
  if (!kind) return null;

  const provider = readProviderFromError(evidence);
  const serviceIds = candidateServiceIdsForProvider(provider, readServiceIdFromError(evidence));
  const selection = chooseSelection({ selection: input.selection, serviceIds });
  const serviceId = selection?.serviceId ?? serviceIds[0] ?? null;
  if (!serviceId) return null;

  const timing = parseProviderResetAt({ nowMs: Date.now(), body: readRecord(evidence) ?? { message: evidence } });
  const quotaScope = quotaScopeForCategory(category);

  return {
    kind,
    ...(dependencyFailure ? {} : { limitCategory: category }),
    serviceId,
    profileId: selection?.activeProfileId ?? selection?.profileId ?? null,
    groupId: selection?.groupId ?? null,
    resetsAtMs: timing.resetAtMs,
    retryAfterMs: timing.retryAfterMs,
    ...(quotaScope ? { quotaScope } : {}),
    providerLimitId: null,
    action: null,
    planType: null,
    rateLimits: evidence,
    source: 'stable_provider_message',
  };
}

export function createPiConnectedServiceRuntimeAuthAdapter(): ConnectedServiceProviderRuntimeAuthAdapter {
  return {
    classifyRuntimeAuthFailure(input) {
      return classifyPiRuntimeAuthFailure(input);
    },
    async materializeActiveProfile(input) {
      return { supported: true, activeProfiles: activeProfiles(input) };
    },
    canHotApply() {
      return { supported: false, recovery: 'restart_rematerialize' };
    },
    async hotApply() {
      return { applied: false, reason: 'hot_apply_unsupported' };
    },
    async recoverAfterRuntimeAuthSwitch() {
      return { recovered: false, recovery: 'restart_rematerialize' };
    },
    async verifyActiveAccount() {
      return { status: 'verified', reason: 'provider_restart_rematerialization_authoritative' };
    },
    async probeQuota() {
      return { status: 'unsupported' };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
