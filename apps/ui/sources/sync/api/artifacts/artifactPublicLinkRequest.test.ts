import { describe, expect, it } from 'vitest';

import { createArtifactPublicLinkRequest } from './artifactPublicLinkRequest';

/** The Home's HTTP answer is the network boundary; everything above it is the real transport. */
function refuse(path: string, status: number, body: unknown) {
  const request = createArtifactPublicLinkRequest({
    credentials: { token: 'test-token' },
    request: async () => Response.json(body, { status }),
    assertCurrent: () => undefined,
  });
  return request({ method: 'GET', path }).then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error,
  );
}

const PUBLIC = '/v1/public-shares?subjectKind=artifact&subjectId=a';
const SIGNED_IN = '/v1/artifact-signed-in-links?artifactId=a';

describe('public-link HTTP refusals', () => {
  it.each([
    {
      path: PUBLIC,
      status: 403,
      body: { error: 'Internal detail: replica db-7 refused owner 42' },
    },
    {
      path: PUBLIC,
      status: 400,
      body: { error: 'public_share_forbidden', reason: 'owner moved the link' },
    },
    {
      path: SIGNED_IN,
      status: 409,
      body: { error: 'recipient_key_changed', reason: 'free text' },
    },
  ])(
    'never turn a code outside the closed producer set into the thrown cause ($path $status)',
    async ({ path, status, body }) => {
      const error = await refuse(path, status, body);
      const code =
        path === PUBLIC
          ? 'public_share_request_failed'
          : 'artifact_access_failed';
      expect(error).toMatchObject({ code, message: code });
      expect(error).not.toHaveProperty('reason');
    },
  );

  it('keeps closed producer codes and the recovery each one needs', async () => {
    await expect(
      refuse(SIGNED_IN, 403, { error: 'artifact_access_forbidden' }),
    ).resolves.toMatchObject({ code: 'artifact_access_forbidden' });
    await expect(
      refuse('/v1/artifact-signed-in-links/lookup/join', 409, {
        error: 'recipient_key_unavailable',
        reason: 'plain_account',
      }),
    ).resolves.toMatchObject({
      code: 'recipient_key_unavailable',
      reason: 'plain_account',
    });
    await expect(
      refuse(PUBLIC, 503, {
        error: 'public_share_isolation_unavailable',
        missingPrerequisites: ['x'],
      }),
    ).resolves.toMatchObject({ code: 'public_share_isolation_unavailable' });
    await expect(
      refuse(PUBLIC, 503, { error: 'database_transaction_timeout' }),
    ).resolves.toMatchObject({ code: 'database_transaction_timeout' });
    // An older Home without the signed-in route answers its framework 404.
    await expect(
      refuse(SIGNED_IN, 404, { error: 'Not Found' }),
    ).resolves.toMatchObject({ code: 'artifact_access_unavailable' });
  });
});
