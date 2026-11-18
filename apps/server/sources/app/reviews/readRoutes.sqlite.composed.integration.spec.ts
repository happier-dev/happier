import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ReviewListResponseV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';
import { createAccountServerActionDeps } from '../../../../cli/src/api/accountServerActionDeps';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import type { Fastify as AppFastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { registerReviewReadRoutes } from './readRoutes';

describe('Review read Actions through authenticated HTTP', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    let app: AppFastify;
    let origin: string;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-review-read-actions-', initAuth: true });
        app = Fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        enableAuthentication(app);
        registerReviewReadRoutes(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
        origin = `http://127.0.0.1:${address.port}`;
    }, 180_000);
    afterAll(async () => { await app?.close(); await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('reads only the caller’s demanded metadata page and authorized history (%s)', async encryptionMode => {
        const owner = await db.account.create({ data: { encryptionMode } });
        const outsider = await db.account.create({ data: { encryptionMode } });
        const workflowId = randomUUID();
        const make = async (accountId: string, sequence: number) => {
            const id = randomUUID();
            const at = new Date(sequence * 1000);
            await db.artifact.create({ data: { id, accountId, header: new Uint8Array(), body: new Uint8Array(),
                dataEncryptionKey: new Uint8Array(), createdAt: at, updatedAt: at } });
            await db.reviewMetadata.create({ data: { artifactId: id, workflowId, subjectKind: 'repository',
                sourceKind: 'workflow', state: 'completed', currentRoundOrdinal: 1, startedAt: at } });
            return id;
        };
        const previous = await make(owner.id, 1);
        const current = await make(owner.id, 2);
        const hidden = await make(outsider.id, 3);
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const executor = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
        const context = { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true } as const;
        const first = await executor.execute('reviews.list', { limit: 1, workflowId }, context);
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true, result: { items: [{ reviewId: current, counts: { total: 0, needsDecision: 0 } }], cursor: expect.any(String) } });
        if (!first.ok) throw new Error('Expected owner read');
        const page = ReviewListResponseV1Schema.parse(first.result);
        expect(page.items).toHaveLength(1);
        const second = await executor.execute('reviews.list', { limit: 1, workflowId, cursor: page.cursor }, context);
        expect(second).toMatchObject({ ok: true, result: { items: [{ reviewId: previous }], cursor: null } });
        expect(await executor.execute('review.history.list', { workflowId, reviewId: current }, context))
            .toMatchObject({ ok: true, result: { previousReviewId: previous, items: [] } });
        expect(await executor.execute('review.history.list', { workflowId, reviewId: hidden }, context))
            .toMatchObject({ ok: true, result: { previousReviewId: null, items: [] } });
        const unauthenticated = await app.inject({ method: 'POST', url: '/v1/reviews/list', payload: { limit: 1 } });
        expect(unauthenticated.statusCode).toBe(401);
        const invalid = await app.inject({ method: 'POST', url: '/v1/reviews/list', headers: { authorization: `Bearer ${token}` },
            payload: { limit: 1, actorAccountId: outsider.id } });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toEqual({ error: 'review_comment_invalid_request' });
    });
});
