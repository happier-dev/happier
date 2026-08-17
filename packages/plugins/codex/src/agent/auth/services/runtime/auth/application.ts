import type {
  OauthCredentialRecord,
  TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';

type CodexLoginStartClient = Readonly<{
  request: (method: string, params?: unknown) => Promise<unknown>;
}>;

export type CodexConnectedServiceRefreshSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: 'openai-codex';
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: 'openai-codex';
      groupId: string;
      activeProfileId: string;
      fallbackProfileId?: string | null;
      generation: number;
    }>;

export type CodexConnectedServiceRefreshSelectionRollback = () => Promise<void> | void;

export type CodexHotApplyEligibility =
  | Readonly<{ eligible: true }>
  | Readonly<{
      eligible: false;
      reason: 'auth_family_mismatch' | 'credential_family_mismatch' | 'workspace_incompatible';
    }>;

export type CodexDirectLiveAuthApplyFailureReason =
  | 'auth_family_mismatch'
  | 'credential_family_mismatch'
  | 'workspace_incompatible'
  | 'provider_account_identity_unavailable'
  | 'refresh_bridge_selection_update_failed'
  | 'experimental_api_unavailable'
  | 'live_hot_auth_failed';

export type CodexDirectLiveAuthApplyResult =
  | Readonly<{
      applied: true;
      appliedVia: 'direct_live_hot_auth';
      activeAccountId: string;
      durability:
        | Readonly<{ persisted: true }>
        | Readonly<{
            persisted: false;
            errorCode:
              | 'auth_store_persistence_unavailable_after_live_apply'
              | 'auth_store_persistence_failed_after_live_apply';
          }>;
    }>
  | Readonly<{
      applied: false;
      reason: CodexDirectLiveAuthApplyFailureReason;
      appliedVia?: 'direct_live_hot_auth';
      activeAccountId?: string;
      recovery?: 'restart_resume';
    }>;

function normalizeOptionalId(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function requireConnectedServiceOauthCredentialRecord(
  record: OauthCredentialRecord | TokenCredentialRecord,
): OauthCredentialRecord {
  if (record.kind !== 'oauth') {
    throw new Error(`Connected service record '${record.serviceId}' is not an OAuth credential`);
  }
  return record;
}

export function evaluateCodexConnectedServiceHotApplyEligibility(params: Readonly<{
  candidate: OauthCredentialRecord | TokenCredentialRecord;
  forcedWorkspaceId: string | null;
  forcedLoginMethod?: string | null;
}>): CodexHotApplyEligibility {
  if (params.candidate.kind !== 'oauth' || params.candidate.serviceId !== 'openai-codex') {
    return { eligible: false, reason: 'auth_family_mismatch' };
  }
  const forcedLoginMethod = normalizeOptionalId(params.forcedLoginMethod);
  if (
    forcedLoginMethod
    && forcedLoginMethod !== 'chatgpt'
    && forcedLoginMethod !== 'chatgptAuthTokens'
  ) {
    return { eligible: false, reason: 'credential_family_mismatch' };
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

function readCodexCredentialProviderAccountId(record: OauthCredentialRecord | TokenCredentialRecord): string | null {
  if (record.kind !== 'oauth' || record.serviceId !== 'openai-codex') return null;
  return normalizeOptionalId(record.oauth.providerAccountId);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Readonly<Record<string, unknown>>;
    return [record.message, record.error, record.code, record.reason]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
  }
  return '';
}

function readErrorCode(error: unknown): number | string | null {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const code = (error as Readonly<Record<string, unknown>>).code;
  return typeof code === 'number' || typeof code === 'string' ? code : null;
}

function classifyCodexLoginStartError(error: unknown): CodexDirectLiveAuthApplyResult {
  const message = readErrorMessage(error).toLowerCase();
  const code = readErrorCode(error);
  if (
    code === -32601
    || message.includes('method not found')
    || (message.includes('chatgptauthtokens') && (message.includes('unknown') || message.includes('unsupported')))
    || (message.includes('experimental') && message.includes('api'))
  ) {
    return { applied: false, reason: 'experimental_api_unavailable' };
  }
  if (
    message.includes('forced_chatgpt_workspace_id')
    || message.includes('workspace')
    || message.includes('chatgptaccountid')
  ) {
    return { applied: false, reason: 'workspace_incompatible' };
  }
  if (message.includes('forced_login_method') || message.includes('login method')) {
    return { applied: false, reason: 'credential_family_mismatch' };
  }
  return { applied: false, reason: 'live_hot_auth_failed' };
}

export async function applyCodexConnectedServiceAuthGeneration(params: Readonly<{
  client: CodexLoginStartClient;
  candidate: OauthCredentialRecord | TokenCredentialRecord;
  forcedWorkspaceId: string | null;
  forcedLoginMethod?: string | null;
  persistAuthStore?: (() => Promise<void> | void) | null;
  refreshSelection?: CodexConnectedServiceRefreshSelection | null;
  updateRefreshSelection?: ((
    selection: CodexConnectedServiceRefreshSelection,
  ) => Promise<CodexConnectedServiceRefreshSelectionRollback | void> | CodexConnectedServiceRefreshSelectionRollback | void) | null;
}>): Promise<CodexDirectLiveAuthApplyResult> {
  const eligibility = evaluateCodexConnectedServiceHotApplyEligibility({
    candidate: params.candidate,
    forcedWorkspaceId: params.forcedWorkspaceId,
    forcedLoginMethod: params.forcedLoginMethod,
  });
  if (!eligibility.eligible) return { applied: false, reason: eligibility.reason };

  const accountId = readCodexCredentialProviderAccountId(params.candidate);
  if (!accountId) {
    return { applied: false, reason: 'provider_account_identity_unavailable' };
  }

  if (params.refreshSelection && typeof params.updateRefreshSelection !== 'function') {
    return { applied: false, reason: 'refresh_bridge_selection_update_failed' };
  }

  let rollbackRefreshSelection: CodexConnectedServiceRefreshSelectionRollback | null = null;
  if (params.refreshSelection) {
    try {
      const rollback = await params.updateRefreshSelection?.(params.refreshSelection);
      rollbackRefreshSelection = typeof rollback === 'function' ? rollback : null;
    } catch {
      return { applied: false, reason: 'refresh_bridge_selection_update_failed' };
    }
  }

  const record = requireConnectedServiceOauthCredentialRecord(params.candidate);
  try {
    await params.client.request('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: record.oauth.accessToken,
      chatgptAccountId: accountId,
    });
  } catch (error) {
    if (params.refreshSelection) {
      if (!rollbackRefreshSelection) {
        return { applied: false, reason: 'refresh_bridge_selection_update_failed' };
      }
      try {
        await rollbackRefreshSelection();
      } catch {
        return { applied: false, reason: 'refresh_bridge_selection_update_failed' };
      }
    }
    return classifyCodexLoginStartError(error);
  }

  if (typeof params.persistAuthStore !== 'function') {
    return {
      applied: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: accountId,
      durability: {
        persisted: false,
        errorCode: 'auth_store_persistence_unavailable_after_live_apply',
      },
    };
  }

  try {
    await params.persistAuthStore();
  } catch {
    return {
      applied: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: accountId,
      durability: {
        persisted: false,
        errorCode: 'auth_store_persistence_failed_after_live_apply',
      },
    };
  }

  return {
    applied: true,
    appliedVia: 'direct_live_hot_auth',
    activeAccountId: accountId,
    durability: { persisted: true },
  };
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
