import { describe, expect, it } from 'vitest';

import {
  readCodexActiveProviderAccount,
  readCodexAuthStoreProviderAccountIdProofFromValue,
  readCodexAuthStoreProviderAccountIdFromJson,
  verifyCodexActiveProviderAccount,
} from './accountId.js';

function buildJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig',
  ].join('.');
}

describe('readCodexAuthStoreProviderAccountId', () => {
  it.each([
    ['chatgpt', 'chatgpt'], ['apiKey', 'apiKey'], ['other', undefined],
  ])('retains only recognized native account auth type %s', (type, expected) => {
    expect(readCodexActiveProviderAccount({ account: { type } }).authType).toBe(expected);
  });
  it.each([
    ['free', 'personal'], ['go', 'personal'], ['plus', 'personal'], ['pro', 'personal'], ['prolite', 'personal'], ['promax', 'personal'],
    ['team', 'workspace'], ['self_serve_business_prolite', 'workspace'], ['self_serve_business_usage_based', 'workspace'],
    ['business', 'workspace'], ['ent26', 'workspace'], ['enterprise_cbp_automation', 'workspace'],
    ['enterprise_cbp_usage_based', 'workspace'], ['enterprise', 'workspace'], ['edu', 'workspace'], ['edu_plus', 'workspace'], ['edu_pro', 'workspace'],
  ])('classifies supported Codex 0.162.1 native plan %s as %s', (planType, accountScope) => {
    expect(readCodexActiveProviderAccount({ account: { type: 'chatgpt', planType } })).toMatchObject({ accountScope });
  });

  it.each([
    { account: { type: 'chatgpt', planType: 'unknown' } },
    { account: { type: 'chatgpt', planType: 'sci' } },
    { account: { type: 'chatgpt' } },
    { account: { type: 'apiKey', planType: 'plus' } },
    { profile: { planType: 'plus' } },
  ])('does not infer scope from missing, unsupported or non-ChatGPT native plans', (value) => {
    expect(readCodexActiveProviderAccount(value)).not.toHaveProperty('accountScope');
  });
  it('uses the native workspace routing identity instead of a legacy account id', () => {
    expect(readCodexActiveProviderAccount({
      account: { type: 'chatgpt', id: 'legacy-account', email: 'runtime@example.test' },
      workspaceRouting: { chatgptAccountId: 'workspace-runtime' },
    })).toEqual({ authType: 'chatgpt', providerAccountId: 'workspace-runtime', providerEmail: 'runtime@example.test' });
  });

  it('reads the connected-service flat Codex auth account id', () => {
    expect(readCodexAuthStoreProviderAccountIdFromJson({
      auth_mode: 'chatgpt',
      account_id: 'acct_flat',
      tokens: {
        account_id: 'acct_flat',
      },
    })).toEqual({ status: 'resolved', accountId: 'acct_flat' });
  });

  it('returns a conflict when auth-store account-id aliases disagree', () => {
    expect(readCodexAuthStoreProviderAccountIdFromJson({
      auth_mode: 'chatgpt',
      account_id: 'acct_flat',
      tokens: {
        account_id: 'acct_tokens',
      },
    })).toEqual({
      status: 'conflict',
      accountIds: ['acct_flat', 'acct_tokens'],
    });
  });

  it('reads the upstream Codex token account id', () => {
    expect(readCodexAuthStoreProviderAccountIdFromJson({
      auth_mode: 'chatgptAuthTokens',
      tokens: {
        access_token: 'redacted',
        refresh_token: 'redacted',
        account_id: 'acct_tokens',
      },
    })).toEqual({
      status: 'resolved',
      accountId: 'acct_tokens',
    });
  });

  it('reads the upstream Codex token account id and email from an id_token JWT', () => {
    expect(readCodexAuthStoreProviderAccountIdFromJson({
      auth_mode: 'chatgptAuthTokens',
      tokens: {
        access_token: 'redacted',
        refresh_token: 'redacted',
        id_token: buildJwt({
          chatgpt_account_id: 'acct_from_jwt',
          email: 'codex-user@example.test',
        }),
      },
    })).toEqual({
      status: 'resolved',
      accountId: 'acct_from_jwt',
      accountEmail: 'codex-user@example.test',
    });
  });

  it('reads Codex account/read account ids and emails from current and legacy response shapes', () => {
    expect(readCodexActiveProviderAccount({
      account: { type: 'chatgpt', email: '  Work@Example.Test  ' },
      requiresOpenaiAuth: true,
    })).toEqual({
      authType: 'chatgpt',
      providerAccountId: null,
      providerEmail: 'work@example.test',
    });
    expect(readCodexActiveProviderAccount({
      auth: { account_id: 'acct-auth' },
      profile: { email: 'profile@example.test' },
    })).toEqual({
      providerAccountId: 'acct-auth',
      providerEmail: 'profile@example.test',
    });
    expect(readCodexActiveProviderAccount({
      chatgpt_account_id: 'acct-chatgpt-root',
      auth: { chatgpt_account_id: 'acct-chatgpt-auth' },
    })).toEqual({
      providerAccountId: 'acct-chatgpt-root',
      providerEmail: null,
    });
  });

  it('normalizes auth-store account-id proof values from host callbacks', () => {
    expect(readCodexAuthStoreProviderAccountIdProofFromValue(' acct-work ')).toEqual({
      status: 'resolved',
      accountId: 'acct-work',
    });
    expect(readCodexAuthStoreProviderAccountIdProofFromValue({
      status: 'conflict',
      accountIds: ['acct-work', ' ', 'acct-old'],
    })).toEqual({
      status: 'conflict',
      accountIds: ['acct-work', 'acct-old'],
    });
    expect(readCodexAuthStoreProviderAccountIdProofFromValue({
      status: 'resolved',
      accountId: 'acct-work',
      accountEmail: 'codex-user@example.test',
    })).toEqual({
      status: 'resolved',
      accountId: 'acct-work',
      accountEmail: 'codex-user@example.test',
    });
  });

  it('does not accept Codex account adoption from auth-store proof when account/read omits the account id', () => {
    expect(verifyCodexActiveProviderAccount({
      expectedProviderAccountId: 'acct-work',
      expectedProviderEmail: 'work@example.test',
      rawAccount: {
        account: { type: 'chatgpt', email: '  Work@Example.Test  ' },
        requiresOpenaiAuth: true,
      },
      authStoreProviderAccountIdProof: { status: 'resolved', accountId: 'acct-work' },
    })).toEqual({
      status: 'unavailable',
      retryable: true,
      reason: 'active_account_probe_missing_account_id',
    });
  });

  it('does not treat missing account/read email as a Codex adoption mismatch without a live account id', () => {
    expect(verifyCodexActiveProviderAccount({
      expectedProviderAccountId: 'acct-work',
      expectedProviderEmail: 'work@example.test',
      rawAccount: {
        account: { type: 'chatgpt' },
        requiresOpenaiAuth: true,
      },
      authStoreProviderAccountIdProof: { status: 'resolved', accountId: 'acct-work' },
    })).toEqual({
      status: 'unavailable',
      retryable: true,
      reason: 'active_account_probe_missing_account_id',
    });
  });

  it('does not accept Codex account adoption from matching email when account/read omits the account id', () => {
    expect(verifyCodexActiveProviderAccount({
      expectedProviderAccountId: 'acct-work',
      expectedProviderEmail: 'work@example.test',
      rawAccount: {
        account: { type: 'chatgpt', email: '  Work@Example.Test  ' },
        requiresOpenaiAuth: true,
      },
      authStoreProviderAccountIdProof: { status: 'missing' },
    })).toEqual({
      status: 'unavailable',
      retryable: true,
      reason: 'active_account_probe_missing_account_id',
    });
  });

  it('does not treat mismatching account/read email as a Codex adoption mismatch without a live account id', () => {
    expect(verifyCodexActiveProviderAccount({
      expectedProviderAccountId: 'acct-work',
      expectedProviderEmail: 'work@example.test',
      rawAccount: {
        account: { type: 'chatgpt', email: 'other@example.test' },
        requiresOpenaiAuth: true,
      },
      authStoreProviderAccountIdProof: { status: 'resolved', accountId: 'acct-work' },
    })).toEqual({
      status: 'unavailable',
      retryable: true,
      reason: 'active_account_probe_missing_account_id',
    });
  });

  it('reports a retryable missing-account-id proof when neither active account nor auth store exposes an id', () => {
    expect(verifyCodexActiveProviderAccount({
      expectedProviderAccountId: 'acct-work',
      expectedProviderEmail: null,
      rawAccount: {
        account: { type: 'chatgpt' },
        requiresOpenaiAuth: true,
      },
      authStoreProviderAccountIdProof: { status: 'missing' },
    })).toEqual({
      status: 'unavailable',
      retryable: true,
      reason: 'active_account_probe_missing_account_id',
    });
  });

  it('reports retryable mismatches for stale active accounts or conflicting auth-store ids', () => {
    expect(verifyCodexActiveProviderAccount({
      expectedProviderAccountId: 'acct-work',
      expectedProviderEmail: null,
      rawAccount: { chatgptAccountId: 'acct-old' },
      authStoreProviderAccountIdProof: { status: 'missing' },
    })).toEqual({
      status: 'mismatch',
      expectedProviderAccountId: 'acct-work',
      actualProviderAccountId: 'acct-old',
      retryable: true,
      reason: 'provider_account_adoption_mismatch',
    });
    expect(verifyCodexActiveProviderAccount({
      expectedProviderAccountId: 'acct-work',
      expectedProviderEmail: 'work@example.test',
      rawAccount: { account: { email: 'work@example.test' } },
      authStoreProviderAccountIdProof: {
        status: 'conflict',
        accountIds: ['acct-work', 'acct-old'],
      },
    })).toEqual({
      status: 'mismatch',
      expectedProviderAccountId: 'acct-work',
      actualProviderAccountId: 'acct-old',
      retryable: true,
      reason: 'provider_account_auth_store_conflict',
    });
  });
});
