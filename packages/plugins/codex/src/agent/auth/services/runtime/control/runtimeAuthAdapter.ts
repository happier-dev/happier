import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import {
  applyCodexConnectedServiceAuthGeneration,
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

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
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
      });
      if (!eligibility.eligible) return { supported: false, reason: eligibility.reason };
      if (typeof readSelection(input)?.invalidateTransports !== 'function') {
        return { supported: false, reason: 'transport_invalidation_unavailable', recovery: 'restart_resume' };
      }
      return { supported: true };
    },
    async hotApply(input: RuntimeAuthTargetInput) {
      const record = readCredentialRecord(input);
      const selection = readSelection(input);
      const client = readClient(selection?.client);
      if (!record) return { applied: false, reason: 'missing_record' };
      if (!client) return { applied: false, reason: 'missing_client', recovery: 'restart_resume' };
      return await applyCodexConnectedServiceAuthGeneration({
        client,
        candidate: record,
        forcedWorkspaceId: readForcedWorkspaceId(input),
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
