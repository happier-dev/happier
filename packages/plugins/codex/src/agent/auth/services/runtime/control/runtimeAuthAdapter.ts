import {
  parseCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  AgentConnectedAccountNativeAuthCodecV1,
  AgentConnectedAccountRuntimeAuthAdapterResultV1,
  AgentConnectedAccountRuntimeAuthHotApplyInputV1,
  AgentConnectedAccountRuntimeAuthTargetV1,
  AgentConnectedAccountRuntimeAuthUsageInputV1,
  AgentConnectedAccountRuntimeAuthVerificationInputV1,
  AgentConnectedAccountTransitionVerificationResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  readCodexAuthStoreProviderAccountIdFromJson,
  type CodexActiveProviderAccountVerification,
  verifyCodexActiveProviderAccount,
} from '../auth/accountId.js';
import {
  classifyCodexConnectedServiceAuthFailure,
  type CodexConnectedServiceRuntimeFailureClassification,
} from '../auth/failure.js';
import { resolveCodexRuntimeQuotaProbeSupport } from '../../quota/probe.js';
import { readCodexRuntimeRateLimitsSnapshot } from '../../quota/runtimeRateLimits.js';
import { resolveCodexUsageSubjectRef } from '../../usage/identity.js';
import { mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot } from '../../usage/snapshot.js';
import { buildCodexCloudAuthFile } from '../../openai/cloud/authFile.js';
import { CODEX_OPENAI_CONNECTED_ACCOUNT_SERVICE_KEY } from '../../../../../constants.js';

type RuntimeAuthTargetInput = AgentConnectedAccountRuntimeAuthTargetV1;
type RuntimeAuthHotApplyInput = AgentConnectedAccountRuntimeAuthHotApplyInputV1;
type RuntimeAuthVerificationInput = AgentConnectedAccountRuntimeAuthVerificationInputV1;
type RuntimeAuthUsageInput = AgentConnectedAccountRuntimeAuthUsageInputV1;

type RuntimeFailureInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  error: unknown;
  selection?: unknown;
}>;

type RuntimeAuthAdapterResult = AgentConnectedAccountRuntimeAuthAdapterResultV1;

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
  canHotApply(input: RuntimeAuthHotApplyInput): RuntimeAuthAdapterResult;
  hotApply(input: RuntimeAuthHotApplyInput): Promise<RuntimeAuthAdapterResult>;
  verifyActiveAccount(input: RuntimeAuthVerificationInput): Promise<CodexAccountTransitionVerificationResult>;
  probeQuota(input: RuntimeAuthUsageInput): Promise<RuntimeAuthAdapterResult>;
  refreshActiveProfile(input: RuntimeAuthTargetInput): Promise<RuntimeAuthAdapterResult>;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readRecovery(value: unknown): 'restart_resume' | 'restart_rematerialize' | null {
  return value === 'restart_resume' || value === 'restart_rematerialize' ? value : null;
}

