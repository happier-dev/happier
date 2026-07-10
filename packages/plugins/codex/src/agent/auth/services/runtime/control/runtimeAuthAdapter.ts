import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import {
  applyCodexConnectedServiceAuthTransportRecycle,
  evaluateCodexConnectedServiceHotApplyEligibility,
  recoverCodexConnectedServiceRestartResumeOnce,
} from '../auth/application.js';
import {
  readCodexAuthStoreProviderAccountIdProofFromValue,
  type CodexActiveProviderAccountVerification,
  type CodexAuthStoreProviderAccountIdProof,
  verifyCodexActiveProviderAccount,
} from '../auth/accountId.js';
import {
  classifyCodexConnectedServiceAuthFailure,
  type CodexConnectedServiceRuntimeFailureClassification,
} from '../auth/failure.js';
import { resolveCodexRuntimeQuotaProbeSupport } from '../../quota/probe.js';
import { mapCodexRateLimitSnapshotToQuotaSnapshot } from '../../quota/rateLimitSnapshot.js';
import { readCodexRuntimeRateLimitsSnapshot } from '../../quota/runtimeRateLimits.js';

type RuntimeAuthTargetInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  selection: unknown;
}>;

type RuntimeFailureInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  error: unknown;
  selection?: unknown;
}>;

type RuntimeAuthAdapterResult = Readonly<Record<string, unknown>>;

type CodexAccountTransitionVerificationResult =
  | CodexActiveProviderAccountVerification
  | Readonly<{
      status: 'unavailable';
      retryable: boolean;
      reason: string;
      errorClassification?: unknown;
    }>;

export type CodexConnectedServiceRuntimeAuthAdapter = Readonly<{
  classifyRuntimeAuthFailure(input: RuntimeFailureInput): CodexConnectedServiceRuntimeFailureClassification | null;
  materializeActiveProfile(input: RuntimeAuthTargetInput): Promise<RuntimeAuthAdapterResult>;
  canHotApply(input: RuntimeAuthTargetInput): RuntimeAuthAdapterResult;
  hotApply(input: RuntimeAuthTargetInput): Promise<RuntimeAuthAdapterResult>;
  recoverAfterRuntimeAuthSwitch(input: RuntimeAuthTargetInput): Promise<RuntimeAuthAdapterResult>;
  verifyActiveAccount(input: RuntimeAuthTargetInput): Promise<CodexAccountTransitionVerificationResult>;
  probeQuota(input: RuntimeAuthTargetInput): Promise<RuntimeAuthAdapterResult>;
  refreshActiveProfile(input: RuntimeAuthTargetInput): Promise<RuntimeAuthAdapterResult>;
}>;

