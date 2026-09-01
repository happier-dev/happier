import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { evaluateCodexConnectedServiceHotApplyEligibility } from './applyCodexConnectedServiceAuthGeneration';
import { classifyCodexConnectedServiceAuthFailure } from './classifyCodexConnectedServiceAuthFailure';
import { mapCodexRateLimitSnapshotToQuotaSnapshot } from './mapCodexRateLimitSnapshot';
import { readCodexRateLimitsSnapshot } from '../appServer/readCodexRateLimitsSnapshot';
import { readCodexLiveAccountIdentity } from './codexLiveAccountIdentity';
import {
  buildCodexConnectedServiceRuntimeAuthApplyRequest,
} from './codexConnectedServiceRuntimeAuthContract';
import { refreshCodexChatGptTokensForBridge } from './refreshCodexChatGptTokensForBridge';
import { verifyCodexConnectedServiceActiveAccount } from './verifyCodexConnectedServiceActiveAccount';
import {
  DEFAULT_CODEX_RATE_LIMIT_RESET_CREDITS_URL,
  type CodexRateLimitResetCreditsFetch,
} from '../quota/codexRateLimitResetCreditsClient';
import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeAuthAdapterResult,
  ConnectedServiceRuntimeAuthTargetInput,
} from '@/daemon/connectedServices/runtimeAuth/types';

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readSelectionRecord(input: ConnectedServiceRuntimeAuthTargetInput): Record<string, unknown> | null {
  return readRecord(input.selection);
}

function readCredentialRecord(input: ConnectedServiceRuntimeAuthTargetInput): ConnectedServiceCredentialRecordV1 | null {
  const selection = readSelectionRecord(input);
  const record = readRecord(selection?.record);
  return record as ConnectedServiceCredentialRecordV1 | null;
}

function readLoginStartClient(value: unknown): { request: (method: string, params?: unknown) => Promise<unknown> } | null {
  const record = readRecord(value);
  return record && typeof record.request === 'function'
    ? { request: record.request as (method: string, params?: unknown) => Promise<unknown> }
    : null;
}

function readRuntimeApplyCallback(value: unknown): ((request: unknown) => Promise<unknown>) | null {
  return typeof value === 'function'
    ? async (request) => await value(request)
    : null;
}

function readForcedWorkspaceId(input: ConnectedServiceRuntimeAuthTargetInput): string | null {
  return readString(readSelectionRecord(input)?.forcedWorkspaceId);
}

function readDurabilityFailureReason(value: unknown): string | null {
  const durability = readRecord(value);
  if (durability?.persisted !== false) return null;
  return readString(durability.errorCode) ?? 'auth_store_persistence_failed_after_live_apply';
}

function readRuntimeApplyPartialStateResult(
  record: Record<string, unknown>,
  reason: string,
): ConnectedServiceRuntimeAuthAdapterResult {
  const activeAccountId = readString(record.activeAccountId);
  return {
    applied: false,
    partialState: 'runtime_auth_applied',
    reason,
    error: readString(record.error) ?? reason,
    appliedVia: 'direct_live_hot_auth',
    ...(activeAccountId ? { activeAccountId } : {}),
    ...(record.verification === undefined ? {} : { verification: record.verification }),
    ...(record.durability === undefined ? {} : { durability: record.durability }),
  };
}

function readRuntimeApplyResult(result: unknown): ConnectedServiceRuntimeAuthAdapterResult {
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
    const liveMutated = readString(record.appliedVia) === 'direct_live_hot_auth'
      && (readString(record.activeAccountId) !== null || record.partialState === 'runtime_auth_applied');
    if (liveMutated) {
      return readRuntimeApplyPartialStateResult(
        record,
        readString(record.errorCode) ?? readString(record.error) ?? 'live_hot_auth_partial',
      );
    }
    return {
      applied: false,
      reason: readString(record.errorCode) ?? readString(record.error) ?? 'live_hot_auth_failed',
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.appliedVia === undefined ? {} : { appliedVia: record.appliedVia }),
      ...(record.activeAccountId === undefined ? {} : { activeAccountId: record.activeAccountId }),
      ...(record.durability === undefined ? {} : { durability: record.durability }),
    };
  }
  return { applied: false, reason: 'invalid_runtime_apply_response' };
}

function readRuntimeQuotaSnapshotStore(value: unknown): {
  recordSnapshot(input: Readonly<{
    serviceId: string;
    groupId: string;
    profileId: string;
    snapshot: unknown;
  }>): void;
} | null {
  const record = readRecord(value);
  return record && typeof record.recordSnapshot === 'function'
    ? {
        recordSnapshot: (record.recordSnapshot as (input: Readonly<{
          serviceId: string;
          groupId: string;
          profileId: string;
          snapshot: unknown;
        }>) => void).bind(record),
      }
    : null;
}