function readSelection(input: RuntimeAuthTargetInput | RuntimeFailureInput): Record<string, unknown> | null {
  return readRecord(input.selection);
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
        // Canonical qualified Plugin contribution key of the failing service.
        serviceId: CODEX_OPENAI_CONNECTED_ACCOUNT_SERVICE_KEY,
        profileId: readString(selection?.activeProfileId ?? selection?.profileId),
        groupId: readString(selection?.groupId),
        error: input.error,
        genericRuntimeIssueSource: null,
      });
    },
    async materializeActiveProfile() {
      return { supported: true };
    },
    canHotApply(input: RuntimeAuthHotApplyInput) {
      return input.applySelectedAuthGeneration && input.materializeNativeAuth
        ? { supported: true }
        : { supported: false, reason: 'runtime_apply_callback_unavailable' };
    },
    async hotApply(input: RuntimeAuthHotApplyInput) {
      if (!input.applySelectedAuthGeneration || !input.materializeNativeAuth) {
        return { applied: false, reason: 'runtime_apply_callback_unavailable' };
      }
      const result = await input.applySelectedAuthGeneration();
      if (!result.ok) {
        return {
          applied: false,
          reason: readString(result?.errorCode ?? result?.error) ?? 'runtime_apply_failed',
          ...(readRecovery(result?.recovery) ? { recovery: readRecovery(result?.recovery)! } : {}),
        };
      }
      try {
        const verification = await input.materializeNativeAuth();
        if (verification.status !== 'verified') {
          return {
            applied: false,
            reason: verification.reason ?? 'runtime_apply_persistence_failed',
            recovery: 'restart_resume',
          };
        }
      } catch {
        return {
          applied: false,
          reason: 'runtime_apply_persistence_failed',
          recovery: 'restart_resume',
        };
      }
      return {
        applied: true,
        reason: result.appliedVia || 'direct_live_hot_auth',
        ...(result.verification ? { verification: result.verification } : {}),
      };
    },
    async verifyActiveAccount(input: RuntimeAuthVerificationInput) {
      const selection = readSelection(input);
      const expectedProviderAccountId = readString(selection?.sourceProviderAccountId);
      if (!expectedProviderAccountId) {
        return {
          status: 'unavailable',
          retryable: false,
          reason: 'missing_expected_provider_account_id',
        } as const;
      }
      if (!input.readProviderAccount) {
        return {
          status: 'unavailable',
          retryable: true,
          reason: 'active_account_probe_client_unavailable',
        } as const;
      }
      let rawAccount: unknown;
      try {
        rawAccount = await input.readProviderAccount();
      } catch (error) {
        const classification = classifyProbeError(error);
        return {
          status: 'unavailable',
          retryable: classification.retryable,
          reason: 'active_account_probe_failed',
          errorClassification: classification,
        } as const;
      }
      const nativeVerification = await input.inspectNativeAuth?.();
      const authStoreProviderAccountIdProof = nativeVerification?.status === 'verified'
        && nativeVerification.providerAccountId
        ? { status: 'resolved' as const, accountId: nativeVerification.providerAccountId }
        : nativeVerification?.status === 'mismatch'
          ? {
              status: 'conflict' as const,
              accountIds: [
                nativeVerification.expectedProviderAccountId ?? expectedProviderAccountId,
                nativeVerification.actualProviderAccountId,
              ].filter((value): value is string => Boolean(value)),
            }
          : { status: 'missing' as const };
      return verifyCodexActiveProviderAccount({
        expectedProviderAccountId,
        expectedProviderEmail: readString(selection?.sourceAccountLabel),
        rawAccount,
        authStoreProviderAccountIdProof,
      });
    },
    async probeQuota(input: RuntimeAuthUsageInput) {
      const selection = readSelection(input);
      const support = resolveCodexRuntimeQuotaProbeSupport(selection);
      if (!support.supported) {
        return {
          status: 'unsupported',
          reason: support.reason,
        };
      }
      if (!input.readProviderUsage) {
        return { status: 'unsupported' };
      }
      const { rawSnapshot } = await readCodexRuntimeRateLimitsSnapshot({
        request: async (_method, requestParams) => await input.readProviderUsage!(requestParams as never),
      });
      const observedAtMs = Date.now();
      const usageSnapshot = mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
        subject: resolveCodexUsageSubjectRef({
          connectedServiceProviderAccountId: readString(selection?.sourceProviderAccountId),
          provisionalDiscriminator: `${readString(selection?.serviceId) ?? 'openai-codex'}:${readString(selection?.profileId ?? selection?.activeProfileId) ?? 'unknown'}`,
        }),
        accountLabel: readString(selection?.sourceAccountLabel),
        observedAtMs,
        fetchedAtMs: observedAtMs,
        rawSnapshot,
      });
      return { status: 'available', usageSnapshot };
    },
    async refreshActiveProfile() {
      return {
        status: 'unsupported',
        reason: 'codex_refresh_requires_daemon_refresh_coordinator',
      };
    },
  };
}

export function createCodexConnectedAccountNativeAuthCodec(): AgentConnectedAccountNativeAuthCodecV1 {
  return {
    materialize({ credential }) {
      const record = parseCredentialRecord(credential);
      if (!record || record.kind !== 'oauth' || record.serviceId !== 'openai-codex') {
        throw new TypeError('Codex native auth materialization requires an OpenAI Codex OAuth credential');
      }
      return {
        files: {
          'auth.json': new TextEncoder().encode(JSON.stringify(buildCodexCloudAuthFile({
            accessToken: record.oauth.accessToken,
            refreshToken: record.oauth.refreshToken,
            idToken: record.oauth.idToken,
            accountId: record.oauth.providerAccountId,
            lastRefreshIso: new Date().toISOString(),
          }))),
        },
      };
    },
    inspect({ credential, files }): AgentConnectedAccountTransitionVerificationResultV1 {
      const record = parseCredentialRecord(credential);
      const expectedProviderAccountId = record?.kind === 'oauth'
        ? readString(record.oauth.providerAccountId)
        : null;
      const bytes = files['auth.json'];
      if (!expectedProviderAccountId || !bytes) {
        return { status: 'unavailable', retryable: false, reason: 'missing_expected_provider_account_id' };
      }
      let proof: ReturnType<typeof readCodexAuthStoreProviderAccountIdFromJson>;
      try {
        proof = readCodexAuthStoreProviderAccountIdFromJson(JSON.parse(new TextDecoder().decode(bytes)));
      } catch {
        proof = { status: 'missing' };
      }
      if (proof.status === 'resolved' && proof.accountId === expectedProviderAccountId) {
        return {
          status: 'verified',
          providerAccountId: proof.accountId,
          activeAccountId: proof.accountEmail ?? null,
          proofStrength: 'diagnostic',
          source: 'codex_auth_store',
        };
      }
      if (proof.status === 'resolved' || proof.status === 'conflict') {
        return {
          status: 'mismatch',
          expectedProviderAccountId,
          actualProviderAccountId: proof.status === 'resolved'
            ? proof.accountId
            : proof.accountIds.find((id) => id !== expectedProviderAccountId) ?? null,
          retryable: true,
          reason: 'provider_account_auth_store_mismatch',
        };
      }
      return { status: 'unavailable', retryable: true, reason: 'active_account_probe_missing_account_id' };
    },
  };
}
