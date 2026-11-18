import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerApiRoutes } from '@/app/api/api';
import { resolveApiRateLimitPluginOptions } from '@/app/api/utils/apiRateLimitPolicy';
import type { Fastify } from '@/app/api/types';

function registerHttpRoutes(app: Fastify) {
  app.register(
    import('@fastify/rate-limit'),
    resolveApiRateLimitPluginOptions(process.env),
  );
  registerApiRoutes(app);
}

describe('Review verdict content envelope', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'review-verdict-envelope-',
      initEncrypt: true,
    });
  }, 180_000);
  afterAll(async () => {
    await harness?.close();
  });

  it('stores sealed prose for an E2EE Review and refuses plaintext prose', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'e2ee' } });
    const reviewId = randomUUID();
    // Persisted boundary fixture: the server never opens E2EE Review bytes on this route.
    await db.artifact.create({
      data: {
        id: reviewId,
        accountId: owner.id,
        header: randomBytes(32),
        body: randomBytes(32),
        dataEncryptionKey: randomBytes(32),
        reviewMetadata: {
          create: {
            subjectKind: 'comparison',
            sourceKind: 'direct',
            state: 'completed',
            currentRoundOrdinal: 1,
            startedAt: new Date(1),
            finishedAt: new Date(2),
          },
        },
      },
    });
    await withAuthenticatedTestApp(registerHttpRoutes, async (app) => {
      const post = (tail: string, payload: unknown) =>
        app.inject({
          method: 'POST',
          url: `/v1/reviews/${reviewId}/${tail}`,
          headers: { 'x-test-user-id': owner.id },
          payload,
        });
      expect(
        (
          await post('reviewers', {
            roundOrdinal: 1,
            reviewers: [
              {
                principal: { kind: 'account', accountId: owner.id },
                required: true,
              },
            ],
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post('verdicts', {
            roundOrdinal: 1,
            verdict: 'approve',
            content: {
              t: 'plain',
              v: {
                reviewId,
                roundOrdinal: 1,
                accountId: owner.id,
                revision: 1,
                body: 'Looks ready',
              },
            },
          })
        ).json(),
      ).toMatchObject({ error: 'review_verdict_encryption_mode_mismatch' });
      const sealed = await post('verdicts', {
        roundOrdinal: 1,
        verdict: 'approve',
        content: { t: 'encrypted', c: 'sealed-prose' },
      });
      expect(sealed.statusCode).toBe(200);
      expect(sealed.json().verdicts).toEqual([
        expect.objectContaining({
          accountId: owner.id,
          revision: 1,
          content: { t: 'encrypted', c: 'sealed-prose' },
        }),
      ]);
    });
  });
});
