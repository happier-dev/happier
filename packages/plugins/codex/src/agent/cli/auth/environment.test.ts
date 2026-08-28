import { describe, expect, it } from 'vitest';

import { readCodexAuthTokensFromJson } from './environment.js';

function buildJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

describe('readCodexAuthTokensFromJson', () => {
  it('ignores expired credentials-file tokens', () => {
    expect(readCodexAuthTokensFromJson({
      tokens: { id_token: buildJwt({ email: 'expired@example.test', exp: 1 }) },
    })).toEqual({
      idToken: null,
      accessToken: null,
      accountId: null,
      accountLabel: null,
    });
  });

  it('reads usable credentials-file access tokens and ChatGPT account ids', () => {
    expect(readCodexAuthTokensFromJson({
        tokens: {
          id_token: buildJwt({
            email: 'valid@example.test',
            chatgpt_account_id: 'acct-chatgpt',
            exp: 4_102_444_800,
          }),
          access_token: buildJwt({ exp: 4_102_444_800 }),
        },
      })).toEqual({
      idToken: expect.any(String),
      accessToken: expect.any(String),
      accountId: 'acct-chatgpt',
      accountLabel: 'valid@example.test',
    });
  });

  it('reads an exact account id from the Codex auth store', () => {
    expect(readCodexAuthTokensFromJson({
        tokens: {
          id_token: buildJwt({ email: 'valid@example.test', exp: 4_102_444_800 }),
          access_token: buildJwt({ exp: 4_102_444_800 }),
          account_id: 'acct-from-store',
        },
      })).toEqual({
      idToken: expect.any(String),
      accessToken: expect.any(String),
      accountId: 'acct-from-store',
      accountLabel: 'valid@example.test',
    });
  });

  it('rejects malformed auth-store JSON values', () => {
    expect(readCodexAuthTokensFromJson('not-an-object')).toEqual({
      idToken: null,
      accessToken: null,
      accountId: null,
      accountLabel: null,
    });
  });
});
