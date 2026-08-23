import { describe, expect, it } from 'vitest';

import {
  KeyChallengeAuthRequestSchema,
  KeyChallengeV2IssueResponseSchema,
  createExpectedAccountKeyChallengeSigningInputV1,
  canonicalizeKeyChallengeV2AudienceOrigin,
  createKeyChallengeV2SigningInput,
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

  it('accepts the strict v2 redemption envelope without a client-chosen nonce', () => {
    const request = {
      challengeId: 'challenge-123',
      publicKey: 'signing-public-key',
      signature: 'signature',
    };

    expect(KeyChallengeAuthRequestSchema.parse(request)).toEqual(request);
    expect(KeyChallengeAuthRequestSchema.safeParse({
      ...request,
      nonce: 'client-controlled-nonce',
    }).success).toBe(false);
  });

  it('uses canonical issue facts in the v2 domain-separated signing input', () => {
    const issue = KeyChallengeV2IssueResponseSchema.parse({
      challengeId: 'challenge-123',
      nonce: 'nonce-abc',
      issuedAt: '2026-08-22T12:00:00.000Z',
      expiresAt: '2026-08-22T12:05:00.000Z',
      audience: {
        origin: 'https://server.example.test',
        serverIdentityId: 'srv_challenge_1',
      },
    });
    const baseline = createKeyChallengeV2SigningInput(issue);

    expect(
      canonicalizeKeyChallengeV2AudienceOrigin(
        'https://server.example.test/api?ignored=1',
      ),
    ).toBe('https://server.example.test');
    expect(
      createKeyChallengeV2SigningInput({
        ...issue,
        audience: {
          ...issue.audience,
          origin: 'https://other.example.test',
        },
      }),
    ).not.toEqual(baseline);
    expect(
      createKeyChallengeV2SigningInput({
        ...issue,
        challengeId: 'challenge-456',
      }),
    ).not.toEqual(baseline);
    expect(
      createKeyChallengeV2SigningInput({
        ...issue,
        expectedAccountId: 'account-123',
      }),
    ).not.toEqual(baseline);
    expect(
      new TextDecoder().decode(baseline),
    ).toContain('happier.key-challenge.v2');
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