async function readCodexRateLimitResetCredits(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  fetchRuntime: CodexRateLimitResetCreditsFetch;
  resetCreditsUrl: string;
}>): Promise<unknown | null> {
  if (params.record.kind !== 'oauth' || !params.record.oauth.accessToken.trim()) return null;
  try {
    const response = await params.fetchRuntime(params.resetCreditsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.record.oauth.accessToken}`,
        ...(params.record.oauth.providerAccountId ? { 'ChatGPT-Account-Id': params.record.oauth.providerAccountId } : {}),
        Accept: 'application/json',
      },
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export function createCodexConnectedServiceRuntimeAuthAdapter(deps: Readonly<{
  fetchRuntime?: CodexRateLimitResetCreditsFetch;
  resetCreditsUrl?: string;
}> = {}): ConnectedServiceProviderRuntimeAuthAdapter {
  const fetchRuntime = deps.fetchRuntime ?? fetch;
  const resetCreditsUrl = typeof deps.resetCreditsUrl === 'string' && deps.resetCreditsUrl.trim()
    ? deps.resetCreditsUrl.trim()
    : DEFAULT_CODEX_RATE_LIMIT_RESET_CREDITS_URL;
  return {
    classifyRuntimeAuthFailure(input) {
      const selection = readRecord(input.selection);
      return classifyCodexConnectedServiceAuthFailure({
        providerErrorPath: true,
        error: input.error,
        serviceId: 'openai-codex',
        profileId: readString(selection?.activeProfileId ?? selection?.profileId),
        groupId: readString(selection?.groupId),
      });
    },
    async materializeActiveProfile() {
      return { supported: true };
    },
    canHotApply(input) {
      const record = readCredentialRecord(input);
      if (!record) {
        return {
          supported: false,
          reason: 'direct_live_hot_auth_ineligible',
          detailReason: 'missing_record',
        };
      }
      const eligibility = evaluateCodexConnectedServiceHotApplyEligibility({
        candidate: record,
        forcedWorkspaceId: readForcedWorkspaceId(input),
      });
      if (!eligibility.eligible) return { supported: false, reason: eligibility.reason };
      if (readRuntimeApplyCallback(readRecord(input.selection)?.applyConnectedServiceAuthGeneration)) {
        return {
          supported: true,
          mode: 'direct_live_hot_auth',
        };
      }
      return {
        supported: false,
        reason: 'direct_live_hot_auth_unsupported',
      };
    },
    async hotApply(input) {
      const record = readCredentialRecord(input);
      if (!record) {
        return {
          applied: false,
          reason: 'direct_live_hot_auth_ineligible',
          detailReason: 'missing_record',
        };
      }
      const runtimeApply = readRuntimeApplyCallback(readRecord(input.selection)?.applyConnectedServiceAuthGeneration);
      if (runtimeApply) {
        return readRuntimeApplyResult(await runtimeApply(buildCodexConnectedServiceRuntimeAuthApplyRequest({
          record,
          selection: readSelectionRecord(input),
          forcedWorkspaceId: readForcedWorkspaceId(input),
        })));
      }
      return {
        applied: false,
        reason: 'direct_live_hot_auth_unsupported',
      };
    },
    async recoverAfterRuntimeAuthSwitch() {
      return { recovered: false, reason: 'direct_live_hot_auth_required' };
    },
    async verifyActiveAccount(input) {
      return await verifyCodexConnectedServiceActiveAccount(input);
    },
    async probeQuota(input) {
      const selection = readSelectionRecord(input);
      const backendMode = readString(selection?.backendMode ?? readRecord(selection?.provider)?.backendMode);
      if (backendMode && backendMode !== 'appServer') {
        return {
          status: 'unsupported',
          reason: 'codex_quota_probe_unsupported_for_backend_mode',
        };
      }
      const client = readLoginStartClient(selection?.client);
      const record = readCredentialRecord(input);
      if (!record || !client) {
        return { status: 'unsupported' };
      }
      const rawSnapshot = await readCodexRateLimitsSnapshot({
        request: async (_method, params) => await client.request('account/rateLimits/read', params),
      });
      let liveIdentity: Readonly<{ activeAccountId: string | null; accountLabel: string | null }> = {
        activeAccountId: null,
        accountLabel: null,
      };
      try {
        liveIdentity = readCodexLiveAccountIdentity(await client.request('account/read', {}));
      } catch {
        liveIdentity = {
          activeAccountId: null,
          accountLabel: null,
        };
      }
      const rawResetCredits = await readCodexRateLimitResetCredits({
        record,
        fetchRuntime,
        resetCreditsUrl,
      });
      const quotaSnapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
        serviceId: 'openai-codex',
        profileId: record.profileId,
        activeAccountId: liveIdentity.activeAccountId,
        accountLabel: liveIdentity.accountLabel ?? (record.kind === 'oauth' ? readString(record.oauth.providerEmail) : null),
        fetchedAt: Date.now(),
        rawSnapshot,
        ...(rawResetCredits ? { rawResetCredits } : {}),
      });
      const groupId = readString(selection?.groupId);
      const runtimeQuotaSnapshots = readRuntimeQuotaSnapshotStore(selection?.runtimeQuotaSnapshots);
      if (groupId && runtimeQuotaSnapshots) {
        runtimeQuotaSnapshots.recordSnapshot({
          serviceId: 'openai-codex',
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
    async refreshActiveProfile(input) {
      const record = readCredentialRecord(input);
      if (!record) return { status: 'unsupported', reason: 'missing_record' };
      const chatgptPlanType = readString(readSelectionRecord(input)?.chatgptPlanType);
      return await refreshCodexChatGptTokensForBridge({
        record,
        chatgptPlanType,
        now: Date.now(),
      });
    },
  };
}
