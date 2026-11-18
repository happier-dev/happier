import { KeyChallengeV2IssueResponseSchema, type KeyChallengeV2IssueResponse } from '@happier-dev/protocol/auth/keyChallenge';

export function keyChallengeV2Fixture(
    overrides: Partial<KeyChallengeV2IssueResponse> = {},
): KeyChallengeV2IssueResponse {
    return KeyChallengeV2IssueResponseSchema.parse({
        challengeId: 'auth-challenge',
        nonce: 'auth-nonce',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        audience: { origin: 'https://home.example.test', serverIdentityId: 'srv_home' },
        ...overrides,
    });
}
