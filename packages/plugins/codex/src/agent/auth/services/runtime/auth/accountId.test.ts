import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  readCodexActiveProviderAccount,
  readCodexAuthStoreProviderAccountIdProofFromValue,
  readCodexAuthStoreProviderAccountId,
  readCodexAuthStoreProviderAccountIdFromJson,
  verifyCodexActiveProviderAccount,
} from './accountId.js';

async function withTempDir<T>(prefix: string, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function buildJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig',
  ].join('.');
}

describe('readCodexAuthStoreProviderAccountId', () => {
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

  it('reads the upstream Codex token account id', async () => {
    await withTempDir('happier-codex-auth-store-', async (root) => {
      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
        auth_mode: 'chatgptAuthTokens',
        tokens: {
          access_token: 'redacted',
          refresh_token: 'redacted',
          account_id: 'acct_tokens',
        },
      }));

      await expect(readCodexAuthStoreProviderAccountId(codexHome)).resolves.toEqual({
        status: 'resolved',
        accountId: 'acct_tokens',
      });
    });
  });

  it('reads the upstream Codex token account id and email from an id_token JWT', async () => {
    await withTempDir('happier-codex-auth-store-', async (root) => {
      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
        auth_mode: 'chatgptAuthTokens',
        tokens: {
          access_token: 'redacted',
          refresh_token: 'redacted',
          id_token: buildJwt({
            chatgpt_account_id: 'acct_from_jwt',
            email: 'codex-user@example.test',
          }),
        },
      }));

      await expect(readCodexAuthStoreProviderAccountId(codexHome)).resolves.toEqual({
        status: 'resolved',
        accountId: 'acct_from_jwt',
        accountEmail: 'codex-user@example.test',
      });
    });
  });

  it('reads Codex account/read account ids and emails from current and legacy response shapes', () => {
    expect(readCodexActiveProviderAccount({
      account: { type: 'chatgpt', email: '  Work@Example.Test  ' },
      requiresOpenaiAuth: true,
    })).toEqual({
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

  it('verifies email-only Codex account/read responses against the materialized auth-store account id', () => {
    expect(verifyCodexActiveProviderAccount({
      expectedProviderAccountId: 'acct-work',
      expectedProviderEmail: 'work@example.test',
      rawAccount: {
        account: { type: 'chatgpt', email: '  Work@Example.Test  ' },
        requiresOpenaiAuth: true,
      },
      authStoreProviderAccountIdProof: { status: 'resolved', accountId: 'acct-work' },
    })).toEqual({
      status: 'verified',
      providerAccountId: 'acct-work',
      reason: 'provider_account_auth_store_and_email_verified',
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
