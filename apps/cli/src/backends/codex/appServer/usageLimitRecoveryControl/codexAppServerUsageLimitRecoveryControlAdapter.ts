import { buildUsageLimitIssueFingerprint } from '@/session/usageLimitRecoveryControls/buildUsageLimitIssueFingerprint';
import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import {
  buildRecoveryCreditConsumeIdempotencyKey,
  ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionRuntimeIssueV1Schema,
  SessionUsageLimitRecoveryV1Schema,
  type ConnectedServiceQuotaRecoveryCreditsV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';

import { createConnectedServiceCredentialApi } from '@/api/connectedServices/connectedServiceCredentialApi';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { notifyDaemonConnectedServiceQuotaRecoveryCreditConsume } from '@/daemon/controlClient';
import type { Credentials } from '@/persistence';
import type {
  SessionUsageLimitRecoveryControlAdapter as GenericSessionUsageLimitRecoveryControlAdapter,
  SessionUsageLimitRecoveryControlAdapterParams,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';
import { deriveUsageLimitRecoveryTiming } from '@/session/usageLimitRecoveryControls/deriveUsageLimitRecoveryTiming';
import { resolveUsageLimitRecoveryMaxAttemptsExhaustion } from '@/session/usageLimitRecoveryControls/resolveUsageLimitRecoveryMaxAttemptsExhaustion';
import { resolveUsageLimitRecoverySelectedAuthFromIssue } from '@/session/usageLimitRecoveryControls/usageLimitRecoverySelectedAuth';
import type { CodexAppServerControlClientResult } from '../control/withCodexAppServerControlClient';
import { withCodexAppServerControlClient } from '../control/withCodexAppServerControlClient';
import { readCodexRateLimitsSnapshot } from '../readCodexRateLimitsSnapshot';
import type { CodexAppServerClient } from '../client/createCodexAppServerClient';
import {
  isCodexRateLimitSnapshotExhausted,
  readEarliestCodexRateLimitResetAtMs,
} from '../rateLimitSnapshot';
import { readCodexEnvironmentAuthTokens } from '../../cli/auth/readCodexEnvironmentAuthState';
import { mapCodexRateLimitResetCreditsToQuotaRecoveryCredits } from '../../quota/codexQuotaRecoveryCredits';
import {
  consumeCodexRateLimitResetCredit,
  fetchCodexRateLimitResetCredits,
  type CodexRateLimitResetCreditsFetch,
} from '../../quota/codexRateLimitResetCreditsClient';

type MetadataRecord = Record<string, unknown>;

const CODEX_CONNECTED_SERVICE_ID = 'openai-codex' as const;
const DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS = 3;

type CodexAppServerUsageLimitRecoveryControlResult =
  | Readonly<{ ok: true; status: 'ready' | 'waiting'; metadata: MetadataRecord }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

type RunWithControlClient = (params: Readonly<{
  cwd: string;
  metadata?: unknown;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number | null;
  run: (client: CodexAppServerClient) => Promise<unknown>;
}>) => Promise<CodexAppServerControlClientResult<unknown>>;

type ResetCreditAuth = Readonly<{
  accessToken: string;
  accountId: string | null;
}>;

type ConnectedServiceResetCreditSelectedAuth = Extract<
  SessionUsageLimitRecoveryV1['selectedAuth'],
  { kind: 'profile' | 'group' }
>;

type ResolveConnectedServiceResetCreditAuth = (params: Readonly<{
  credentials?: Credentials;
  selectedAuth: ConnectedServiceResetCreditSelectedAuth;
}>) => Promise<ResetCreditAuth | null>;

function stableError(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function normalizeCwd(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readCodexBackendMode(metadata: MetadataRecord): string | null {
  const descriptor = readRecord(metadata.agentRuntimeDescriptorV1);
  const provider = readRecord(descriptor?.provider);
  const backendMode = provider?.backendMode;
  return typeof backendMode === 'string' && backendMode.trim().length > 0 ? backendMode.trim() : null;
}

function readRecoveryIntent(metadata: MetadataRecord): SessionUsageLimitRecoveryV1 | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

function buildRecoveryIntentFromLatestUsageLimitIssue(
  params: SessionUsageLimitRecoveryControlAdapterParams,
): SessionUsageLimitRecoveryV1 | null {
  if (params.rawSession.latestTurnStatus != null && params.rawSession.latestTurnStatus !== 'failed') {
    return null;
  }

  const issueParsed = SessionRuntimeIssueV1Schema.safeParse(params.rawSession.lastRuntimeIssue);
  if (!issueParsed.success || issueParsed.data.source !== 'usage_limit' || !issueParsed.data.usageLimit) {
    return null;
  }

  const selectedAuth = resolveUsageLimitRecoverySelectedAuthFromIssue({
    issue: issueParsed.data,
    defaultNativeServiceId: CODEX_CONNECTED_SERVICE_ID,
    connectedServices: params.metadata.connectedServices ?? null,
  }) ?? { kind: 'native', serviceId: CODEX_CONNECTED_SERVICE_ID };

  const timing = deriveUsageLimitRecoveryTiming({
    occurredAtMs: issueParsed.data.occurredAt,
    resetAtMs: issueParsed.data.usageLimit.resetAtMs,
    retryAfterMs: issueParsed.data.usageLimit.retryAfterMs,
  });

  return {
    v: 1,
    status: 'waiting',
    issueFingerprint: buildUsageLimitIssueFingerprint(issueParsed.data, 'codex'),
    armedAtMs: issueParsed.data.occurredAt,
    resetAtMs: timing.resetAtMs,
    nextCheckAtMs: timing.nextCheckAtMs,
    attemptCount: 0,
    maxAttempts: DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS,
    lastProbeError: null,
    resumePromptMode: params.resumePromptMode ?? 'standard',
    selectedAuth,
  };
}

function selectAvailableResetCreditId(
  recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null | undefined,
): string | null {
  const credits = recoveryCredits?.credits ?? [];
  const available = credits.find(
    (credit) => credit.status === 'available' && typeof credit.providerCreditId === 'string' && credit.providerCreditId.trim().length > 0,
  );
  return available?.providerCreditId?.trim() ?? null;
}

function hasAvailableResetCredit(
  recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null | undefined,
): boolean {
  if (!recoveryCredits || recoveryCredits.kind !== 'usage_limit_resets') return false;
  if (recoveryCredits.availableCount > 0) return true;
  return selectAvailableResetCreditId(recoveryCredits) !== null;
}

function buildNextIntent(params: Readonly<{
  intent: SessionUsageLimitRecoveryV1;
  exhausted: boolean;
  resetAtMs: number | null;
  recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1 | null;
}>): SessionUsageLimitRecoveryV1 {
  const attemptCount = params.intent.attemptCount + 1;
  if (!params.exhausted) {
    return {
      ...params.intent,
      status: 'cancelled',
      attemptCount,
      lastProbeError: null,
      ...(params.recoveryCredits ? { recoveryCredits: params.recoveryCredits } : {}),
    };
  }
  return {
    ...params.intent,
    status: 'waiting',
    attemptCount,
    resetAtMs: params.resetAtMs ?? params.intent.resetAtMs,
    nextCheckAtMs: params.resetAtMs ?? params.intent.nextCheckAtMs ?? params.intent.resetAtMs,
    lastProbeError: null,
    ...(params.recoveryCredits ? { recoveryCredits: params.recoveryCredits } : {}),
  };
}

async function resolveConnectedServiceResetCreditAuthDefault(
  params: Readonly<{
    credentials?: Credentials;
    selectedAuth: ConnectedServiceResetCreditSelectedAuth;
  }>,
): Promise<ResetCreditAuth | null> {
  if (!params.credentials) return null;
  const profileId = params.selectedAuth.profileId;
  if (!profileId) return null;

  const api = createConnectedServiceCredentialApi(params.credentials);
  const records = await resolveConnectedServiceCredentials({
    credentials: params.credentials,
    api,
    bindings: [{
      serviceId: params.selectedAuth.serviceId,
      profileId,
    }],
  });
  const record = records.get(params.selectedAuth.serviceId);
  if (!record || record.kind !== 'oauth' || !record.oauth.accessToken.trim()) return null;
  return {
    accessToken: record.oauth.accessToken,
    accountId: record.oauth.providerAccountId,
  };
}

export function createCodexAppServerUsageLimitRecoveryControlAdapter(deps: Readonly<{
  runWithControlClient?: RunWithControlClient;
  fetchRuntime?: CodexRateLimitResetCreditsFetch;
  processEnv?: NodeJS.ProcessEnv;
  resolveConnectedServiceResetCreditAuth?: ResolveConnectedServiceResetCreditAuth;
  consumeConnectedServiceResetCredit?: (
    input: Parameters<typeof notifyDaemonConnectedServiceQuotaRecoveryCreditConsume>[0],
  ) => Promise<unknown>;
}> = {}): GenericSessionUsageLimitRecoveryControlAdapter {
  const runWithControlClient = deps.runWithControlClient ?? withCodexAppServerControlClient;
  const resolveConnectedServiceResetCreditAuth =
    deps.resolveConnectedServiceResetCreditAuth ?? resolveConnectedServiceResetCreditAuthDefault;
  const resolveNativeResetCreditAuth = (
    params: SessionUsageLimitRecoveryControlAdapterParams,
  ): Readonly<{ accessToken: string; accountId: string | null }> | null => {
    const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(params.metadata, 'codex');
    const env = {
      ...(deps.processEnv ?? process.env),
      ...(runtimeDescriptor?.homePath ? { CODEX_HOME: runtimeDescriptor.homePath } : {}),
    };
    const tokens = readCodexEnvironmentAuthTokens(env);
    const accessToken = tokens.accessToken ?? tokens.idToken;
    return accessToken ? { accessToken, accountId: tokens.accountId } : null;
  };
  const readRecoveryCreditsForIntent = async (
    params: SessionUsageLimitRecoveryControlAdapterParams,
    intent: SessionUsageLimitRecoveryV1,
  ): Promise<ConnectedServiceQuotaRecoveryCreditsV1 | null> => {
    const auth = intent.selectedAuth.kind === 'native'
      ? resolveNativeResetCreditAuth(params)
      : await resolveConnectedServiceResetCreditAuth({
        credentials: params.credentials,
        selectedAuth: intent.selectedAuth,
      });
    if (!auth) return intent.recoveryCredits ?? null;
    const result = await fetchCodexRateLimitResetCredits({
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      ...(deps.fetchRuntime ? { fetchRuntime: deps.fetchRuntime } : {}),
    });
    if (!result.ok) return intent.recoveryCredits ?? null;
    return mapCodexRateLimitResetCreditsToQuotaRecoveryCredits(result.response)
      ?? intent.recoveryCredits
      ?? null;
  };
  const runCheckNow = async (
    params: SessionUsageLimitRecoveryControlAdapterParams,
  ): Promise<CodexAppServerUsageLimitRecoveryControlResult> => {
    const backendMode = readCodexBackendMode(params.metadata);
    if (backendMode && backendMode !== 'appServer') {
      return stableError('codex_quota_probe_unsupported_for_backend_mode');
    }

    const persistedIntent = readRecoveryIntent(params.metadata);
    const intent = persistedIntent && persistedIntent.status !== 'cancelled'
      ? persistedIntent
      : buildRecoveryIntentFromLatestUsageLimitIssue(params);
    if (!intent) {
      return stableError('session_usage_limit_recovery_control_inactive');
    }

    const exhaustedIntent = resolveUsageLimitRecoveryMaxAttemptsExhaustion(intent);
    if (exhaustedIntent) {
      return {
        ok: true,
        status: 'waiting',
        metadata: {
          ...params.metadata,
          [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: exhaustedIntent,
        },
      };
    }

    const cwd = normalizeCwd(params.cwd);
    if (!cwd) return stableError('session_usage_limit_recovery_control_cwd_unavailable');

    const controlResult = await runWithControlClient({
      cwd,
      metadata: params.metadata,
      accountSettings: null,
      run: async (client) => await readCodexRateLimitsSnapshot({
        request: async (_method, requestParams) => await client.request('account/rateLimits/read', requestParams),
      }),
    });
    if (!controlResult.ok) return stableError(controlResult.errorCode);

    const exhausted = isCodexRateLimitSnapshotExhausted(controlResult.value);
    const recoveryCredits = await readRecoveryCreditsForIntent(params, intent);
    const nextIntent = buildNextIntent({
      intent,
      exhausted,
      resetAtMs: readEarliestCodexRateLimitResetAtMs(controlResult.value),
      recoveryCredits,
    });
    return {
      ok: true,
      status: exhausted ? 'waiting' : 'ready',
      metadata: {
        ...params.metadata,
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: nextIntent,
      },
    };
  };

  return {
    checkNow: async (params: SessionUsageLimitRecoveryControlAdapterParams): Promise<CodexAppServerUsageLimitRecoveryControlResult> => {
      return await runCheckNow(params);
    },
    consumeResetCredit: async (
      params: SessionUsageLimitRecoveryControlAdapterParams,
    ): Promise<CodexAppServerUsageLimitRecoveryControlResult> => {
      const persistedIntent = readRecoveryIntent(params.metadata);
      const intent = persistedIntent && persistedIntent.status !== 'cancelled'
        ? persistedIntent
        : buildRecoveryIntentFromLatestUsageLimitIssue(params);
      if (!intent) return stableError('session_usage_limit_recovery_control_inactive');
      if (intent.selectedAuth.kind !== 'native') {
        const profileId = intent.selectedAuth.profileId;
        if (!profileId) return stableError('connected_service_quota_recovery_credit_profile_unavailable');
        const consume = deps.consumeConnectedServiceResetCredit
          ?? (await import('@/daemon/controlClient')).notifyDaemonConnectedServiceQuotaRecoveryCreditConsume;
        const response = ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.safeParse(await consume({
          serviceId: intent.selectedAuth.serviceId,
          profileId,
          idempotencyKey: buildRecoveryCreditConsumeIdempotencyKey({
            serviceId: intent.selectedAuth.serviceId,
            profileId,
          }),
        }));
        if (!response.success) return stableError('connected_service_quota_recovery_credit_unsupported_response');
        const consumed = response.data;
        if (!consumed.ok) return stableError(consumed.errorCode);
        if (consumed.receipt.status === 'not_available') return stableError('no_credit');
        if (consumed.receipt.status === 'unknown_after_timeout') {
          return stableError('connected_service_quota_recovery_credit_unknown_after_timeout');
        }
        return await runCheckNow(params);
      }
      const auth = resolveNativeResetCreditAuth(params);
      if (!auth) {
        return stableError('codex_reset_credit_native_auth_unavailable');
      }

      // Prefer a concrete available credit when details contain one, while preserving
      // the provider's aggregate redemption contract for count-only/capped inventories.
      const liveRecoveryCredits = await readRecoveryCreditsForIntent(params, intent);
      const effectiveRecoveryCredits = liveRecoveryCredits ?? intent.recoveryCredits;
      const creditId = selectAvailableResetCreditId(liveRecoveryCredits)
        ?? (liveRecoveryCredits === null
          ? selectAvailableResetCreditId(intent.recoveryCredits)
          : null);
      if (!creditId && !hasAvailableResetCredit(effectiveRecoveryCredits)) {
        return stableError('codex_reset_credit_no_available_credit');
      }

      const consumed = await consumeCodexRateLimitResetCredit({
        accessToken: auth.accessToken,
        accountId: auth.accountId,
        ...(creditId ? { creditId } : {}),
        redeemRequestId: `${intent.issueFingerprint}:reset-credit`,
        ...(deps.fetchRuntime ? { fetchRuntime: deps.fetchRuntime } : {}),
      });
      if (!consumed.ok) return stableError(consumed.providerCode ?? consumed.errorCode);
      if (consumed.outcome.code === 'no_credit') return stableError('no_credit');

      return await runCheckNow(params);
    },
  };
}

export const codexAppServerUsageLimitRecoveryControlAdapter =
  createCodexAppServerUsageLimitRecoveryControlAdapter();
