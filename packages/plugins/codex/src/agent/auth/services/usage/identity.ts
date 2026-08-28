import { createHash } from 'node:crypto';

import type {
  OauthCredentialRecord,
  TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';

import type {
  CodexActiveProviderAccount,
  CodexAuthStoreProviderAccountIdProof,
} from '../runtime/auth/accountId.js';

export type CodexUsageSubjectRef =
  | Readonly<{
      providerId: 'openai-codex';
      kind: 'providerSubject';
      accountSubjectId: string;
      proof: 'live_app_server_account_id' | 'connected_service_provider_account_id' | 'auth_store_chatgpt_account_id';
    }>
  | Readonly<{
      providerId: 'openai-codex';
      kind: 'provisionalLocalSubject';
      accountSubjectId: string;
      reason:
        | 'missing_stable_provider_account_id'
        | 'conflicting_auth_store_provider_account_ids'
        | 'conflicting_provider_account_ids';
    }>;

export type ResolveCodexUsageSubjectRefInput = Readonly<{
  connectedServiceRecord?: OauthCredentialRecord | TokenCredentialRecord | null;
  connectedServiceProviderAccountId?: string | null;
  liveProviderAccount?: CodexActiveProviderAccount | null;
  authStoreProviderAccountIdProof?: CodexAuthStoreProviderAccountIdProof | null;
  provisionalDiscriminator?: string | null;
  accountLabel?: string | null;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readProviderAccountId(record: OauthCredentialRecord | TokenCredentialRecord | null | undefined): string | null {
  if (!record || record.kind !== 'oauth') return null;
  const value = record.oauth.providerAccountId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readLiveProviderAccountId(account: CodexActiveProviderAccount | null | undefined): string | null {
  const value = account?.providerAccountId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hashProvisionalSubject(discriminator: string): string {
  return createHash('sha256')
    .update(`openai-codex:${discriminator}`)
    .digest('hex')
    .slice(0, 24);
}

function readProvisionalDiscriminator(input: ResolveCodexUsageSubjectRefInput): string {
  if (typeof input.provisionalDiscriminator === 'string' && input.provisionalDiscriminator.trim()) {
    return input.provisionalDiscriminator.trim();
  }
  const record = input.connectedServiceRecord;
  if (record) return `${record.serviceId}:${record.profileId}`;
  throw new Error('Codex provisional subject discriminator is required when stable provider account id evidence is unavailable');
}

export function resolveCodexUsageSubjectRef(input: ResolveCodexUsageSubjectRefInput): CodexUsageSubjectRef {
  const liveProviderAccountId = readLiveProviderAccountId(input.liveProviderAccount);
  if (liveProviderAccountId) {
    return {
      providerId: 'openai-codex',
      kind: 'providerSubject',
      accountSubjectId: liveProviderAccountId,
      proof: 'live_app_server_account_id',
    };
  }

  const connectedServiceProviderAccountId = readProviderAccountId(input.connectedServiceRecord);
  const selectedProviderAccountId = readString(input.connectedServiceProviderAccountId);
  const authStoreProof = input.authStoreProviderAccountIdProof;
  const effectiveConnectedServiceProviderAccountId = selectedProviderAccountId ?? connectedServiceProviderAccountId;
  if (
    effectiveConnectedServiceProviderAccountId
    && (
      authStoreProof?.status === 'conflict'
      || (authStoreProof?.status === 'resolved' && authStoreProof.accountId !== effectiveConnectedServiceProviderAccountId)
    )
  ) {
    return {
      providerId: 'openai-codex',
      kind: 'provisionalLocalSubject',
      accountSubjectId: `provisional:${hashProvisionalSubject(readProvisionalDiscriminator(input))}`,
      reason: authStoreProof.status === 'conflict'
        ? 'conflicting_auth_store_provider_account_ids'
        : 'conflicting_provider_account_ids',
    };
  }
  if (effectiveConnectedServiceProviderAccountId) {
    return {
      providerId: 'openai-codex',
      kind: 'providerSubject',
      accountSubjectId: effectiveConnectedServiceProviderAccountId,
      proof: 'connected_service_provider_account_id',
    };
  }

  if (authStoreProof?.status === 'resolved') {
    return {
      providerId: 'openai-codex',
      kind: 'providerSubject',
      accountSubjectId: authStoreProof.accountId,
      proof: 'auth_store_chatgpt_account_id',
    };
  }

  return {
    providerId: 'openai-codex',
    kind: 'provisionalLocalSubject',
    accountSubjectId: `provisional:${hashProvisionalSubject(readProvisionalDiscriminator(input))}`,
    reason: authStoreProof?.status === 'conflict'
      ? 'conflicting_auth_store_provider_account_ids'
      : 'missing_stable_provider_account_id',
  };
}
