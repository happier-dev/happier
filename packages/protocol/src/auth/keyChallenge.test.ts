import { describe, expect, it } from 'vitest';

import {
  KeyChallengeAuthRequestSchema,
  createExpectedAccountKeyChallengeSigningInputV1,
} from './keyChallenge.js';

describe('auth/keyChallenge', () => {
  it('strictly parses the additive expected Account login binding', () => {
    const request = {
      publicKey: 'signing-public-key',
      challenge: 'challenge',
      signature: 'signature',
      contentPublicKey: 'content-public-key',
      contentPublicKeySig: 'content-public-key-signature',
      expectedAccountId: 'account-123',
    };

    expect(KeyChallengeAuthRequestSchema.parse(request)).toEqual(request);
    expect(KeyChallengeAuthRequestSchema.safeParse({
      ...request,
      extra: true,
    }).success).toBe(false);
    expect(KeyChallengeAuthRequestSchema.safeParse({
      ...request,
      expectedAccountId: '',
    }).success).toBe(false);
  });

  it('binds both the existing challenge and expected Account id in a domain-separated input', () => {
    const challenge = new Uint8Array([0, 1, 2, 255]);
    const baseline = createExpectedAccountKeyChallengeSigningInputV1({
      challenge,
      expectedAccountId: 'account-123',
    });

    expect(baseline).not.toEqual(challenge);
    expect(
      createExpectedAccountKeyChallengeSigningInputV1({
        challenge: new Uint8Array([0, 1, 3, 255]),
        expectedAccountId: 'account-123',
      }),
    ).not.toEqual(baseline);
    expect(
      createExpectedAccountKeyChallengeSigningInputV1({
        challenge,
        expectedAccountId: 'account-456',
      }),
    ).not.toEqual(baseline);
    expect(
      new TextDecoder().decode(baseline),
    ).toContain('happier.key-challenge.expected-account.v1');
  });
});