type AppServerClient = Readonly<{
  request: (method: string, params?: unknown) => Promise<unknown>;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readSelection(input: RuntimeAuthTargetInput | RuntimeFailureInput): Record<string, unknown> | null {
  return readRecord(input.selection);
}

function readCredentialRecord(input: RuntimeAuthTargetInput): ConnectedServiceCredentialRecordV1 | null {
  const record = readRecord(readSelection(input)?.record);
  return record as ConnectedServiceCredentialRecordV1 | null;
}

function readClient(value: unknown): AppServerClient | null {
  const record = readRecord(value);
  return record && typeof record.request === 'function'
    ? { request: record.request as (method: string, params?: unknown) => Promise<unknown> }
    : null;
}

function readAuthStoreProviderAccountIdReader(value: unknown): (() => Promise<CodexAuthStoreProviderAccountIdProof>) | null {
  const record = readRecord(value);
  const reader = record?.readAuthStoreProviderAccountId;
  return typeof reader === 'function'
    ? async () => readCodexAuthStoreProviderAccountIdProofFromValue(await reader())
    : null;
}

function readAsyncCallback(value: unknown): (() => Promise<void>) | null {
  return typeof value === 'function'
    ? async () => { await value(); }
    : null;
}

function readRuntimeApplyCallback(value: unknown): ((request: unknown) => Promise<unknown>) | null {
  return typeof value === 'function'
    ? async (request) => await value(request)
    : null;
}

function readDurabilityFailureReason(value: unknown): string | null {
  const durability = readRecord(value);
  if (durability?.persisted !== false) return null;
  return readString(durability.errorCode) ?? 'auth_store_persistence_failed_after_live_apply';
}

function readRuntimeApplyPartialStateResult(
  record: Record<string, unknown>,
  reason: string,
): RuntimeAuthAdapterResult {
  const activeAccountId = readString(record.activeAccountId);
  return {
    applied: false,
    appliedVia: 'direct_live_hot_auth',
    partialState: 'runtime_auth_partially_applied',
    reason,
    error: readString(record.error) ?? reason,
    recovery: readString(record.recovery) ?? 'restart_resume',
    ...(activeAccountId ? { activeAccountId } : {}),
    ...(record.durability === undefined ? {} : { durability: record.durability }),
    ...(record.verification === undefined ? {} : { verification: record.verification }),
    ...(record.quotaSnapshotRef === undefined ? {} : { quotaSnapshotRef: record.quotaSnapshotRef }),
  };
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readApplyReason(value: unknown): 'usage_limit' | 'same_provider_account_exhausted' | 'soft_threshold' | 'manual' | 'diagnostic' {
  return value === 'usage_limit'
    || value === 'same_provider_account_exhausted'
    || value === 'soft_threshold'
    || value === 'manual'
    || value === 'diagnostic'
    ? value
    : 'manual';
}

function readForcedWorkspaceId(input: RuntimeAuthTargetInput): string | null {
  return readString(readSelection(input)?.forcedWorkspaceId);
}

function classifyProbeError(error: unknown): Readonly<{
  retryable: boolean;
  reason: string;
}> {
  const code = readString(readRecord(error)?.code);
  return {
    retryable: code === 'codex_app_server_control_unavailable',
    reason: code ?? 'active_account_probe_failed',
  };
}

function buildRuntimeApplyExpected(
  selection: Record<string, unknown> | null,
  record: ConnectedServiceCredentialRecordV1,
): Record<string, unknown> {
  const expected: Record<string, unknown> = {
    profileId: readString(selection?.activeProfileId ?? selection?.profileId) ?? record.profileId,
  };
  const groupId = readString(selection?.groupId);
  if (groupId) expected.groupId = groupId;
  const generation = readNonNegativeInteger(selection?.generation);
  if (generation !== null) expected.generation = generation;
  return expected;
}

function buildRuntimeApplySelection(
  selection: Record<string, unknown> | null,
  record: ConnectedServiceCredentialRecordV1,
): Record<string, unknown> {
  const groupId = readString(selection?.groupId);
  if (groupId) {
    return {
      kind: 'group',
      serviceId: 'openai-codex',
      groupId,
      activeProfileId: readString(selection?.activeProfileId ?? selection?.profileId) ?? record.profileId,
      ...(readString(selection?.fallbackProfileId) ? { fallbackProfileId: readString(selection?.fallbackProfileId) } : {}),
      generation: readNonNegativeInteger(selection?.generation) ?? 0,
    };
  }
  return {
    kind: 'profile',
    serviceId: 'openai-codex',
    profileId: readString(selection?.profileId) ?? record.profileId,
  };
}

function buildRuntimeApplyRequest(
  input: RuntimeAuthTargetInput,
  record: ConnectedServiceCredentialRecordV1,
): Record<string, unknown> {
  const selection = readSelection(input);
  const forcedLoginMethod = readString(selection?.forcedLoginMethod);
  return {
    serviceId: 'openai-codex',
    reason: readApplyReason(selection?.applyReason),
    requireDirectLiveHotApply: readBoolean(selection?.requireDirectLiveHotApply),
    expected: buildRuntimeApplyExpected(selection, record),
    authGeneration: {
      credential: record,
      forcedWorkspaceId: readForcedWorkspaceId(input),
      selection: buildRuntimeApplySelection(selection, record),
      ...(forcedLoginMethod ? { forcedLoginMethod } : {}),
    },
  };
}

function readRuntimeApplyResult(result: unknown): RuntimeAuthAdapterResult {
  const record = readRecord(result);
  if (record?.ok === true) {
    const durabilityFailureReason = readDurabilityFailureReason(record.durability);
    if (durabilityFailureReason) {
      return readRuntimeApplyPartialStateResult(record, durabilityFailureReason);
    }
    return {
      applied: true,
      appliedVia: readString(record.appliedVia) ?? 'direct_live_hot_auth',
      ...(record.activeAccountId === undefined ? {} : { activeAccountId: record.activeAccountId }),
      ...(record.verification === undefined ? {} : { verification: record.verification }),
      ...(record.durability === undefined ? {} : { durability: record.durability }),
      ...(record.quotaSnapshotRef === undefined ? {} : { quotaSnapshotRef: record.quotaSnapshotRef }),
    };
  }
  if (record?.ok === false) {
    const appliedVia = readString(record.appliedVia);
    const activeAccountId = readString(record.activeAccountId);
    const reason = readString(record.errorCode) ?? readString(record.error) ?? 'live_hot_auth_failed';
    if (
      appliedVia === 'direct_live_hot_auth'
      && (activeAccountId || record.partialState === 'runtime_auth_partially_applied')
    ) {
      return readRuntimeApplyPartialStateResult(record, reason);
    }
    return {
      applied: false,
      reason,
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.appliedVia === undefined ? {} : { appliedVia: record.appliedVia }),
      ...(record.activeAccountId === undefined ? {} : { activeAccountId: record.activeAccountId }),
      ...(record.recovery === undefined ? {} : { recovery: record.recovery }),
    };
  }
  return {
    applied: false,
    reason: 'invalid_runtime_apply_response',
    recovery: 'restart_resume',
  };
}

export function createCodexConnectedServiceRuntimeAuthAdapter(): CodexConnectedServiceRuntimeAuthAdapter {
  return {
    classifyRuntimeAuthFailure(input: RuntimeFailureInput) {
      const selection = readRecord(input.selection);
      return classifyCodexConnectedServiceAuthFailure({
        providerErrorPath: true,
        serviceId: 'openai-codex',
        profileId: readString(selection?.activeProfileId ?? selection?.profileId),
        groupId: readString(selection?.groupId),
        error: input.error,
        genericRuntimeIssueSource: null,
      });
    },
    async materializeActiveProfile() {
      return { supported: true };
    },
    canHotApply(input: RuntimeAuthTargetInput) {
      const record = readCredentialRecord(input);
      if (!record) return { supported: false, reason: 'missing_record' };
      const eligibility = evaluateCodexConnectedServiceHotApplyEligibility({
        candidate: record,
        forcedWorkspaceId: readForcedWorkspaceId(input),
        forcedLoginMethod: readString(readSelection(input)?.forcedLoginMethod),
      });
      if (!eligibility.eligible) return { supported: false, reason: eligibility.reason };
      const selection = readSelection(input);
      if (readRuntimeApplyCallback(selection?.applyConnectedServiceAuthGeneration)) {
        return { supported: true, mode: 'direct_live_hot_auth' };
      }
      if (readBoolean(selection?.requireDirectLiveHotApply)) {
        return { supported: false, reason: 'live_hot_auth_unavailable', recovery: 'restart_resume' };
      }
      if (typeof selection?.invalidateTransports !== 'function') {
        return { supported: false, reason: 'transport_invalidation_unavailable', recovery: 'restart_resume' };
      }
      return { supported: true, mode: 'transport_recycle', recovery: 'restart_resume' };
    },
    async hotApply(input: RuntimeAuthTargetInput) {
      const record = readCredentialRecord(input);
      const selection = readSelection(input);
      if (!record) return { applied: false, reason: 'missing_record' };
      const runtimeApply = readRuntimeApplyCallback(selection?.applyConnectedServiceAuthGeneration);
      if (runtimeApply) {
        return readRuntimeApplyResult(await runtimeApply(buildRuntimeApplyRequest(input, record)));
      }
      if (readBoolean(selection?.requireDirectLiveHotApply)) {
        return { applied: false, reason: 'live_hot_auth_unavailable', recovery: 'restart_resume' };
      }
      const client = readClient(selection?.client);
      if (!client) return { applied: false, reason: 'missing_client', recovery: 'restart_resume' };
      return await applyCodexConnectedServiceAuthTransportRecycle({
        client,
        candidate: record,
        forcedWorkspaceId: readForcedWorkspaceId(input),
        forcedLoginMethod: readString(selection?.forcedLoginMethod),
        invalidateTransports: readAsyncCallback(selection?.invalidateTransports),
      });
    },
    async recoverAfterRuntimeAuthSwitch(input: RuntimeAuthTargetInput) {
      const selection = readSelection(input);
      const restartAndResume = selection?.restartAndResume;
      if (typeof restartAndResume !== 'function') {
        return { recovered: false, reason: 'missing_restart_resume' };
      }
      return await recoverCodexConnectedServiceRestartResumeOnce({
        attemptsSoFar: readNonNegativeInteger(selection?.attemptsSoFar) ?? 0,
        restartAndResume: async () => {
          await restartAndResume();
          return { resumed: true };
        },
      });
    },
    async verifyActiveAccount(input: RuntimeAuthTargetInput) {
      const record = readCredentialRecord(input);
      if (!record || record.kind !== 'oauth' || record.serviceId !== 'openai-codex') {
        return {
          status: 'unavailable',
          retryable: false,
          reason: 'missing_expected_provider_account_id',
        } as const;
      }
      const expectedProviderAccountId = readString(record.oauth.providerAccountId);
      if (!expectedProviderAccountId) {
        return {
          status: 'unavailable',
          retryable: false,
          reason: 'missing_expected_provider_account_id',
        } as const;
      }
      const client = readClient(readSelection(input)?.client);
      if (!client) {
        return {
          status: 'unavailable',
          retryable: true,
          reason: 'active_account_probe_client_unavailable',
        } as const;
      }
      let rawAccount: unknown;
      try {
        rawAccount = await client.request('account/read');
      } catch (error) {
        const classification = classifyProbeError(error);
        return {
          status: 'unavailable',
          retryable: classification.retryable,
          reason: 'active_account_probe_failed',
          errorClassification: classification,
        } as const;
      }
      const readAuthStoreProviderAccountId = readAuthStoreProviderAccountIdReader(readSelection(input));
      return verifyCodexActiveProviderAccount({
        expectedProviderAccountId,
        expectedProviderEmail: record.oauth.providerEmail,
        rawAccount,
        authStoreProviderAccountIdProof: readAuthStoreProviderAccountId
          ? await readAuthStoreProviderAccountId()
          : { status: 'missing' },
      });
    },
    async probeQuota(input: RuntimeAuthTargetInput) {
      const selection = readSelection(input);
      const support = resolveCodexRuntimeQuotaProbeSupport(selection);
      if (!support.supported) {
        return {
          status: 'unsupported',
          reason: support.reason,
        };
      }
      const client = readClient(selection?.client);
      const record = readCredentialRecord(input);
      if (!record || record.kind !== 'oauth' || !client) {
        return { status: 'unsupported' };
      }
      const { rawSnapshot } = await readCodexRuntimeRateLimitsSnapshot({
        request: async (_method, requestParams) => await client.request('account/rateLimits/read', requestParams),
      });
      const quotaSnapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
        serviceId: 'openai-codex',
        profileId: record.profileId,
        activeAccountId: record.oauth.providerAccountId ?? null,
        accountLabel: readString(record.oauth.providerEmail),
        fetchedAt: Date.now(),
        rawSnapshot,
      });
      const runtimeQuotaSnapshots = readRecord(selection?.runtimeQuotaSnapshots);
      if (typeof runtimeQuotaSnapshots?.recordSnapshot === 'function') {
        const groupId = readString(selection?.groupId);
        if (groupId) {
          runtimeQuotaSnapshots.recordSnapshot({
            serviceId: 'openai-codex',
            groupId,
            profileId: record.profileId,
            snapshot: quotaSnapshot,
          });
        }
      }
      return { status: 'available', quotaSnapshot };
    },
    async refreshActiveProfile() {
      return {
        status: 'unsupported',
        reason: 'codex_refresh_requires_daemon_refresh_coordinator',
      };
    },
  };
}
