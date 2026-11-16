import { describe, expect, it, vi } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import {
  buildCliApiTokenContinuationEnvironment,
  CLI_API_TOKEN_HANDOFF_ENV,
  resolveCliApiToken,
  resolveCliApiTokenForSdk,
  stripCliApiTokenEnvironment,
  takePrefixCliApiTokenFlag,
  takeCliApiTokenEnvironment,
  withCliApiToken,
} from './cliApiToken';

const bearer = `hap_v1_123e4567-e89b-42d3-a456-426614174000_${'A'.repeat(43)}`;
const credential = formatAccountApiTokenCredentialV1({
  bearer,
  wrappingSecret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
  serverIdentityId: 'srv_sdk',
  accountId: 'account-1',
  contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=',
});

describe('CLI encryption-capable credential custody', () => {
  it('keeps ambient credentials and continuation handoffs in each concurrent hosted Session', async () => {
    const secondBearer = bearer.replace('123e4567', '223e4567');
    vi.stubEnv('HAPPIER_TOKEN', 'host-token-must-not-be-read');
    const observe = (token: string) => runAddedHostedSession({ environment: { NODE_ENV: 'test', HAPPIER_TOKEN: token },
      workingDirectory: '/session/token', end() {} }, async () => {
      await Promise.resolve();
      expect(resolveCliApiToken()).toBe(token);
      expect(buildCliApiTokenContinuationEnvironment()).toEqual({ [CLI_API_TOKEN_HANDOFF_ENV]: token });
    });
    try {
      await Promise.all([observe(bearer), observe(secondBearer)]);
      await runAddedHostedSession({ environment: { NODE_ENV: 'test', HAPPIER_TOKEN: credential },
        workingDirectory: '/session/sdk', end() {} }, async () => {
        expect(resolveCliApiTokenForSdk(bearer)).toBe(credential);
      });
      expect(process.env.HAPPIER_TOKEN).toBe('host-token-must-not-be-read');
    } finally { vi.unstubAllEnvs(); }
  });

  it('keeps the compound credential local to the SDK and refuses child continuation without disclosing it', async () => {
    const selected = takePrefixCliApiTokenFlag(['--api-token', credential, 'actions']);
    expect(selected?.rest).toEqual(['actions']);
    await withCliApiToken(selected!.token, async () => {
      expect(resolveCliApiToken({})).toBe(bearer);
      expect(resolveCliApiTokenForSdk(bearer, {})).toBe(credential);
      expect(resolveCliApiTokenForSdk('another-bearer', {})).toBe('another-bearer');
      expect(() => buildCliApiTokenContinuationEnvironment({})).toThrowError(
        expect.objectContaining({ code: 'api_token_child_continuation_unsupported' }),
      );
      try {
        buildCliApiTokenContinuationEnvironment({});
        expect.fail('Compound credential was admitted to child continuation');
      } catch (error) {
        expect(String(error)).not.toContain(credential);
        expect(String(error)).not.toContain(bearer);
      }
      expect(stripCliApiTokenEnvironment({ happier_token: credential, [CLI_API_TOKEN_HANDOFF_ENV]: credential, PATH: '/bin' }))
        .toEqual({ PATH: '/bin' });
    });
    expect(resolveCliApiToken({})).toBeNull();
    expect(resolveCliApiTokenForSdk(bearer, {})).toBe(bearer);
  });

  it('consumes only the admitted Session token while preserving host credentials', async () => {
    vi.stubEnv('HAPPIER_TOKEN', 'host-token-must-not-be-consumed');
    const observe = (token: string) => {
      const environment = { NODE_ENV: 'test' as const, HAPPIER_TOKEN: token, [CLI_API_TOKEN_HANDOFF_ENV]: token };
      return runAddedHostedSession({ environment, workingDirectory: '/session/consume', end() {} }, async () => {
        await Promise.resolve();
        expect(takeCliApiTokenEnvironment()).toEqual({ token, source: 'HAPPIER_TOKEN' });
        expect(environment).toEqual({ NODE_ENV: 'test' });
      });
    };
    try {
      await Promise.all([observe(bearer), observe(bearer.replace('123e4567', '223e4567'))]);
      expect(process.env.HAPPIER_TOKEN).toBe('host-token-must-not-be-consumed');
    } finally { vi.unstubAllEnvs(); }
  });

  it('preserves the existing one-shot tmux handoff for an ordinary bearer', async () => {
    await withCliApiToken(bearer, async () => {
      expect(buildCliApiTokenContinuationEnvironment({})).toEqual({
        [CLI_API_TOKEN_HANDOFF_ENV]: bearer,
      });
    });
  });

  it('consumes the same parser for ambient credentials and never includes malformed local secrets in errors', () => {
    expect(resolveCliApiToken({ HAPPIER_TOKEN: credential })).toBe(bearer);
    expect(resolveCliApiTokenForSdk(bearer, { HAPPIER_TOKEN: credential })).toBe(credential);
    const malformed = `${credential}private-sentinel`;
    try {
      takePrefixCliApiTokenFlag(['--api-token', malformed]);
      expect.fail('Malformed local credential was admitted');
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_arguments' });
      expect(String(error)).not.toContain(malformed);
    }
  });
});
