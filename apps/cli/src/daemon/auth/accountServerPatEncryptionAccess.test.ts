import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { post, defaults: {} } }));

import { createAccountServerPatEncryptionAccessReader } from './accountServerPatEncryptionAccess';

const tokenId = '00000000-0000-4000-8000-000000000001';
const token = `hap_v1_${tokenId}_${'A'.repeat(43)}`;
const value = { v: 1, accountId: 'account-1', tokenId,
  encryptionAccess: { v: 1, serverIdentityId: 'srv_test', contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=',
    wrappedContentPrivateKey: 'A'.repeat(96) } };

describe('direct daemon PAT-self wrapping transport', () => {
  beforeEach(() => { post.mockReset(); });

  it('reads from the bound Home with only the caller bearer and preserves the opaque record', async () => {
    post.mockResolvedValue({ status: 200, data: value });
    let serverBaseUrl = 'https://home.example/base/';
    const read = createAccountServerPatEncryptionAccessReader({ accountId: 'account-1', get serverBaseUrl() { return serverBaseUrl; } });
    await expect(read(token)).resolves.toEqual({ statusCode: 200, body: value });
    expect(post).toHaveBeenCalledWith('https://home.example/base/v1/auth/api-tokens/encryption-access', {},
      expect.objectContaining({ headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }));
    serverBaseUrl = 'http://127.0.0.1:43361';
    await expect(read(token)).resolves.toEqual({ statusCode: 200, body: value });
    expect(post.mock.calls.at(-1)?.[0]).toBe(`${serverBaseUrl}/v1/auth/api-tokens/encryption-access`);
  });

  it('does not cache wrapping records and rejects another token or Account', async () => {
    post.mockResolvedValueOnce({ status: 200, data: value })
      .mockResolvedValueOnce({ status: 409, data: { error: 'api_token_encryption_stale' } })
      .mockResolvedValueOnce({ status: 200, data: { ...value, accountId: 'other' } })
      .mockResolvedValueOnce({ status: 200, data: { ...value, tokenId: '00000000-0000-4000-8000-000000000002' } });
    const read = createAccountServerPatEncryptionAccessReader({ accountId: 'account-1', serverBaseUrl: 'https://home.example' });
    await expect(read(token)).resolves.toEqual({ statusCode: 200, body: value });
    await expect(read(token)).resolves.toEqual({ statusCode: 409, body: { error: 'api_token_encryption_stale' } });
    await expect(read(token)).resolves.toEqual({ statusCode: 503, body: { error: 'auth_unavailable' } });
    await expect(read(token)).resolves.toEqual({ statusCode: 503, body: { error: 'auth_unavailable' } });
  });

  it('rejects combined/malformed credentials before HTTP and redacts upstream exceptions', async () => {
    const read = createAccountServerPatEncryptionAccessReader({ accountId: 'account-1', serverBaseUrl: 'https://home.example' });
    await expect(read('hapc_v1_do-not-forward')).resolves.toEqual({ statusCode: 401, body: { error: 'invalid_token' } });
    expect(post).not.toHaveBeenCalled();
    post.mockRejectedValue(new Error('sensitive-upstream-diagnostic'));
    await expect(read(token)).resolves.toEqual({ statusCode: 503, body: { error: 'auth_unavailable' } });
  });
});
