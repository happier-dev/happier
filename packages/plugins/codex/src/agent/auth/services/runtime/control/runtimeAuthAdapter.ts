import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import { recoverCodexConnectedServiceRestartResumeOnce } from '../auth/application.js';
import {
  readCodexAuthStoreProviderAccountId,
  type CodexActiveProviderAccountVerification,
  verifyCodexActiveProviderAccount,
} from '../auth/accountId.js';
import {
  classifyCodexConnectedServiceAuthFailure,
  type CodexConnectedServiceRuntimeFailureClassification,
} from '../auth/failure.js';
import { resolveCodexRuntimeQuotaProbeSupport } from '../../quota/probe.js';
import { mapCodexRateLimitSnapshotToQuotaSnapshot } from '../../quota/rateLimitSnapshot.js';
import { readCodexRuntimeRateLimitsSnapshot } from '../../quota/runtimeRateLimits.js';
import type { CodexAppServerClient } from '../../../../runtime/appServer/client.js';

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

function readClient(value: unknown): Pick<CodexAppServerClient, 'request'> | null {
  const record = readRecord(value);
  if (!record || typeof record.request !== 'function') return null;
  const request = record.request as CodexAppServerClient['request'];
  return {
    request: (method, params, options) => request.call(record, method, params, options),
  };
}

function readMaterializedCodexHome(selection: Record<string, unknown> | null): string | null {
  const targetMaterializedEnv = readRecord(selection?.targetMaterializedEnv);
  return readString(targetMaterializedEnv?.CODEX_HOME)
    ?? readString(selection?.targetMaterializedRoot);
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function readApplyCallback(value: unknown): ((request: Readonly<Record<string, unknown>>) => Promise<unknown>) | null {
  const selection = readRecord(value);
  const callback = selection?.applyConnectedServiceAuthGeneration;
  return typeof callback === 'function'
    ? async (request) => await callback.call(selection, request)
    : null;
}

function unwrapRuntimeControlResult(value: unknown): Record<string, unknown> | null {
  const result = readRecord(value);
  if (!result) return null;
  if (result.ok === true && 'value' in result) return readRecord(result.value);
  return result;
}

function buildApplyRequest(selection: Record<string, unknown>): Readonly<Record<string, unknown>> | null {
  const record = readCredentialRecord({ target: { agentId: 'codex' }, selection });
  if (!record) return null;
  const profileId = readString(selection.activeProfileId ?? selection.profileId);
  const groupId = readString(selection.groupId);
  const generation = readNonNegativeInteger(selection.generation);
  return {
    serviceId: 'openai-codex',
    ...(readString(selection.applyReason) ? { reason: readString(selection.applyReason) } : {}),
    ...(selection.requireDirectLiveHotApply === true ? { requireDirectLiveHotApply: true } : {}),
    ...(profileId || groupId || generation !== null ? {
      expected: {
        ...(profileId ? { profileId } : {}),
        ...(groupId ? { groupId } : {}),
        ...(generation !== null ? { generation } : {}),
      },
    } : {}),
    authGeneration: {
      credential: record,
      ...(readString(selection.credentialRevision)
        ? { credentialRevision: readString(selection.credentialRevision) }
        : {}),
      forcedWorkspaceId: readString(selection.forcedWorkspaceId),
      ...(readString(selection.forcedLoginMethod)
        ? { forcedLoginMethod: readString(selection.forcedLoginMethod) }
        : {}),
      ...(groupId && profileId && generation !== null ? {
        selection: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId,
          activeProfileId: profileId,
          ...(readString(selection.fallbackProfileId)
            ? { fallbackProfileId: readString(selection.fallbackProfileId) }
            : {}),
          generation,
        },
      } : profileId ? {
        selection: { kind: 'profile', serviceId: 'openai-codex', profileId },
      } : {}),
    },
  };
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
      return readApplyCallback(input.selection) && buildApplyRequest(readSelection(input) ?? {})
        ? { supported: true, mode: 'codex_chatgpt_auth_tokens' }
        : { supported: false, reason: 'runtime_apply_callback_unavailable' };
    },
    async hotApply(input: RuntimeAuthTargetInput) {
      const selection = readSelection(input);
      const callback = readApplyCallback(selection);
      const request = selection ? buildApplyRequest(selection) : null;
      if (!callback || !request) {
        return { applied: false, reason: 'runtime_apply_callback_unavailable' };
      }
      const result = unwrapRuntimeControlResult(await callback(request));
      if (!result || result.ok !== true) {
        return {
          applied: false,
          reason: readString(result?.errorCode ?? result?.error) ?? 'runtime_apply_failed',
          ...(readString(result?.recovery) ? { recovery: readString(result?.recovery) } : {}),
          ...(result?.appliedVia ? { appliedVia: result.appliedVia } : {}),
          ...(result?.activeAccountId ? { activeAccountId: result.activeAccountId } : {}),
        };
      }
      const durability = readRecord(result.durability);
      if (durability?.persisted === false) {
        return {
          applied: false,
          reason: readString(durability.errorCode) ?? 'runtime_apply_persistence_failed',
          appliedVia: result.appliedVia,
          activeAccountId: result.activeAccountId,
          recovery: 'restart_resume',
        };
      }
      return {
        applied: true,
        reason: readString(result.appliedVia) ?? 'direct_live_hot_auth',
        ...(readRecord(result.verification) ? { verification: result.verification } : {}),
        ...(result.activeAccountId ? { activeAccountId: result.activeAccountId } : {}),
      };
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
      const materializedCodexHome = readMaterializedCodexHome(readSelection(input));
      return verifyCodexActiveProviderAccount({
        expectedProviderAccountId,
        expectedProviderEmail: record.oauth.providerEmail,
        rawAccount,
        authStoreProviderAccountIdProof: materializedCodexHome
          ? await readCodexAuthStoreProviderAccountId(materializedCodexHome)
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
