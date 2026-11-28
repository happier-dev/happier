import { isConnectedServiceAccountReadConsented } from '@/daemon/connectedServices/consent/isConnectedServiceAccountReadConsented';
import {
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeFailureClassification,
  ConnectedServiceRuntimeAuthTargetInput,
} from '@/daemon/connectedServices/runtimeAuth/types';
import { createGeminiQuotaFetcher } from './quotaFetcher';
import { ConnectedServiceQuotaFetchError } from '@/daemon/connectedServices/quotas/types';
import { mapProviderLimitCategoryToRuntimeAuthFailureKind } from '@/daemon/connectedServices/runtimeAuth/mapProviderLimitCategoryToRuntimeAuthFailureKind';
import {
  classifyProviderLimitEvidence,
  parseProviderResetAt,
} from '@/daemon/connectedServices/quotas/normalization';


type FetchRuntime = (url: string, init: RequestInit) => Promise<Response>;

type RuntimeQuotaSnapshotStore = Readonly<{
  recordSnapshot(input: Readonly<{
    serviceId: string;
    groupId: string;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>): void;
}>;

export type GeminiConnectedServiceRuntimeAuthAdapterDeps = Readonly<{
  fetchRuntime?: FetchRuntime;
  now?: () => number;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readCredentialRevision(value: unknown) {
  const parsed = ConnectedServiceCredentialRevisionV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readCredentialRecord(input: ConnectedServiceRuntimeAuthTargetInput): ConnectedServiceCredentialRecordV1 | null {
  const selection = readRecord(input.selection);
  const record = readRecord(selection?.record);
  return record as ConnectedServiceCredentialRecordV1 | null;
}

function collectText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }
  const record = readRecord(value);
  if (!record) return;
  for (const key of ['message', 'details', 'detail', 'error', 'reason', 'code']) {
    collectText(record[key], output);
  }
}

function readRuntimeQuotaSnapshotStore(value: unknown): RuntimeQuotaSnapshotStore | null {
  const record = readRecord(value);
  return record && typeof record.recordSnapshot === 'function'
    ? {
        recordSnapshot: (record.recordSnapshot as RuntimeQuotaSnapshotStore['recordSnapshot']).bind(record),
      }
    : null;
}

function classifyGeminiRuntimeQuotaFailure(
  input: Parameters<ConnectedServiceProviderRuntimeAuthAdapter['classifyRuntimeAuthFailure']>[0],
): ConnectedServiceRuntimeFailureClassification | null {
  const category = classifyProviderLimitEvidence(input.error);
  const runtimeKind = mapProviderLimitCategoryToRuntimeAuthFailureKind(category);
  if (!runtimeKind) return null;
  const selection = readRecord(input.selection);
  const textParts: string[] = [];
  collectText(input.error, textParts);
  const timing = parseProviderResetAt({
    nowMs: Date.now(),
    body: {
      error: input.error,
      message: textParts.join(' '),
    },
  });

  return {
    kind: runtimeKind,
    limitCategory: category,
    serviceId: readString(selection?.serviceId) ?? 'gemini',
    profileId: readString(selection?.activeProfileId ?? selection?.profileId),
    groupId: readString(selection?.groupId),
    groupGeneration: readFiniteNumber(selection?.generation),
    credentialRevision: readCredentialRevision(selection?.credentialRevision),
    sourceProviderAccountId: readString(selection?.providerAccountId),
    sourceAccountLabel: readString(selection?.providerEmail),
    failingAccessTokenFingerprint: readString(selection?.credentialFingerprint),
    resetsAtMs: timing.resetAtMs,
    retryAfterMs: timing.retryAfterMs,
    quotaScope: 'account' as const,
    planType: null,
    rateLimits: {
      limitCategory: category,
      retryAfterMs: timing.retryAfterMs,
      resetAtMs: timing.resetAtMs,
      quotaScope: 'account',
    },
    // Honest provenance: Gemini classifications are derived from text evidence heuristics over
    // stderr/ACP error payloads, not a structured provider error contract.
    source: 'stable_provider_message' as const,
  };
}

export function createGeminiConnectedServiceRuntimeAuthAdapter(
  deps: GeminiConnectedServiceRuntimeAuthAdapterDeps = {},
): ConnectedServiceProviderRuntimeAuthAdapter {
  const fetchRuntime = deps.fetchRuntime ?? fetch;
  const now = deps.now ?? Date.now;

  return {
    classifyRuntimeAuthFailure(input) {
      return classifyGeminiRuntimeQuotaFailure(input);
    },
    async materializeActiveProfile() {
      return { supported: true };
    },
    canHotApply() {
      return { supported: false, recovery: 'restart_rematerialize' };
    },
    async hotApply() {
      return { applied: false, reason: 'hot_apply_unsupported' };
    },
    async recoverAfterRuntimeAuthSwitch() {
      return {
        recovered: false,
        recovery: 'restart_rematerialize',
        reason: 'gemini_provider_outcome_pending',
      };
    },
    async verifyActiveAccount() {
      return {
        status: 'unavailable',
        retryable: true,
        reason: 'gemini_provider_outcome_pending',
      };
    },
    async probeQuota(input) {
      const record = readCredentialRecord(input);
      if (!record || record.serviceId !== 'gemini' || record.kind !== 'oauth' || !record.oauth?.accessToken) {
        return { status: 'unsupported', reason: 'missing_gemini_oauth_record' };
      }
      if (!isConnectedServiceAccountReadConsented({ serviceId: 'gemini', poolMember: Boolean(readString(readRecord(input.selection)?.groupId)) })) {
        return { status: 'unsupported', reason: 'pool_consent_required' };
      }

      let quotaSnapshot: ConnectedServiceQuotaSnapshotV1;
      try {
        quotaSnapshot = (await createGeminiQuotaFetcher({ fetchRuntime }).fetch({ record, now: now(), signal: new AbortController().signal }))!;
      } catch (error) {
        return { status: 'unsupported', reason: error instanceof ConnectedServiceQuotaFetchError && error.message === 'gemini_code_assist_project_unavailable'
          ? 'gemini_code_assist_project_unavailable' : 'gemini_code_assist_request_failed' };
      }
      const selection = readRecord(input.selection);
      const groupId = readString(selection?.groupId);
      const runtimeQuotaSnapshots = readRuntimeQuotaSnapshotStore(selection?.runtimeQuotaSnapshots);
      if (groupId && runtimeQuotaSnapshots) {
        runtimeQuotaSnapshots.recordSnapshot({
          serviceId: 'gemini',
          groupId,
          profileId: record.profileId,
          snapshot: quotaSnapshot,
        });
      }
      return {
        status: 'available',
        quotaSnapshot,
      };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
