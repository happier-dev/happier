import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

type CodexLoginStartClient = Readonly<{
  request: (method: string, params?: unknown) => Promise<unknown>;
}>;

export type CodexHotApplyEligibility =
  | Readonly<{ eligible: true }>
  | Readonly<{ eligible: false; reason: 'auth_family_mismatch' | 'workspace_incompatible' }>;

function normalizeOptionalId(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function requireConnectedServiceOauthCredentialRecord(
  record: ConnectedServiceCredentialRecordV1,
): Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }> {
  if (record.kind !== 'oauth') {
    throw new Error(`Connected service record '${record.serviceId}' is not an OAuth credential`);
  }
  return record;
}

export function evaluateCodexConnectedServiceHotApplyEligibility(params: Readonly<{
  candidate: ConnectedServiceCredentialRecordV1;
  forcedWorkspaceId: string | null;
}>): CodexHotApplyEligibility {
  if (params.candidate.kind !== 'oauth' || params.candidate.serviceId !== 'openai-codex') {
    return { eligible: false, reason: 'auth_family_mismatch' };
  }
  const forcedWorkspaceId = normalizeOptionalId(params.forcedWorkspaceId);
  if (forcedWorkspaceId) {
    const candidateAccountId = normalizeOptionalId(params.candidate.oauth.providerAccountId);
    if (candidateAccountId !== forcedWorkspaceId) {
      return { eligible: false, reason: 'workspace_incompatible' };
    }
  }
  return { eligible: true };
}

export async function applyCodexConnectedServiceAuthGeneration(params: Readonly<{
  client: CodexLoginStartClient;
  candidate: ConnectedServiceCredentialRecordV1;
  forcedWorkspaceId: string | null;
  invalidateTransports?: (() => Promise<void> | void) | null;
}>): Promise<
  | Readonly<{ applied: true; via: 'hot' }>
  | Readonly<{
    applied: false;
    reason: 'auth_family_mismatch' | 'workspace_incompatible';
  }>
  | Readonly<{
    applied: false;
    reason: 'transport_invalidation_unavailable' | 'transport_invalidation_failed';
    recovery: 'restart_resume';
  }>
> {
  const eligibility = evaluateCodexConnectedServiceHotApplyEligibility({
    candidate: params.candidate,
    forcedWorkspaceId: params.forcedWorkspaceId,
  });
  if (!eligibility.eligible) return { applied: false, reason: eligibility.reason };
  if (typeof params.invalidateTransports !== 'function') {
    return {
      applied: false,
      reason: 'transport_invalidation_unavailable',
      recovery: 'restart_resume',
    };
  }

  const record = requireConnectedServiceOauthCredentialRecord(params.candidate);
  await params.client.request('account/login/start', {
    type: 'chatgptAuthTokens',
    accessToken: record.oauth.accessToken,
    chatgptAccountId: record.oauth.providerAccountId,
  });
  try {
    await params.invalidateTransports();
  } catch {
    return {
      applied: false,
      reason: 'transport_invalidation_failed',
      recovery: 'restart_resume',
    };
  }
  return { applied: true, via: 'hot' };
}

export async function recoverCodexConnectedServiceRestartResumeOnce(params: Readonly<{
  attemptsSoFar: number;
  restartAndResume: () => Promise<Readonly<{ resumed: true }>>;
}>): Promise<
  | Readonly<{ recovered: true; via: 'restart' }>
  | Readonly<{ recovered: false; reason: 'retry_limit_reached' }>
> {
  if (params.attemptsSoFar >= 1) {
    return { recovered: false, reason: 'retry_limit_reached' };
  }
  await params.restartAndResume();
  return { recovered: true, via: 'restart' };
}
